//! The op implementations, one at a time, each held to the TS agent's
//! observable behavior by the conformance suites. `usage` first: it proves
//! the JSON-in/JSON-out path, the root resolution, and rustix.

use axum::Json;
use rustix::fs::statfs;
use serde::{Deserialize, Serialize};

use crate::config::AgentConfig;
use crate::error::AgentError;
use crate::refs::Root;

#[derive(Deserialize)]
struct UsageRequest {
    root: Root,
}

#[derive(Serialize)]
pub struct Usage {
    free: u64,
    total: u64,
    /// Opaque filesystem identity — compare, never interpret. The decimal
    /// st_dev, exactly as the TS side stringifies it.
    device: String,
}

pub fn usage(config: &AgentConfig, body: &[u8]) -> Result<Json<Usage>, AgentError> {
    let req: UsageRequest = serde_json::from_slice(body)
        .map_err(|_| AgentError::bad_request("Invalid root"))?;
    let dir = config.roots.get(req.root).ok_or_else(|| {
        AgentError::bad_request(format!(
            "No {} directory is configured",
            req.root.as_str()
        ))
    })?;
    let fs = statfs(dir).map_err(|e| AgentError::from(std::io::Error::from(e)))?;
    let meta = std::fs::metadata(dir)?;
    // bavail, not bfree: the space actually usable, which is what a
    // download will be allowed to write.
    Ok(Json(Usage {
        free: fs.f_bsize as u64 * fs.f_bavail,
        total: fs.f_bsize as u64 * fs.f_blocks,
        device: std::os::unix::fs::MetadataExt::dev(&meta).to_string(),
    }))
}
