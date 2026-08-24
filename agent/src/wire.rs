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

#[derive(Debug, Serialize)]
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
