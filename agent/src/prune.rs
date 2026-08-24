//! What every removal does about the directories it empties, ported from
//! lib/storage/prune.ts: walk up towards — never onto — the root, removing
//! directories left empty, where a directory holding only the hf CLI's
//! `.cache` download bookkeeping counts as empty.

use std::fs;
use std::path::Path;

pub fn prune_empty_dirs(from: &Path, stop_at: &Path) -> Result<(), std::io::Error> {
    let mut dir = match from.parent() {
        Some(p) => p.to_path_buf(),
        None => return Ok(()),
    };
    while dir != stop_at && dir.starts_with(stop_at) {
        let names: Vec<_> = match fs::read_dir(&dir) {
            Ok(rd) => rd.filter_map(|e| e.ok().map(|e| e.file_name())).collect(),
            Err(_) => return Ok(()), // already gone or unreadable — nothing to prune
        };
        let only_cache = names.len() == 1 && names[0] == ".cache";
        if only_cache {
            // That bookkeeping belongs to files already gone; keeping it
            // would leave a husk the scans keep tripping over.
            fs::remove_dir_all(dir.join(".cache"))?;
        } else if !names.is_empty() {
            return Ok(());
        }
        if fs::remove_dir(&dir).is_err() {
            return Ok(()); // e.g. a file appeared concurrently — leave it be
        }
        dir = match dir.parent() {
            Some(p) => p.to_path_buf(),
            None => return Ok(()),
        };
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_tree() -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "tj-prune-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("org/repo/Q4")).unwrap();
        base
    }

    #[test]
    fn removes_empties_up_to_but_never_onto_the_root() {
        let base = tmp_tree();
        prune_empty_dirs(&base.join("org/repo/Q4/gone.gguf"), &base).unwrap();
        assert!(!base.join("org").exists());
        assert!(base.exists());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn cache_only_counts_as_empty_and_content_stops_the_walk() {
        let base = tmp_tree();
        fs::create_dir_all(base.join("org/repo/.cache/huggingface")).unwrap();
        fs::write(base.join("org/repo/.cache/huggingface/x.metadata"), "").unwrap();
        fs::write(base.join("org/keep.txt"), "k").unwrap();
        fs::remove_dir(base.join("org/repo/Q4")).unwrap();
        prune_empty_dirs(&base.join("org/repo/gone.gguf"), &base).unwrap();
        // repo went (only .cache in it); org stayed (keep.txt).
        assert!(!base.join("org/repo").exists());
        assert!(base.join("org/keep.txt").exists());
        fs::remove_dir_all(&base).unwrap();
    }
}
