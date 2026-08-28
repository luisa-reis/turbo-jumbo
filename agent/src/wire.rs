//! The protocol's shapes, exactly as lib/storage/agent-protocol.ts and the
//! TS types in lib/storage/storage.ts spell them — field names included,
//! since JSON is the contract the conformance suites hold both sides to.
//! Grows one slice at a time with the ops that use each shape.

use serde::Serialize;

use crate::refs::Root;

/// The cap on `read` and `write`; weights move by job.
pub const MAX_SMALL_FILE: u64 = 8 * 1024 * 1024;

pub const REF_ROOT_HEADER: &str = "x-tj-root";
pub const REF_PATH_HEADER: &str = "x-tj-path";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub kind: EntryKind,
    pub size: u64,
    pub mtime_ms: f64,
    /// Where a symlink points, verbatim. Symlinks only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_target: Option<String>,
    /// A symlink whose target is gone. Symlinks only, and only when true.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dangling: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dtype: Option<String>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ListOptions {
    pub dtype: bool,
    pub strict: bool,
}

#[derive(Debug, Serialize)]
pub struct Usage {
    pub free: u64,
    pub total: u64,
    /// Opaque filesystem identity — compare, never interpret. The decimal
    /// st_dev, exactly as the TS side stringifies it.
    pub device: String,
}

/// A `Root` from its wire name.
impl Root {
    pub fn parse(name: &str) -> Option<Root> {
        Root::ALL.iter().copied().find(|r| r.as_str() == name)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkOutcome {
    Created,
    Replaced,
    Kept,
    Skipped,
}

/// `receive` only: the byte offset this chunk starts at.
pub const OFFSET_HEADER: &str = "x-tj-offset";

/// The bulk receive: an HTTP upgrade that hands the connection over so the
/// body can be spliced from the socket into the file without passing through
/// either process. The body length moves to a header of its own, because the
/// upgrade request carries no body — the bytes follow the 101.
///
/// A sender must only ask for this against a receiver that advertises it in
/// `/api/v1/version` (BULK_SPLICE_V1 in `bulk`). A receiver that did not
/// advertise it would read the upgrade request as an ordinary receive of
/// `Content-Length: 0` and truncate the destination, which is why the
/// capability probe — not the Upgrade header — is what gates this.
pub const BULK_SPLICE_V1: &str = "tj-splice/1";

/// Bulk receive only: how many bytes follow the 101.
pub const LENGTH_HEADER: &str = "x-tj-length";

/// How often the hash stream reports a cumulative byte count. A final
/// frame always closes the count.
pub const HASH_EMIT_BYTES: u64 = 8 * 1024 * 1024;

use crate::refs::Ref;
use serde::Deserialize;

/// A job as the wire carries it. Extra fields are ignored, matching the TS
/// handler's rebuild-and-drop.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum JobSpec {
    Download {
        #[serde(rename = "repoId")]
        repo_id: String,
        revision: Option<String>,
        files: Vec<String>,
        into: Ref,
    },
    Copy {
        from: Ref,
        to: Ref,
        #[serde(rename = "move", default)]
        mv: bool,
    },
    Send {
        from: Ref,
        to: SendTarget,
    },
}

#[derive(Debug, Deserialize)]
pub struct SendTarget {
    /// The target agent's protocol root URL.
    pub agent: String,
    pub token: Option<String>,
    #[serde(rename = "ref")]
    pub target: Ref,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum JobEvent {
    Progress { done: u64, total: u64 },
    Verify { done: u64, total: u64 },
    Log { line: String },
    Done { result: serde_json::Value },
    Error { message: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyResult {
    pub resumed_from: u64,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub output: String,
}
