//! The router: a liveness `GET /`, and every protocol op as
//! `POST /api/v1/storage/{op}` behind the bearer token. Op semantics live
//! in ops.rs; this file only routes and refuses.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;

use crate::config::AgentConfig;
use crate::ops;

pub struct AppState {
    pub config: AgentConfig,
}

impl AppState {
    pub fn new(config: AgentConfig) -> Arc<Self> {
        Arc::new(AppState { config })
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(liveness))
        .route("/api/v1/storage/{op}", post(dispatch))
        .with_state(state)
}

async fn liveness() -> &'static str {
    // Deliberately content-free.
    "turbo-jumbo agent\n"
}

/// Ops that exist in the protocol but are not implemented here yet — each
/// answers 501 rather than 404, so a probe can tell "too new for this
/// agent" from "no such op". They graduate to ops.rs one at a time, gated
/// by the TS conformance suites.
const UNIMPLEMENTED: &[&str] = &[
    "list", "read", "write", "mkdir", "remove", "move", "copy", "link", "hash",
    "job", "receive",
];

async fn dispatch(
    State(state): State<Arc<AppState>>,
    Path(op): Path<String>,
    headers: HeaderMap,
    // Buffered whole: fine for the JSON ops. The byte/streaming ops (write,
    // receive, hash, job) take the request body as a stream when they land.
    body: Bytes,
) -> Response {
    if let Some(expected) = state.config.token.as_deref() {
        let presented = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok());
        if presented != Some(&format!("Bearer {expected}")) {
            return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
        }
    }
    match op.as_str() {
        "usage" => ops::usage(&state.config, &body)
            .map(IntoResponse::into_response)
            .unwrap_or_else(IntoResponse::into_response),
        known if UNIMPLEMENTED.contains(&known) => (
            StatusCode::NOT_IMPLEMENTED,
            format!("not implemented: {op}"),
        )
            .into_response(),
        _ => (StatusCode::NOT_FOUND, format!("Unknown op: {op}")).into_response(),
    }
}
