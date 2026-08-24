//! Streaming SHA-256, the shape file-transfer.ts's localSha256 and
//! sha256Region give it: chunked reads, a per-chunk report that doubles as
//! the cancellation clock, and an optional prefix limit for resume
//! verification.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};

pub enum HashOutcome {
    Done(String),
    Cancelled,
}

const CHUNK: usize = 64 * 1024;

/// SHA-256 of the first `limit` bytes of `path` (all of them when None),
/// reporting each chunk's size to `on_bytes` — whose `false` cancels the
/// read. A region past EOF hashes what exists, like a capped read stream.
pub fn sha256_region(
    path: &Path,
    limit: Option<u64>,
    mut on_bytes: impl FnMut(u64) -> bool,
) -> std::io::Result<HashOutcome> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut remaining = limit;
    let mut buf = vec![0u8; CHUNK];
    loop {
        let want = match remaining {
            Some(0) => break,
            Some(r) => r.min(CHUNK as u64) as usize,
            None => CHUNK,
        };
        let n = file.read(&mut buf[..want])?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        if let Some(r) = remaining.as_mut() {
            *r -= n as u64;
        }
        if !on_bytes(n as u64) {
            return Ok(HashOutcome::Cancelled);
        }
    }
    let mut hex = String::with_capacity(64);
    for b in hasher.finalize() {
        hex.push_str(&format!("{b:02x}"));
    }
    Ok(HashOutcome::Done(hex))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "tj-hash-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        File::create(&path).unwrap().write_all(bytes).unwrap();
        path
    }

    fn digest(path: &Path, limit: Option<u64>) -> String {
        match sha256_region(path, limit, |_| true).unwrap() {
            HashOutcome::Done(d) => d,
            HashOutcome::Cancelled => unreachable!(),
        }
    }

    #[test]
    fn hashes_whole_files_and_prefixes() {
        let path = tmp(b"abcdef");
        // sha256("abc"), the classic test vector: the prefix limit works.
        assert_eq!(
            digest(&path, Some(3)),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_ne!(digest(&path, None), digest(&path, Some(3)));
        // A region past EOF hashes what exists.
        assert_eq!(digest(&path, Some(100)), digest(&path, None));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_false_report_cancels() {
        let path = tmp(&vec![7u8; 200 * 1024]);
        let out = sha256_region(&path, None, |_| false).unwrap();
        assert!(matches!(out, HashOutcome::Cancelled));
        std::fs::remove_file(path).unwrap();
    }
}
