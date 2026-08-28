//! The op handlers: parse the wire, call the blocking storage core through
//! spawn_blocking, answer with the TS handlers' exact statuses and
//! messages. Shape validation only — confinement is the storage's own.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use bytes::Bytes;
use serde_json::{json, Value};
use tokio_stream::StreamExt;

use crate::error::AgentError;
use crate::refs::{Ref, Root};
use crate::storage::LocalStorage;
use crate::wire::{FileEntry, ListOptions, MAX_SMALL_FILE, REF_PATH_HEADER, REF_ROOT_HEADER};

/// Body chunks a receive may hold between the socket and the disk. Bounded so
/// a slow disk pushes back on the wire instead of queueing the file in memory.
const RECEIVE_QUEUE: usize = 8;

pub fn bad(what: &str) -> AgentError {
    AgentError::bad_request(format!("Invalid {what}"))
}

fn parse_json(body: &Bytes) -> Result<Value, AgentError> {
    serde_json::from_slice(body).map_err(|_| AgentError::bad_request("Invalid JSON"))
}

fn parse_root(v: Option<&Value>) -> Option<Root> {
    v.and_then(|v| v.as_str()).and_then(Root::parse)
}

/// Mirror of the TS `isRef` + rebuild: a valid root, a string path, extra
/// properties left behind.
pub fn parse_ref(v: &Value) -> Option<Ref> {
    let obj = v.as_object()?;
    Some(Ref {
        root: parse_root(obj.get("root"))?,
        path: obj.get("path")?.as_str()?.to_string(),
    })
}

/// JS truthiness for option flags, as the TS handler applies it.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn ok_json() -> Response {
    Json(json!({"ok": true})).into_response()
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, AgentError> + Send + 'static,
) -> Result<T, AgentError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AgentError::internal(format!("task failed: {e}")))?
}

pub async fn list(storage: Arc<LocalStorage>, body: Bytes) -> Result<Response, AgentError> {
    let value = parse_json(&body)?;
    let obj = value.as_object().ok_or_else(|| bad("root"))?;
    let root = parse_root(obj.get("root")).ok_or_else(|| bad("root"))?;
    let under = match obj.get("under") {
        None => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return Err(bad("under")),
    };
    let opts = ListOptions {
        dtype: truthy(obj.get("dtype")),
        strict: truthy(obj.get("strict")),
    };
    let entries: Vec<FileEntry> =
        blocking(move || storage.list(root, under.as_deref(), opts)).await?;
    Ok(Json(json!({"entries": entries})).into_response())
}

pub async fn read(storage: Arc<LocalStorage>, body: Bytes) -> Result<Response, AgentError> {
    let value = parse_json(&body)?;
    let r = parse_ref(&value).ok_or_else(|| bad("ref"))?;
    let bytes = blocking(move || storage.read(&r)).await?;
    Ok((
        [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
        bytes,
    )
        .into_response())
}

/// The write ref, from its headers: the root by name, the path URI-encoded.
pub fn header_ref(headers: &HeaderMap) -> Result<Ref, AgentError> {
    let root = headers
        .get(REF_ROOT_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(Root::parse)
        .ok_or_else(|| bad("ref headers"))?;
    let raw = headers
        .get(REF_PATH_HEADER)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| bad("ref headers"))?;
    let path = decode_uri_component(raw).ok_or_else(|| bad("ref headers"))?;
    Ok(Ref { root, path })
}

/// decodeURIComponent, the parts of it a path needs: %XX byte sequences
/// decoded, the result required to be UTF-8. None on malformed input, as
/// the JS one throws.
fn decode_uri_component(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let hex = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Collect a request body, refusing past the cap before the bytes pile up
/// in memory — the interface's promise, kept mid-stream.
pub async fn collect_capped(body: Body, cap: u64) -> Result<Option<Vec<u8>>, AgentError> {
    let mut out: Vec<u8> = Vec::new();
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AgentError::internal(format!("body read: {e}")))?;
        if out.len() as u64 + chunk.len() as u64 > cap {
            return Ok(None);
        }
        out.extend_from_slice(&chunk);
    }
    Ok(Some(out))
}

pub async fn write(
    storage: Arc<LocalStorage>,
    headers: &HeaderMap,
    body: Body,
) -> Result<Response, AgentError> {
    let r = header_ref(headers)?;
    let Some(bytes) = collect_capped(body, MAX_SMALL_FILE).await? else {
        return Err(AgentError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            message: format!(
                "{} is over {} bytes; write is for small files only",
                r.path, MAX_SMALL_FILE
            ),
            code: None,
        });
    };
    blocking(move || storage.write(&r, &bytes)).await?;
    Ok(ok_json())
}

pub async fn mkdir(storage: Arc<LocalStorage>, body: Bytes) -> Result<Response, AgentError> {
    let value = parse_json(&body)?;
    let r = parse_ref(&value).ok_or_else(|| bad("ref"))?;
    blocking(move || storage.mkdir(&r)).await?;
    Ok(ok_json())
}

pub async fn usage(storage: Arc<LocalStorage>, body: Bytes) -> Result<Response, AgentError> {
    let value = parse_json(&body)?;
    let obj = value.as_object().ok_or_else(|| bad("root"))?;
    let root = parse_root(obj.get("root")).ok_or_else(|| bad("root"))?;
    let usage = blocking(move || storage.usage(root)).await?;
    Ok(Json(usage).into_response())
}

pub async fn remove(storage: Arc<LocalStorage>, body: Bytes) -> Result<Response, AgentError> {
    let value = parse_json(&body)?;
    let obj = value.as_object().ok_or_else(|| bad("refs"))?;
    let refs: Vec<Ref> = obj
        .get("refs")
        .and_then(|v| v.as_array())
        .ok_or_else(|| bad("refs"))?
        .iter()
        .map(parse_ref)
        .collect::<Option<_>>()
        .ok_or_else(|| bad("refs"))?;
    let prune = truthy(obj.get("pruneEmptyDirs"));
    blocking(move || storage.remove(&refs, prune)).await?;
    Ok(ok_json())
}

pub async fn move_or_copy(
    storage: Arc<LocalStorage>,
    body: Bytes,
    is_move: bool,
) -> Result<Response, AgentError> {
    let value = parse_json(&body)?;
    let obj = value.as_object().ok_or_else(|| bad("refs"))?;
    let from = obj
        .get("from")
        .and_then(parse_ref)
        .ok_or_else(|| bad("refs"))?;
    let to = obj
        .get("to")
        .and_then(parse_ref)
        .ok_or_else(|| bad("refs"))?;
    blocking(move || {
        if is_move {
            storage.mv(&from, &to)
        } else {
            storage.copy(&from, &to)
        }
    })
    .await?;
    Ok(ok_json())
}

pub async fn link(storage: Arc<LocalStorage>, body: Bytes) -> Result<Response, AgentError> {
    let value = parse_json(&body)?;
    let obj = value.as_object().ok_or_else(|| bad("links"))?;
    let links: Vec<(Ref, Ref)> = obj
        .get("links")
        .and_then(|v| v.as_array())
        .ok_or_else(|| bad("links"))?
        .iter()
        .map(|l| {
            let o = l.as_object()?;
            Some((parse_ref(o.get("target")?)?, parse_ref(o.get("at")?)?))
        })
        .collect::<Option<_>>()
        .ok_or_else(|| bad("links"))?;
    let dry_run = truthy(obj.get("dryRun"));
    let outcomes = blocking(move || storage.link(&links, dry_run)).await?;
    Ok(Json(json!({"outcomes": outcomes})).into_response())
}

pub async fn hash(storage: Arc<LocalStorage>, body: Bytes) -> Result<Response, AgentError> {
    let value = parse_json(&body)?;
    let r = parse_ref(&value).ok_or_else(|| bad("ref"))?;
    let (tx, response) = crate::ndjson::ndjson_response();
    tokio::task::spawn_blocking(move || {
        let full = match storage.resolve(&r) {
            Ok(full) => full,
            Err(e) => {
                tx.blocking_json(&json!({"error": e.message}));
                return;
            }
        };
        let mut bytes: u64 = 0;
        let mut sent: u64 = 0;
        let outcome = crate::hashing::sha256_region(&full, None, |n| {
            bytes += n;
            if bytes - sent >= crate::wire::HASH_EMIT_BYTES {
                sent = bytes;
                return tx.blocking_json(&json!({"bytes": bytes}));
            }
            !tx.is_closed()
        });
        match outcome {
            Ok(crate::hashing::HashOutcome::Done(sha256)) => {
                // Close the count before the digest, so a caller's progress
                // total reaches the file's size however small the file.
                if bytes > sent {
                    tx.blocking_json(&json!({"bytes": bytes}));
                }
                tx.blocking_json(&json!({"sha256": sha256}));
            }
            // The client went away; there is nobody to tell.
            Ok(crate::hashing::HashOutcome::Cancelled) => {}
            Err(e) => {
                tx.blocking_json(&json!({"error": e.to_string()}));
            }
        }
    });
    Ok(response)
}

/// The pipe capacity a bulk receive asks for, and so the most one splice can
/// move. 1 MiB is the usual `/proc/sys/fs/pipe-max-size`; the kernel caps the
/// request rather than refusing it, and the granted size is what gets used.
const SPLICE_CHUNK: usize = 1024 * 1024;

/// The upgraded half of a bulk receive: take the raw socket back off hyper and
/// splice the declared number of bytes into the file, then say how it went on
/// the same connection — after a 101 there is no HTTP left to carry a status.
///
/// Every failure is reported through that line rather than a response, so the
/// sender always learns the outcome; a connection that dies before the ack is
/// a failed send, and the partial file is what the next resume verifies.
async fn bulk_receive(upgrade: hyper::upgrade::OnUpgrade, file: std::fs::File, len: u64) {
    let upgraded = match upgrade.await {
        Ok(upgraded) => upgraded,
        Err(_) => return, // the connection went away before it was handed over
    };
    // Through hyper-util's helper, not hyper's own downcast: axum::serve runs
    // the h1/h2 auto builder, which wraps the connection in a `Rewind` for its
    // protocol sniff. Downcasting to the bare socket therefore always fails,
    // and this unwraps that layer and folds the sniffed bytes back into
    // read_buf where they belong.
    match hyper_util::server::conn::auto::upgrade::downcast::<
        hyper_util::rt::TokioIo<tokio::net::TcpStream>,
    >(upgraded)
    {
        Ok(parts) => {
            // Blocking mode and a blocking thread: splice on a regular file
            // would otherwise stall an executor thread, and this way the loop
            // needs no readiness dance of its own.
            let tcp = match parts.io.into_inner().into_std() {
                Ok(tcp) => tcp,
                Err(_) => return,
            };
            if tcp.set_nonblocking(false).is_err() {
                return;
            }
            let prefix = parts.read_buf;
            let _ = tokio::task::spawn_blocking(move || splice_body(tcp, prefix, file, len)).await;
        }
        Err(upgraded) => {
            // The connection isn't a plain TCP socket this build can splice
            // from. Read it the ordinary way so the transfer still completes.
            let _ = copy_upgraded(upgraded, file, len).await;
        }
    }
}

/// socket → pipe → file, never through this process. Returns what the ack says.
fn splice_body(tcp: std::net::TcpStream, prefix: Bytes, mut file: std::fs::File, len: u64) {
    use rustix::pipe::{splice, SpliceFlags};
    use std::io::Write;
    let outcome = (|| -> std::io::Result<()> {
        let mut done = 0u64;
        // Whatever hyper had already read past the headers belongs to the body
        // and never reached the socket buffer, so it is written by hand first.
        if !prefix.is_empty() {
            let take = (prefix.len() as u64).min(len) as usize;
            file.write_all(&prefix[..take])?;
            done += take as u64;
        }
        if done < len {
            let (reader, writer) = rustix::pipe::pipe()?;
            // A pipe holds 64 KiB by default, and a splice can only move what
            // fits — which would be two syscalls every 64 KiB, enough to cost
            // more than the copy it saves. Ask for the system maximum and use
            // whatever it grants; a refusal just leaves the default.
            let capacity = rustix::pipe::fcntl_setpipe_size(&writer, SPLICE_CHUNK)
                .or_else(|_| rustix::pipe::fcntl_getpipe_size(&writer))
                .unwrap_or(64 * 1024);
            while done < len {
                let want = ((len - done) as usize).min(capacity);
                let moved = splice(&tcp, None, &writer, None, want, SpliceFlags::MOVE)?;
                if moved == 0 {
                    return Err(std::io::Error::other(
                        "connection closed before the declared length",
                    ));
                }
                let mut left = moved;
                while left > 0 {
                    let written = splice(&reader, None, &file, None, left, SpliceFlags::MOVE)?;
                    if written == 0 {
                        return Err(std::io::Error::other("splice to the file wrote nothing"));
                    }
                    left -= written;
                }
                done += moved as u64;
            }
        }
        file.flush()
    })();
    let mut tcp = tcp;
    let _ = match outcome {
        Ok(()) => writeln!(tcp, "TJ-OK {len}"),
        Err(e) => writeln!(tcp, "TJ-ERR {e}"),
    };
    let _ = tcp.flush();
}

/// The fallback when the socket can't be reached: the same bytes, read the
/// ordinary way, with the same ack.
async fn copy_upgraded(upgraded: hyper::upgrade::Upgraded, file: std::fs::File, len: u64) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut io = hyper_util::rt::TokioIo::new(upgraded);
    let mut file = tokio::fs::File::from_std(file);
    let mut left = len;
    let mut buf = vec![0u8; SPLICE_CHUNK];
    let outcome = async {
        while left > 0 {
            let want = (left as usize).min(buf.len());
            let n = io.read(&mut buf[..want]).await?;
            if n == 0 {
                return Err(std::io::Error::other(
                    "connection closed before the declared length",
                ));
            }
            file.write_all(&buf[..n]).await?;
            left -= n as u64;
        }
        file.flush().await
    }
    .await;
    let ack = match outcome {
        Ok(()) => format!("TJ-OK {len}\n"),
        Err(e) => format!("TJ-ERR {e}\n"),
    };
    let _ = io.write_all(ack.as_bytes()).await;
    let _ = io.flush().await;
}

pub async fn receive(
    storage: Arc<LocalStorage>,
    headers: &HeaderMap,
    body: Body,
    upgrade: Option<hyper::upgrade::OnUpgrade>,
) -> Result<Response, AgentError> {
    let r = header_ref(headers)?;
    let offset: u64 = headers
        .get(crate::wire::OFFSET_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("0")
        .parse()
        .map_err(|_| bad("offset"))?;
    // The receive handler answers 400 (not 500) for an unreachable root or
    // a confined-away path, as the TS one does.
    let full = storage.resolve(&r).map_err(|mut e| {
        e.status = StatusCode::BAD_REQUEST;
        e
    })?;
    storage.invalidate_root(r.root);
    if let Some(parent) = full.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(AgentError::from)?;
    }
    // A non-zero offset appends, so it has to name exactly the end of what
    // is already here. Senders resume from a prefix they verified moments
    // earlier; if the file changed since, appending would splice bytes into
    // the wrong place and leave a plausible-looking corrupt file.
    if offset > 0 {
        let held = match tokio::fs::metadata(&full).await {
            Ok(m) => Some(m.len()),
            Err(_) => None,
        };
        if held != Some(offset) {
            return Err(AgentError {
                status: StatusCode::CONFLICT,
                message: format!(
                    "Offset {offset} does not match the {} byte(s) already here",
                    held.map_or_else(|| "missing".to_string(), |h| h.to_string())
                ),
                code: None,
            });
        }
    }
    // Settle the bulk receive *before* the file is touched: opening it pins the
    // destination to `offset`, and a request refused after that would already
    // have discarded whatever came later. An Upgrade this build does not know
    // is refused outright rather than read as an ordinary body — such a request
    // carries no bytes, and treating it as one would empty the destination.
    let bulk = match headers.get("upgrade").and_then(|v| v.to_str().ok()) {
        None => None,
        Some(want) if want.eq_ignore_ascii_case(crate::wire::BULK_SPLICE_V1) => {
            let upgrade = upgrade.ok_or_else(|| bad("upgrade"))?;
            let len: u64 = headers
                .get(crate::wire::LENGTH_HEADER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse().ok())
                .ok_or_else(|| bad(crate::wire::LENGTH_HEADER))?;
            Some((upgrade, len))
        }
        Some(_) => return Err(bad("upgrade")),
    };

    // Positioned rather than appended: splice(2) refuses an append-mode
    // target, so a resume could not be spliced into one. The offset was just
    // checked against what is here, so pinning the file to exactly that prefix
    // and writing from there is the same thing an append did — and it also
    // means nothing beyond the prefix can survive as a tail.
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&full)
        .map_err(AgentError::from)?;
    file.set_len(offset).map_err(AgentError::from)?;
    {
        use std::io::Seek;
        file.seek(std::io::SeekFrom::Start(offset))
            .map_err(AgentError::from)?;
    }

    // Answer 101 and take the connection over, so the body can be spliced from
    // the socket into the file without passing through either process.
    if let Some((upgrade, len)) = bulk {
        tokio::spawn(bulk_receive(upgrade, file, len));
        return Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .header("connection", "upgrade")
            .header("upgrade", crate::wire::BULK_SPLICE_V1)
            .body(Body::empty())
            .map_err(|e| AgentError::internal(e.to_string()));
    }

    // The disk write runs on a blocking thread fed by a channel, rather than
    // through `tokio::fs::File`, for two reasons: a hyper chunk is
    // reference-counted, so handing it over costs nothing where an async
    // `write_all` would copy it into tokio's own buffer first; and the write
    // then overlaps the next read off the socket instead of taking turns with
    // it. The queue is bounded, so a slow disk still pushes back on the wire.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Bytes>(RECEIVE_QUEUE);
    let writer = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        use std::io::Write;
        let mut file = file;
        while let Some(chunk) = rx.blocking_recv() {
            file.write_all(&chunk)?;
        }
        file.flush()
    });

    let mut stream = body.into_data_stream();
    let mut read_err = None;
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(chunk) => {
                // A closed channel means the writer already failed; its error
                // is the one worth reporting, so stop and let it surface.
                if tx.send(chunk).await.is_err() {
                    break;
                }
            }
            Err(e) => {
                read_err = Some(AgentError::internal(format!("body read: {e}")));
                break;
            }
        }
    }
    drop(tx);
    match writer.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(AgentError::from(e)),
        Err(e) => return Err(AgentError::internal(format!("write task: {e}"))),
    }
    if let Some(e) = read_err {
        return Err(e);
    }
    Ok(ok_json())
}

pub async fn job(storage: Arc<LocalStorage>, body: Bytes) -> Result<Response, AgentError> {
    let value = parse_json(&body)?;
    let spec: crate::wire::JobSpec = serde_json::from_value(value).map_err(|_| bad("job spec"))?;
    let (tx, response) = crate::ndjson::ndjson_response();
    match spec {
        crate::wire::JobSpec::Copy { from, to, mv } => {
            tokio::task::spawn_blocking(move || {
                crate::jobs::run_copy_job(&storage, &from, &to, mv, &tx);
            });
        }
        crate::wire::JobSpec::Send { from, to } => {
            tokio::spawn(crate::jobs::run_send_job(storage, from, to, tx));
        }
        crate::wire::JobSpec::Download {
            repo_id,
            revision,
            files,
            into,
        } => {
            tokio::spawn(crate::jobs::run_download_job(
                storage, repo_id, revision, files, into, tx,
            ));
        }
    }
    Ok(response)
}
