//! Errors as the wire carries them: a status, the message as a text body,
//! and — when the cause was the filesystem — the errno name in the
//! `x-tj-error-code` header, because a remote ENOENT must stay an ENOENT
//! to the tolerance checks in the host's policy modules.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

pub const ERROR_CODE_HEADER: &str = "x-tj-error-code";

pub struct AgentError {
    pub status: StatusCode,
    pub message: String,
    pub code: Option<&'static str>,
}

impl AgentError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        AgentError {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
            code: None,
        }
    }

    /// A thrown storage error, as the TS handlers surface one: 500, the
    /// message as the body, no errno (those come from `From<io::Error>`).
    pub fn internal(message: impl Into<String>) -> Self {
        AgentError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
            code: None,
        }
    }
}

impl From<std::io::Error> for AgentError {
    fn from(e: std::io::Error) -> Self {
        AgentError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: e.to_string(),
            code: errno_name(e.raw_os_error()),
        }
    }
}

/// The errno names the host's tolerance checks actually look at, from the
/// Linux numbers — the agent targets Linux, per the deploy story.
fn errno_name(raw: Option<i32>) -> Option<&'static str> {
    match raw? {
        2 => Some("ENOENT"),
        13 => Some("EACCES"),
        18 => Some("EXDEV"),
        20 => Some("ENOTDIR"),
        21 => Some("EISDIR"),
        39 => Some("ENOTEMPTY"),
        _ => None,
    }
}

impl IntoResponse for AgentError {
    fn into_response(self) -> Response {
        let mut res = (self.status, self.message).into_response();
        if let Some(code) = self.code {
            if let Ok(value) = code.parse() {
                res.headers_mut().insert(ERROR_CODE_HEADER, value);
            }
        }
        res
    }
}
