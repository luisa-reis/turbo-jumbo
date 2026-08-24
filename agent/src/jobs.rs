//! The three job kinds, ported from lib/storage/local-jobs.ts and held to
//! its observable behavior: a copy between roots with a hash-verified
//! resume, a send streaming 8 MiB chunks into another agent's receive
//! endpoint, and a download shelling out to `hf` — argv only, every
//! argument validated here whatever the caller checked. Events go out as
//! NDJSON through the sender; the client closing the connection is the
//! cancellation, checked wherever the work loops.

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::hashing::{sha256_region, HashOutcome};
use crate::ndjson::NdjsonSender;
use crate::refs::Ref;
use crate::storage::LocalStorage;
use crate::wire::{
    CopyResult, DownloadResult, JobEvent, SendTarget, OFFSET_HEADER, REF_PATH_HEADER,
    REF_ROOT_HEADER,
};

/// Progress is reported at most this often, plus once at the end.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// A send travels in bounded chunks, one request each.
const SEND_CHUNK_SIZE: u64 = 8 * 1024 * 1024;

const COPY_CHUNK: usize = 64 * 1024;

struct Throttle {
    last: Option<Instant>,
}

impl Throttle {
    fn new() -> Self {
        Throttle { last: None }
    }

    fn ready(&mut self, force: bool) -> bool {
        let now = Instant::now();
        if !force
            && self
                .last
                .is_some_and(|last| now.duration_since(last) < PROGRESS_INTERVAL)
        {
            return false;
        }
        self.last = Some(now);
        true
    }
}

fn error_event(tx: &NdjsonSender, message: impl Into<String>) {
    tx.blocking_json(&JobEvent::Error {
        message: message.into(),
    });
}

// ---------------------------------------------------------------- copy ----

/// Blocking; run under spawn_blocking. Resume-aware copy between roots,
/// optionally a move — a rename when the roots share a filesystem.
pub fn run_copy_job(storage: &LocalStorage, from: &Ref, to: &Ref, mv: bool, tx: &NdjsonSender) {
    if let Err(e) = copy_job(storage, from, to, mv, tx) {
        error_event(tx, e);
    }
}

fn copy_job(
    storage: &LocalStorage,
    from: &Ref,
    to: &Ref,
    mv: bool,
    tx: &NdjsonSender,
) -> Result<(), String> {
    let src = storage.resolve(from).map_err(|e| e.message)?;
    let dst = storage.resolve(to).map_err(|e| e.message)?;
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if mv {
        match fs::rename(&src, &dst) {
            Ok(()) => {
                let stop = storage.root_dir(from.root).map_err(|e| e.message)?;
                crate::prune::prune_empty_dirs(&src, stop).map_err(|e| e.to_string())?;
                let size = fs::metadata(&dst).map_err(|e| e.to_string())?.len();
                tx.blocking_json(&JobEvent::Progress {
                    done: size,
                    total: size,
                });
                tx.blocking_json(&JobEvent::Done {
                    result: serde_json::to_value(CopyResult {
                        resumed_from: size,
                        size,
                    })
                    .unwrap_or_default(),
                });
                return Ok(());
            }
            Err(e) if e.raw_os_error() == Some(18) => {} // EXDEV: stream it
            Err(e) => return Err(e.to_string()),
        }
    }
    let size = fs::metadata(&src).map_err(|e| e.to_string())?.len();
    let Some(offset) = resume_offset(&src, &dst, size, tx)? else {
        return Ok(()); // client gone mid-verify
    };
    let mut done = offset;
    let mut throttle = Throttle::new();
    let report = |done: u64, force: bool, throttle: &mut Throttle| {
        if throttle.ready(force) {
            tx.blocking_json(&JobEvent::Progress { done, total: size });
        }
    };
    report(done, true, &mut throttle);
    // Skip the stream only when a resume found the destination already
    // complete; offset 0 always streams, so an empty source still creates
    // its destination.
    if offset == 0 || offset < size {
        use std::io::{Read, Seek, Write};
        let mut reader = fs::File::open(&src).map_err(|e| e.to_string())?;
        reader
            .seek(std::io::SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut writer = if offset > 0 {
            fs::OpenOptions::new().append(true).open(&dst)
        } else {
            fs::File::create(&dst)
        }
        .map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; COPY_CHUNK];
        loop {
            if tx.is_closed() {
                return Ok(());
            }
            let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            writer.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            done += n as u64;
            report(done, false, &mut throttle);
        }
        writer.flush().map_err(|e| e.to_string())?;
    }
    report(done, true, &mut throttle);
    if mv {
        match fs::remove_file(&src) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            other => other.map_err(|e| e.to_string())?,
        }
        let stop = storage.root_dir(from.root).map_err(|e| e.message)?;
        crate::prune::prune_empty_dirs(&src, stop).map_err(|e| e.to_string())?;
    }
    tx.blocking_json(&JobEvent::Done {
        result: serde_json::to_value(CopyResult {
            resumed_from: offset,
            size,
        })
        .unwrap_or_default(),
    });
    Ok(())
}

/// Where a copy of `src` to `dst` may resume: the destination's bytes count
/// only when hashing them matches the source's same-length region. Both
/// regions' bytes feed one verify counter (total = twice the partial), as
/// the TS resumeOffset reports — hashed here in sequence where the TS side
/// overlapped them, which changes wall-clock, never the answer. None means
/// the client went away.
fn resume_offset(
    src: &Path,
    dst: &Path,
    src_size: u64,
    tx: &NdjsonSender,
) -> Result<Option<u64>, String> {
    let dst_size = match fs::metadata(dst) {
        Ok(m) => m.len(),
        Err(_) => return Ok(Some(0)),
    };
    if dst_size == 0 || dst_size > src_size {
        return Ok(Some(0));
    }
    let total = dst_size * 2;
    let mut hashed = 0u64;
    let mut throttle = Throttle::new();
    let mut on_bytes = |n: u64, tx: &NdjsonSender| {
        hashed += n;
        if throttle.ready(hashed == total) {
            return tx.blocking_json(&JobEvent::Verify {
                done: hashed,
                total,
            });
        }
        !tx.is_closed()
    };
    let dst_sha = match sha256_region(dst, Some(dst_size), |n| on_bytes(n, tx)) {
        Ok(HashOutcome::Done(sha)) => sha,
        Ok(HashOutcome::Cancelled) => return Ok(None),
        Err(_) => return Ok(Some(0)), // unreadable partial: start over
    };
    let src_sha = match sha256_region(src, Some(dst_size), |n| on_bytes(n, tx)) {
        Ok(HashOutcome::Done(sha)) => sha,
        Ok(HashOutcome::Cancelled) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    Ok(Some(if dst_sha == src_sha { dst_size } else { 0 }))
}

// ---------------------------------------------------------------- send ----

/// Async: streams the file to the target agent's receive endpoint, resuming
/// from whatever verified prefix the far side already holds.
pub async fn run_send_job(storage: Arc<LocalStorage>, from: Ref, to: SendTarget, tx: NdjsonSender) {
    if let Err(e) = send_job(storage, from, to, &tx).await {
        tx.json(&JobEvent::Error { message: e }).await;
    }
}

async fn send_job(
    storage: Arc<LocalStorage>,
    from: Ref,
    to: SendTarget,
    tx: &NdjsonSender,
) -> Result<(), String> {
    let src = storage.resolve(&from).map_err(|e| e.message)?;
    let size = tokio::fs::metadata(&src)
        .await
        .map_err(|e| e.to_string())?
        .len();
    let client = reqwest::Client::new();

    let Some(offset) = send_resume_offset(&client, &to, &src, size, tx).await? else {
        return Ok(()); // client gone mid-verify
    };

    let mut done = offset;
    let mut throttle = Throttle::new();
    if throttle.ready(true) {
        tx.json(&JobEvent::Progress { done, total: size }).await;
    }
    if size == 0 {
        // An empty file still has to exist at the far end.
        post_receive(&client, &to, 0, Vec::new()).await?;
    }
    let mut at = offset;
    while at < size {
        if tx.is_closed() {
            return Ok(());
        }
        let chunk_end = (at + SEND_CHUNK_SIZE).min(size);
        let src_chunk = src.clone();
        let chunk = tokio::task::spawn_blocking(move || {
            read_region(&src_chunk, at, (chunk_end - at) as usize)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        post_receive(&client, &to, at, chunk).await?;
        at = chunk_end;
        done = chunk_end;
        if throttle.ready(false) {
            tx.json(&JobEvent::Progress { done, total: size }).await;
        }
    }
    tx.json(&JobEvent::Progress { done, total: size }).await;
    tx.json(&JobEvent::Done {
        result: serde_json::to_value(CopyResult {
            resumed_from: offset,
            size,
        })
        .unwrap_or_default(),
    })
    .await;
    Ok(())
}

fn read_region(path: &Path, offset: u64, len: usize) -> std::io::Result<Vec<u8>> {
    use std::os::unix::fs::FileExt;
    let file = fs::File::open(path)?;
    let mut buf = vec![0u8; len];
    file.read_exact_at(&mut buf, offset)?;
    Ok(buf)
}

/// The peer-upload resume, aimed at an agent: the far side's partial counts
/// only when its own hash of those bytes (the hash op, over the wire)
/// matches the source's same-length region. Verify events cover the source
/// side only — the far side hashes concurrently and out of sight. None
/// means the client went away.
async fn send_resume_offset(
    client: &reqwest::Client,
    to: &SendTarget,
    src: &Path,
    src_size: u64,
    tx: &NdjsonSender,
) -> Result<Option<u64>, String> {
    let dest_size = match remote_file_size(client, to).await? {
        Some(size) if size > 0 && size <= src_size => size,
        _ => return Ok(Some(0)),
    };

    let src_path = src.to_path_buf();
    let verify_tx = tx.clone();
    let src_task = tokio::task::spawn_blocking(move || {
        let mut hashed = 0u64;
        let mut throttle = Throttle::new();
        sha256_region(&src_path, Some(dest_size), |n| {
            hashed += n;
            if throttle.ready(hashed == dest_size) {
                return verify_tx.blocking_json(&JobEvent::Verify {
                    done: hashed,
                    total: dest_size,
                });
            }
            !verify_tx.is_closed()
        })
    });
    let dest_sha = remote_hash(client, to).await;
    let src_out = src_task.await.map_err(|e| e.to_string())?;
    let src_sha = match src_out {
        Ok(HashOutcome::Done(sha)) => Some(sha),
        Ok(HashOutcome::Cancelled) => return Ok(None),
        Err(_) => None, // unreadable source or region: send everything
    };
    Ok(Some(match (dest_sha, src_sha) {
        (Some(d), Some(s)) if d == s => dest_size,
        _ => 0,
    }))
}

/// The far side's byte count for the target path, from one inventory of its
/// parent directory — fileSize over the wire. A directory or dangling link
/// is no file; a missing directory is an empty answer. Errors are the
/// job's: a dead target agent fails the send, as it does in TS.
async fn remote_file_size(
    client: &reqwest::Client,
    to: &SendTarget,
) -> Result<Option<u64>, String> {
    let parent = to.target.path.rsplit_once('/').map(|(dir, _)| dir);
    let mut body = serde_json::json!({"root": to.target.root});
    if let Some(dir) = parent {
        body["under"] = serde_json::Value::String(dir.to_string());
    }
    let res = agent_post(client, to, "list")
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(res.text().await.unwrap_or_else(|_| "list failed".into()));
    }
    let raw = res.text().await.map_err(|e| e.to_string())?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let entry = parsed["entries"]
        .as_array()
        .and_then(|entries| {
            entries
                .iter()
                .find(|e| e["path"] == to.target.path.as_str())
        })
        .cloned();
    Ok(entry.and_then(|e| {
        if e["kind"] == "dir" || e["dangling"] == true {
            return None;
        }
        e["size"].as_u64()
    }))
}

/// The far side's digest of what it holds at the target — its whole partial
/// file, which is exactly the region a resume compares. None on any
/// failure: an undecidable partial is resent, never trusted.
async fn remote_hash(client: &reqwest::Client, to: &SendTarget) -> Option<String> {
    let body = serde_json::json!({
        "root": to.target.root,
        "path": to.target.path,
    });
    let res = agent_post(client, to, "hash")
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    // NDJSON frames: cumulative counts, then the digest or a failure.
    use tokio_stream::StreamExt;
    let mut stream = res.bytes_stream();
    let mut buf = String::new();
    let mut sha: Option<String> = None;
    while let Some(chunk) = stream.next().await {
        buf.push_str(&String::from_utf8_lossy(&chunk.ok()?));
        while let Some(newline) = buf.find('\n') {
            let line: String = buf.drain(..=newline).collect();
            let frame: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
            if let Some(digest) = frame["sha256"].as_str() {
                sha = Some(digest.to_string());
            } else if frame["error"].is_string() {
                return None;
            }
        }
    }
    sha
}

fn agent_post(client: &reqwest::Client, to: &SendTarget, op: &str) -> reqwest::RequestBuilder {
    let base = to.agent.trim_end_matches('/');
    let mut req = client.post(format!("{base}/{op}"));
    if let Some(token) = &to.token {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    req
}

async fn post_receive(
    client: &reqwest::Client,
    to: &SendTarget,
    offset: u64,
    chunk: Vec<u8>,
) -> Result<(), String> {
    let res = agent_post(client, to, "receive")
        .header("content-type", "application/octet-stream")
        .header(REF_ROOT_HEADER, to.target.root.as_str())
        .header(REF_PATH_HEADER, encode_uri_component(&to.target.path))
        .header(OFFSET_HEADER, offset.to_string())
        .body(chunk)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(if text.is_empty() {
            format!("receive: HTTP {status}")
        } else {
            text
        });
    }
    Ok(())
}

/// encodeURIComponent: everything percent-encoded except JS's unreserved
/// set, so the header value survives any byte a filename can carry.
fn encode_uri_component(s: &str) -> String {
    const KEEP: &[u8] = b"-_.!~*'()";
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || KEEP.contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

// ------------------------------------------------------------ download ----

/// Async: run `hf download`. The arguments are validated here, whatever the
/// caller checked — an argv array with no shell is the whole of what runs.
pub async fn run_download_job(
    storage: Arc<LocalStorage>,
    repo_id: String,
    revision: Option<String>,
    files: Vec<String>,
    into: Ref,
    tx: NdjsonSender,
) {
    let revision = revision.unwrap_or_else(|| "main".to_string());
    let invalid = if !is_valid_repo_id(&repo_id) {
        Some(format!("invalid repoId: {repo_id}"))
    } else if !is_valid_revision(&revision) {
        Some(format!("invalid revision: {revision}"))
    } else {
        files
            .iter()
            .find(|f| !is_valid_file_path(f))
            .map(|f| format!("invalid file path: {f}"))
    };
    if let Some(message) = invalid {
        tx.json(&JobEvent::Error { message }).await;
        return;
    }
    let dir = match storage.resolve(&into) {
        Ok(dir) => dir,
        Err(e) => {
            tx.json(&JobEvent::Error { message: e.message }).await;
            return;
        }
    };

    let mut cmd = tokio::process::Command::new("hf");
    cmd.arg("download").arg(&repo_id);
    for f in &files {
        cmd.arg("--include").arg(f);
    }
    cmd.arg("--local-dir")
        .arg(&dir)
        .arg("--revision")
        .arg(&revision)
        .arg("--json")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            tx.json(&JobEvent::Error {
                message: e.to_string(),
            })
            .await;
            return;
        }
    };
    let pid = child.id();
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    // stderr chunks become log events, ANSI-stripped, as they arrive.
    let log_tx = tx.clone();
    let stderr_task = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let Some(stderr) = stderr.as_mut() else {
            return;
        };
        let mut buf = vec![0u8; 8192];
        loop {
            match stderr.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let text = strip_ansi(&String::from_utf8_lossy(&buf[..n]));
                    if !text.is_empty() {
                        log_tx.json(&JobEvent::Log { line: text }).await;
                    }
                }
            }
        }
    });
    let stdout_task = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut output = String::new();
        if let Some(stdout) = stdout.as_mut() {
            let mut raw = Vec::new();
            let _ = stdout.read_to_end(&mut raw).await;
            output = String::from_utf8_lossy(&raw).into_owned();
        }
        output
    });

    // The connection is the cancellation: when the client goes, SIGTERM the
    // tool — the TS agent's cancel, by other plumbing.
    let status = loop {
        tokio::select! {
            status = child.wait() => break status,
            () = tokio::time::sleep(PROGRESS_INTERVAL) => {
                if tx.is_closed() {
                    if let Some(pid) = pid {
                        let _ = rustix::process::kill_process(
                            rustix::process::Pid::from_raw(pid as i32)
                                .expect("child pid is nonzero"),
                            rustix::process::Signal::TERM,
                        );
                    }
                }
            }
        }
    };
    let _ = stderr_task.await;
    let output = stdout_task.await.unwrap_or_default();
    match status {
        Ok(status) => {
            use std::os::unix::process::ExitStatusExt;
            let result = DownloadResult {
                exit_code: status.code(),
                signal: status.signal().map(signal_name),
                output,
            };
            tx.json(&JobEvent::Done {
                result: serde_json::to_value(result).unwrap_or_default(),
            })
            .await;
        }
        Err(e) => {
            tx.json(&JobEvent::Error {
                message: e.to_string(),
            })
            .await;
        }
    }
}

fn signal_name(n: i32) -> String {
    match n {
        1 => "SIGHUP".into(),
        2 => "SIGINT".into(),
        3 => "SIGQUIT".into(),
        6 => "SIGABRT".into(),
        9 => "SIGKILL".into(),
        11 => "SIGSEGV".into(),
        13 => "SIGPIPE".into(),
        15 => "SIGTERM".into(),
        other => format!("SIG{other}"),
    }
}

// The download-request shapes from lib/hf/download-request.ts: what a
// request must look like before anything turns it into paths or an argv.

fn has_unsafe_segment(p: &str) -> bool {
    p.split('/').any(|seg| seg == "..")
}

fn is_repo_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')
}

pub fn is_valid_repo_id(v: &str) -> bool {
    let Some((org, repo)) = v.split_once('/') else {
        return false;
    };
    !org.is_empty()
        && !repo.is_empty()
        && !repo.contains('/')
        && org.chars().all(is_repo_char)
        && repo.chars().all(is_repo_char)
        && !has_unsafe_segment(v)
}

pub fn is_valid_revision(v: &str) -> bool {
    !v.is_empty()
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-'))
}

pub fn is_valid_file_path(v: &str) -> bool {
    !v.is_empty()
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ' ' | '/' | '-'))
        && !has_unsafe_segment(v)
}

/// The TS ANSI regex, as a scanner: ESC then a CSI run, an OSC run to BEL,
/// or any single character.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            Some('[') => {
                chars.next();
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next();
                for c in chars.by_ref() {
                    if c == '\u{7}' {
                        break;
                    }
                }
            }
            Some(_) => {
                chars.next();
            }
            None => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validators_mirror_the_ts_shapes() {
        assert!(is_valid_repo_id("org/repo-name_1.5"));
        for bad in ["../etc", "org", "org/re/po", "org/", "/repo", "org/re po"] {
            assert!(!is_valid_repo_id(bad), "{bad}");
        }
        assert!(is_valid_revision("refs/pr/1"));
        assert!(!is_valid_revision("a;b"));
        assert!(is_valid_file_path("sub dir/model-Q4_K_M.gguf"));
        assert!(!is_valid_file_path("a/../b"));
        assert!(!is_valid_file_path(""));
    }

    #[test]
    fn ansi_stripping_removes_the_usual_noise() {
        assert_eq!(strip_ansi("\u{1b}[1;32mok\u{1b}[0m done"), "ok done");
        assert_eq!(strip_ansi("\u{1b}]0;title\u{7}rest"), "rest");
        assert_eq!(strip_ansi("plain"), "plain");
    }

    #[test]
    fn uri_component_encoding_matches_js() {
        assert_eq!(
            encode_uri_component("org/repo w.gguf"),
            "org%2Frepo%20w.gguf"
        );
        assert_eq!(encode_uri_component("a-b_c.d!e"), "a-b_c.d!e");
    }
}
