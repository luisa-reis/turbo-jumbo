//! The router: a liveness `GET /`, and every protocol op as
//! `POST /api/v1/storage/{op}` behind the bearer token. Op semantics live
//! in ops.rs (and jobs.rs as they land); this file routes and refuses.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;

use crate::config::AgentConfig;
use crate::error::AgentError;
use crate::ops;
use crate::storage::LocalStorage;

/// JSON op bodies are small; this is generous headroom, not a promise.
/// The byte ops (`write`, `receive`) stream and cap themselves.
const JSON_BODY_LIMIT: usize = 64 * 1024 * 1024;

pub struct AppState {
    pub token: Option<String>,
    pub storage: Arc<LocalStorage>,
}

impl AppState {
    pub fn new(config: AgentConfig) -> Arc<Self> {
        Arc::new(AppState {
            token: config.token,
            storage: Arc::new(LocalStorage::new(config.roots)),
        })
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(liveness))
        .route("/api/v1/storage/{op}", post(dispatch))
        // The byte ops carry whole chunks; axum's 2 MB default would refuse
        // them. The caps that matter are the protocol's own.
        .layer(DefaultBodyLimit::disable())
        .with_state(state)
}

async fn liveness() -> &'static str {
    // Deliberately content-free.
    "turbo-jumbo agent\n"
}

/// Ops that exist in the protocol but are not implemented here yet — each
/// answers 501 rather than 404, so a probe can tell "too new for this
/// agent" from "no such op". They graduate one at a time, gated by the TS
/// conformance suites.
const UNIMPLEMENTED: &[&str] = &["hash", "job", "receive"];

async fn dispatch(
    State(state): State<Arc<AppState>>,
    Path(op): Path<String>,
    req: Request,
) -> Response {
    if let Some(expected) = state.token.as_deref() {
        let presented = req
            .headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok());
        if presented != Some(&format!("Bearer {expected}")) {
            return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
        }
    }
    let storage = Arc::clone(&state.storage);
    let result: Result<Response, AgentError> = match op.as_str() {
        "write" => {
            let (parts, body) = req.into_parts();
            ops::write(storage, &parts.headers, body).await
        }
        "list" | "read" | "mkdir" | "usage" | "remove" | "move" | "copy" | "link" => {
            let body = match buffer_json_body(req.into_body()).await {
                Ok(b) => b,
                Err(e) => return e.into_response(),
            };
            match op.as_str() {
                "list" => ops::list(storage, body).await,
                "read" => ops::read(storage, body).await,
                "mkdir" => ops::mkdir(storage, body).await,
                "remove" => ops::remove(storage, body).await,
                "move" => ops::move_or_copy(storage, body, true).await,
                "copy" => ops::move_or_copy(storage, body, false).await,
                "link" => ops::link(storage, body).await,
                _ => ops::usage(storage, body).await,
            }
        }
        known if UNIMPLEMENTED.contains(&known) => {
            return (
                StatusCode::NOT_IMPLEMENTED,
                format!("not implemented: {op}"),
            )
                .into_response()
        }
        _ => return (StatusCode::NOT_FOUND, format!("Unknown op: {op}")).into_response(),
    };
    result.unwrap_or_else(|e| e.into_response())
}

async fn buffer_json_body(body: Body) -> Result<bytes::Bytes, AgentError> {
    axum::body::to_bytes(body, JSON_BODY_LIMIT)
        .await
        .map_err(|_| AgentError::bad_request("Invalid JSON"))
}
