//! The three job kinds, ported from lib/storage/local-jobs.ts and held to
//! its observable behavior: a copy between roots with a hash-verified
//! resume, a send streaming the file into another agent's receive endpoint
//! in one request, and a download shelling out to `hf` — argv only, every
//! argument validated here whatever the caller checked. Events go out as
//! NDJSON through the sender; the client closing the connection is the
//! cancellation, checked wherever the work loops.

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use tokio::io::{AsyncReadExt, AsyncWriteExt, Interest};
use tokio::net::TcpStream;
use tokio_stream::wrappers::ReceiverStream;

use crate::hashing::{sha256_region, HashOutcome};
use crate::ndjson::NdjsonSender;
use crate::refs::Ref;
use crate::storage::LocalStorage;
use crate::wire::{
    CopyResult, DownloadResult, JobEvent, SendTarget, BULK_SPLICE_V1, LENGTH_HEADER, OFFSET_HEADER,
    REF_PATH_HEADER, REF_ROOT_HEADER,
};

/// Progress is reported at most this often, plus once at the end.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// How much a send reads from disk at a time. A send is *one* request whose
/// body streams, so this is the read granularity, not a request size: the
/// far side sees a single append and opens the file once.
const SEND_CHUNK_SIZE: u64 = 8 * 1024 * 1024;

/// Chunks the reader may run ahead of the socket. This is what makes the disk
/// read and the wire overlap instead of alternating; the cost is that much
/// memory in flight per send, and progress that leads the bytes actually on
/// the wire by at most this many chunks.
const SEND_READAHEAD: usize = 2;

/// How much one in-kernel copy call moves at most. Large enough that the
/// syscall count stays trivial (16 calls to the gigabyte), small enough that
/// progress and cancellation still get a look in between them.
const COPY_CHUNK: u64 = 64 * 1024 * 1024;

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
    // Before and not after: the job may run for minutes, and a cached
    // inventory from before it started would outlive its TTL mid-flight.
    storage.invalidate_root(to.root);
    if mv {
        storage.invalidate_root(from.root);
    }
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
        // Deliberately not O_APPEND for a resume: copy_file_range(2) refuses
        // an append-mode target, and the verified prefix already says exactly
        // where to continue from. set_len pins the destination to that prefix
        // so nothing beyond it can survive as a tail.
        let mut writer = if offset > 0 {
            let f = fs::OpenOptions::new()
                .write(true)
                .create(true)
                // Keep what is already there: the prefix was just verified.
                .truncate(false)
                .open(&dst)
                .map_err(|e| e.to_string())?;
            f.set_len(offset).map_err(|e| e.to_string())?;
            f
        } else {
            fs::File::create(&dst).map_err(|e| e.to_string())?
        };
        writer
            .seek(std::io::SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        while done < size {
            if tx.is_closed() {
                return Ok(());
            }
            // std::io::copy over a bounded Take issues copy_file_range(2) on
            // Linux: the bytes move inside the kernel instead of being read
            // into this process and written back out, and on a reflink
            // filesystem (btrfs, XFS) a same-filesystem copy becomes a
            // copy-on-write clone that moves no data at all. std falls back to
            // a userspace loop by itself wherever the syscall isn't available,
            // so this needs no fallback of its own. Bounded per call so
            // progress and cancellation still get a look in between.
            let want = (size - done).min(COPY_CHUNK);
            let n = std::io::copy(&mut Read::by_ref(&mut reader).take(want), &mut writer)
                .map_err(|e| e.to_string())?;
            if n == 0 {
                break; // source ended earlier than its metadata claimed
            }
            done += n;
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
        storage.invalidate_root(from.root);
    }
    storage.invalidate_root(to.root);
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
/// the TS resumeOffset reports, and — as it does too — the two are hashed at
/// once rather than one after the other: they are independent reads, and this
/// pair is the whole cost of deciding whether a partial can be resumed, which
/// a user waits through before any bytes move. None means the client went
/// away.
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
    // Shared across the two readers, so the counter stays one running total
    // and the reports keep their single cadence however the reads interleave.
    let hashed = AtomicU64::new(0);
    let throttle = Mutex::new(Throttle::new());
    let on_bytes = |n: u64| -> bool {
        let done = hashed.fetch_add(n, Ordering::Relaxed) + n;
        let ready = match throttle.lock() {
            Ok(mut t) => t.ready(done == total),
            Err(_) => false,
        };
        if ready {
            return tx.blocking_json(&JobEvent::Verify { done, total });
        }
        !tx.is_closed()
    };
    // The destination on a second thread, the source on this one.
    let (dst_out, src_out) = std::thread::scope(|scope| {
        let dst_task = scope.spawn(|| sha256_region(dst, Some(dst_size), &on_bytes));
        let src_out = sha256_region(src, Some(dst_size), &on_bytes);
        (dst_task.join(), src_out)
    });
    // Judged in the same order as when these ran in sequence, so an unreadable
    // destination still means "start over" rather than surfacing whatever the
    // source's read happened to do.
    let dst_sha = match dst_out {
        Ok(Ok(HashOutcome::Done(sha))) => sha,
        Ok(Ok(HashOutcome::Cancelled)) => return Ok(None),
        Ok(Err(_)) => return Ok(Some(0)), // unreadable partial: start over
        Err(_) => return Err("hashing the destination panicked".to_string()),
    };
    let src_sha = match src_out {
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
    tx.json(&JobEvent::Progress { done, total: size }).await;
    if size == 0 {
        // An empty file still has to exist at the far end.
        post_receive(&client, &to, 0, Vec::new()).await?;
    } else if offset < size {
        // Three paths, best first. The bulk receive is zero-copy at both ends
        // but only exists against an agent that advertises it; the hand-driven
        // request is zero-copy here and works against anything speaking plain
        // http; the streaming client covers whatever is left.
        let endpoint = plain_http_endpoint(&to.agent);
        let bulk = match &endpoint {
            Some(ep) if target_supports_splice(&client, &to).await => Some(ep),
            _ => None,
        };
        let outcome = match bulk {
            Some(ep) => splice_to_receive(ep, &to, &src, offset, size, tx).await,
            None => match sendfile_to_receive(&to, &src, offset, size, tx).await {
                Ok(true) => Ok(()),
                Ok(false) => stream_to_receive(&client, &to, &src, offset, size, tx).await,
                Err(e) => Err(e),
            },
        };
        if let Err(e) = outcome {
            // The client going away aborts the upload mid-body. That is the
            // cancellation, not a failure worth reporting.
            if tx.is_closed() {
                return Ok(());
            }
            return Err(e);
        }
        done = size;
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

/// A plain-http endpoint this job can drive itself: what to connect to, what
/// the Host header should say, and the protocol root path.
struct HttpEndpoint {
    authority: String,
    connect: String,
    path: String,
}

/// Parse `http://host[:port]/path`. None for anything else — a TLS URL, a
/// shape we don't recognise — which simply keeps that send on the portable
/// path. Agents speak plain http on the LAN by design, so this is the norm,
/// not the exception.
fn plain_http_endpoint(url: &str) -> Option<HttpEndpoint> {
    let rest = url.strip_prefix("http://")?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    // An IPv6 literal keeps its brackets, and carries a port only after the
    // closing one — so a bare `[::1]` must not be split on its own colons.
    let has_port = if authority.ends_with(']') {
        false
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) => {
                if host.is_empty() || port.parse::<u16>().is_err() {
                    return None;
                }
                true
            }
            None => false,
        }
    };
    Some(HttpEndpoint {
        authority: authority.to_string(),
        connect: if has_port {
            authority.to_string()
        } else {
            format!("{authority}:80")
        },
        path: path.trim_end_matches('/').to_string(),
    })
}

/// Errors that mean the kernel won't splice this particular pair — an old
/// kernel, a source or socket it can't do — as opposed to the transfer
/// genuinely failing.
fn sendfile_unsupported(e: &std::io::Error) -> bool {
    let code = e.raw_os_error();
    code == Some(rustix::io::Errno::INVAL.raw_os_error())
        || code == Some(rustix::io::Errno::NOSYS.raw_os_error())
        || code == Some(rustix::io::Errno::OPNOTSUPP.raw_os_error())
}

/// Put `src[offset..size]` on an already-connected socket with sendfile(2) —
/// page cache straight to the wire, never through this process. Shared by both
/// paths that drive their own connection.
///
/// If the kernel won't splice this pair the body finishes from userspace on
/// the same socket, so exactly as many bytes go out either way.
async fn write_body_with_sendfile(
    socket: &TcpStream,
    file: &fs::File,
    src: &Path,
    offset: u64,
    size: u64,
    tx: &NdjsonSender,
) -> Result<(), String> {
    let mut at = offset;
    let mut throttle = Throttle::new();
    let mut by_hand = false;
    while at < size {
        if tx.is_closed() {
            return Err("cancelled".to_string());
        }
        let want = (size - at).min(SEND_CHUNK_SIZE) as usize;
        if !by_hand {
            let mut cursor = at;
            let sent = socket
                .async_io(Interest::WRITABLE, || {
                    rustix::fs::sendfile(socket, file, Some(&mut cursor), want)
                        .map_err(|e| std::io::Error::from_raw_os_error(e.raw_os_error()))
                })
                .await;
            match sent {
                Ok(0) => return Err("send: source ended before its size".to_string()),
                Ok(n) => {
                    at += n as u64;
                    if throttle.ready(at == size) {
                        tx.json(&JobEvent::Progress {
                            done: at,
                            total: size,
                        })
                        .await;
                    }
                    continue;
                }
                Err(e) if at == offset && sendfile_unsupported(&e) => by_hand = true,
                Err(e) => return Err(e.to_string()),
            }
        }
        let chunk = tokio::task::spawn_blocking({
            let src = src.to_path_buf();
            move || read_region(&src, at, want)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        let mut written = 0usize;
        while written < chunk.len() {
            socket.writable().await.map_err(|e| e.to_string())?;
            match socket.try_write(&chunk[written..]) {
                Ok(n) => written += n,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
                Err(e) => return Err(e.to_string()),
            }
        }
        at += want as u64;
        if throttle.ready(at == size) {
            tx.json(&JobEvent::Progress {
                done: at,
                total: size,
            })
            .await;
        }
    }
    Ok(())
}

/// Whether the target advertises the bulk receive, asked fresh for each send.
///
/// Deliberately not cached: a stale yes against an agent that has since been
/// rolled back would send it an upgrade request it reads as a zero-length
/// body, truncating the destination. One small GET before a whole file is
/// nothing, and it keeps the guarantee that we only upgrade against a
/// receiver that just said it could.
async fn target_supports_splice(client: &reqwest::Client, to: &SendTarget) -> bool {
    let base = to.agent.trim_end_matches('/');
    let Some(prefix) = base.strip_suffix("/storage") else {
        return false;
    };
    let mut req = client.get(format!("{prefix}/version"));
    if let Some(token) = &to.token {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    let Ok(res) = req.send().await else {
        return false;
    };
    if !res.status().is_success() {
        return false;
    }
    let Ok(body) = res.text().await else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) else {
        return false;
    };
    value["bulk"]
        .as_array()
        .is_some_and(|list| list.iter().any(|v| v.as_str() == Some(BULK_SPLICE_V1)))
}

/// Hand the body over on an upgraded connection, so it is zero-copy at *both*
/// ends: sendfile out of the page cache here, spliced from the socket into the
/// file there, never entering either process.
///
/// Only ever called against a receiver that just advertised the protocol —
/// see `target_supports_splice` for why that check can't be cached. After the
/// 101 there is no HTTP left, so the outcome comes back as a one-line ack.
async fn splice_to_receive(
    ep: &HttpEndpoint,
    to: &SendTarget,
    src: &Path,
    offset: u64,
    size: u64,
    tx: &NdjsonSender,
) -> Result<(), String> {
    let file = fs::File::open(src).map_err(|e| e.to_string())?;
    let mut head = format!(
        "POST {}/receive HTTP/1.1\r\nHost: {}\r\n",
        ep.path, ep.authority
    );
    if let Some(token) = &to.token {
        head.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    head.push_str(&format!(
        "{REF_ROOT_HEADER}: {}\r\n",
        to.target.root.as_str()
    ));
    head.push_str(&format!(
        "{REF_PATH_HEADER}: {}\r\n",
        encode_uri_component(&to.target.path)
    ));
    head.push_str(&format!("{OFFSET_HEADER}: {offset}\r\n"));
    head.push_str(&format!("{LENGTH_HEADER}: {}\r\n", size - offset));
    // The bytes follow the 101, not this request, so it carries no body.
    head.push_str("Content-Length: 0\r\n");
    head.push_str("Connection: Upgrade\r\n");
    head.push_str(&format!("Upgrade: {BULK_SPLICE_V1}\r\n\r\n"));

    let mut socket = TcpStream::connect(&ep.connect)
        .await
        .map_err(|e| format!("connect {}: {e}", ep.connect))?;
    socket
        .write_all(head.as_bytes())
        .await
        .map_err(|e| e.to_string())?;

    // Nothing may be sent until the 101 lands: anything else means the far
    // side read this as an ordinary request, and the body must not follow.
    let (status, _) = read_head(&mut socket).await?;
    if status != 101 {
        return Err(format!("bulk receive refused: HTTP {status}"));
    }

    write_body_with_sendfile(&socket, &file, src, offset, size, tx).await?;

    // The ack, which after an upgrade is the only channel left for a verdict.
    let mut ack = Vec::new();
    let mut byte = [0u8; 1];
    while !ack.ends_with(b"\n") && ack.len() < 4096 {
        match socket.read(&mut byte).await {
            Ok(0) => break,
            Ok(_) => ack.push(byte[0]),
            Err(e) => return Err(format!("bulk receive: {e}")),
        }
    }
    let ack = String::from_utf8_lossy(&ack).trim().to_string();
    match ack.strip_prefix("TJ-OK ") {
        Some(n) if n.trim().parse::<u64>() == Ok(size - offset) => Ok(()),
        _ if ack.is_empty() => Err("bulk receive: no acknowledgement".to_string()),
        _ => Err(ack
            .strip_prefix("TJ-ERR ")
            .map(|m| format!("bulk receive: {m}"))
            .unwrap_or_else(|| format!("bulk receive: unexpected acknowledgement {ack:?}"))),
    }
}

/// Stream `src[offset..size]` to the target's receive endpoint over a
/// connection this job drives itself, so the body can leave with sendfile(2):
/// the bytes go from the page cache to the socket without ever being copied
/// through this process.
///
/// It is an ordinary HTTP/1.1 request — the same endpoint, headers and bearer
/// token the portable path sends, written by hand only so the body can be
/// handed to the kernel — which is why an agent and a peer running the whole
/// app both answer it unchanged.
///
/// `Ok(false)` means the target isn't a plain-http endpoint this can drive and
/// the caller should take the portable path. Once the request is on the wire
/// every outcome is this function's to report.
async fn sendfile_to_receive(
    to: &SendTarget,
    src: &Path,
    offset: u64,
    size: u64,
    tx: &NdjsonSender,
) -> Result<bool, String> {
    let Some(ep) = plain_http_endpoint(&to.agent) else {
        return Ok(false);
    };
    let file = fs::File::open(src).map_err(|e| e.to_string())?;

    let mut head = format!(
        "POST {}/receive HTTP/1.1\r\nHost: {}\r\n",
        ep.path, ep.authority
    );
    if let Some(token) = &to.token {
        head.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    head.push_str("Content-Type: application/octet-stream\r\n");
    head.push_str(&format!(
        "{REF_ROOT_HEADER}: {}\r\n",
        to.target.root.as_str()
    ));
    head.push_str(&format!(
        "{REF_PATH_HEADER}: {}\r\n",
        encode_uri_component(&to.target.path)
    ));
    head.push_str(&format!("{OFFSET_HEADER}: {offset}\r\n"));
    head.push_str(&format!("Content-Length: {}\r\n", size - offset));
    // One request per connection, so the response is simply everything up to
    // EOF and there is no keep-alive state to get wrong.
    head.push_str("Connection: close\r\n\r\n");

    let mut socket = TcpStream::connect(&ep.connect)
        .await
        .map_err(|e| format!("connect {}: {e}", ep.connect))?;
    socket
        .write_all(head.as_bytes())
        .await
        .map_err(|e| e.to_string())?;

    write_body_with_sendfile(&socket, &file, src, offset, size, tx).await?;

    let (status, leftover) = read_head(&mut socket).await?;
    if (200..300).contains(&status) {
        return Ok(true);
    }
    Err(read_error_body(&mut socket, status, leftover).await)
}

/// Read one HTTP response head off the socket, returning its status and
/// whatever was read past the blank line.
///
/// Deliberately not "read to EOF": a server that keeps the connection alive
/// regardless of the `Connection: close` we asked for would hang that forever,
/// which is exactly what a keep-alive receiver did.
async fn read_head(socket: &mut TcpStream) -> Result<(u16, HeadRest), String> {
    let mut resp = Vec::new();
    let mut chunk = [0u8; 2048];
    let head_end = loop {
        if let Some(i) = resp
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|i| i + 4)
        {
            break i;
        }
        let n = socket
            .read(&mut chunk)
            .await
            .map_err(|e| format!("receive: {e}"))?;
        if n == 0 {
            return Err("receive: connection closed before a response".to_string());
        }
        resp.extend_from_slice(&chunk[..n]);
        if resp.len() > 64 * 1024 {
            return Err("receive: response head too large".to_string());
        }
    };
    let head = String::from_utf8_lossy(&resp[..head_end]).into_owned();
    let status = head
        .split_once("\r\n")
        .and_then(|(line, _)| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| "receive: unreadable response".to_string())?;
    let rest = resp.split_off(head_end);
    // Content-Length rides along so the error body is read to a known end,
    // never waiting on bytes that aren't coming.
    let declared = head
        .lines()
        .find_map(|l| {
            l.split_once(':')
                .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        })
        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        .unwrap_or(0)
        .min(8 * 1024);
    Ok((status, HeadRest { rest, declared }))
}

/// What followed a response head: the bytes already in hand, and how many the
/// response said there would be.
struct HeadRest {
    rest: Vec<u8>,
    declared: usize,
}

/// The far side's own message for a failed request — the useful error — read
/// only up to the length it declared, so this can't block on a kept-alive
/// connection that has nothing more to send.
async fn read_error_body(socket: &mut TcpStream, status: u16, head: HeadRest) -> String {
    let HeadRest { mut rest, declared } = head;
    let mut chunk = [0u8; 2048];
    while rest.len() < declared {
        match socket.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => rest.extend_from_slice(&chunk[..n]),
        }
    }
    let message = String::from_utf8_lossy(&rest).trim().to_string();
    if message.is_empty() {
        format!("receive: HTTP {status}")
    } else {
        message
    }
}

/// Stream `src[offset..size]` to the target agent as one request body.
///
/// A reader task fills a bounded channel while the request drains it, so the
/// disk read overlaps the wire instead of taking turns with it — and the far
/// side opens, seeks and appends once for the whole file rather than once per
/// chunk. Progress is reported by the reader, so it leads the socket by at
/// most `SEND_READAHEAD` chunks.
///
/// Any early end has to abort the request rather than close the body cleanly:
/// a short body looks to the receiver like a complete file, and it would
/// commit the truncated bytes as one.
async fn stream_to_receive(
    client: &reqwest::Client,
    to: &SendTarget,
    src: &Path,
    offset: u64,
    size: u64,
    tx: &NdjsonSender,
) -> Result<(), String> {
    let (chunk_tx, chunk_rx) = tokio::sync::mpsc::channel::<std::io::Result<Bytes>>(SEND_READAHEAD);
    let src_path = src.to_path_buf();
    let reader_tx = tx.clone();
    let reader = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let mut at = offset;
        let mut throttle = Throttle::new();
        while at < size {
            if reader_tx.is_closed() {
                let _ = chunk_tx.blocking_send(Err(std::io::Error::other("cancelled")));
                return Ok(());
            }
            let len = SEND_CHUNK_SIZE.min(size - at) as usize;
            let chunk = match read_region(&src_path, at, len) {
                Ok(chunk) => chunk,
                Err(e) => {
                    let _ = chunk_tx.blocking_send(Err(std::io::Error::other(e.to_string())));
                    return Err(e);
                }
            };
            at += len as u64;
            // A closed channel means the request is already gone; its own
            // error is the one worth reporting, so end quietly.
            if chunk_tx.blocking_send(Ok(Bytes::from(chunk))).is_err() {
                return Ok(());
            }
            if throttle.ready(at == size) {
                reader_tx.blocking_json(&JobEvent::Progress {
                    done: at,
                    total: size,
                });
            }
        }
        Ok(())
    });

    let body = reqwest::Body::wrap_stream(ReceiverStream::new(chunk_rx));
    let sent = post_receive(client, to, offset, body).await;
    // A failed read aborts the body, which surfaces at the request as a
    // generic stream error — so the read's own error is the root cause.
    match reader.await {
        Ok(Ok(())) => sent,
        Ok(Err(e)) => Err(e.to_string()),
        Err(e) => Err(e.to_string()),
    }
}

async fn post_receive(
    client: &reqwest::Client,
    to: &SendTarget,
    offset: u64,
    body: impl Into<reqwest::Body>,
) -> Result<(), String> {
    let res = agent_post(client, to, "receive")
        .header("content-type", "application/octet-stream")
        .header(REF_ROOT_HEADER, to.target.root.as_str())
        .header(REF_PATH_HEADER, encode_uri_component(&to.target.path))
        .header(OFFSET_HEADER, offset.to_string())
        .body(body)
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
    storage.invalidate_root(into.root);

    // hf reads HF_TOKEN from the environment, which the child inherits (the unit
    // loads it from agent.env). If this box has none, gated or private repos
    // 401 — say so up front, flush-left, so the app lifts it into the download
    // dialog's notices the same way it lifts hf's own stderr warnings.
    if std::env::var("HF_TOKEN")
        .map(|v| v.trim().is_empty())
        .unwrap_or(true)
    {
        tx.json(&JobEvent::Log {
            line: "HF_TOKEN is not set — gated or private repositories may fail to download.\n"
                .to_string(),
        })
        .await;
    }

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
    // The files landed while any pre-spawn inventory could still be fresh.
    storage.invalidate_root(into.root);
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
