//! Roots and refs, and the one function that turns a wire path into a
//! filesystem path. Confinement is structural — there is no way to name a
//! path outside a root — and this is the whole of it, so it mirrors the TS
//! `resolveRef` check for check: reject absolute paths and `..` segments,
//! then belt-and-braces verify the joined path still sits under the root.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Root {
    Models,
    Cold,
    Lemonade,
}

impl Root {
    pub const ALL: [Root; 3] = [Root::Models, Root::Cold, Root::Lemonade];

    pub fn as_str(self) -> &'static str {
        match self {
            Root::Models => "models",
            Root::Cold => "cold",
            Root::Lemonade => "lemonade",
        }
    }
}

/// A path within a root, as it arrives on the wire.
// Dead code until the path-taking verbs land; unit-tested below meanwhile.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct Ref {
    pub root: Root,
    pub path: String,
}

/// `rel_path` as an absolute path confined to `dir`.
#[allow(dead_code)] // first consumer is the `read` verb
pub fn resolve_ref(dir: &Path, rel_path: &str) -> Result<PathBuf, String> {
    if Path::new(rel_path).is_absolute() {
        return Err(format!("Path must be relative to its root: {rel_path}"));
    }
    if rel_path.split('/').any(|seg| seg == "..") {
        return Err(format!("Path must not climb out of its root: {rel_path}"));
    }
    // Lexical normalization only (like the TS side): `.` components drop,
    // nothing resolves symlinks — a link inside a root is the root's own
    // business.
    let mut full = dir.to_path_buf();
    for component in Path::new(rel_path).components() {
        match component {
            Component::Normal(part) => full.push(part),
            Component::CurDir => {}
            _ => {
                return Err(format!("Path resolves outside its root: {rel_path}"));
            }
        }
    }
    if !full.starts_with(dir) {
        return Err(format!("Path resolves outside its root: {rel_path}"));
    }
    Ok(full)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_cannot_climb_out_of_its_root() {
        let dir = Path::new("/data/models");
        for path in ["../escape", "a/../../escape", "/etc/passwd"] {
            assert!(resolve_ref(dir, path).is_err(), "{path} should be refused");
        }
    }

    #[test]
    fn nested_paths_resolve_under_the_root() {
        let dir = Path::new("/data/models");
        assert_eq!(
            resolve_ref(dir, "org/repo/w.gguf").unwrap(),
            PathBuf::from("/data/models/org/repo/w.gguf")
        );
        // The empty path is the root itself — a `list` of everything.
        assert_eq!(resolve_ref(dir, "").unwrap(), PathBuf::from("/data/models"));
    }
}
