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

pub async fn receive(
    storage: Arc<LocalStorage>,
    headers: &HeaderMap,
    body: Body,
) -> Result<Response, AgentError> {
    use tokio::io::AsyncWriteExt;
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
    let mut file = if offset == 0 {
        tokio::fs::File::create(&full).await
    } else {
        tokio::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&full)
            .await
    }
    .map_err(AgentError::from)?;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AgentError::internal(format!("body read: {e}")))?;
        file.write_all(&chunk).await.map_err(AgentError::from)?;
    }
    file.flush().await.map_err(AgentError::from)?;
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
