//! The dominant tensor dtype of a `.safetensors` file, ported check for
//! check from lib/models/safetensors.ts: the first 8 bytes are a
//! little-endian u64 header length, then that many bytes of JSON mapping
//! tensor names to `{dtype, …}`; the answer is the first
//! non-`__metadata__` tensor's dtype, uppercased — *first in document
//! order*, which is why serde_json runs with `preserve_order`. Reads only
//! the header, never the tensor data; anything unreadable or malformed is
//! None, never an error — a walk labels what it can.

use std::fs::File;
use std::io::Read;
use std::path::Path;

/// A safetensors header is JSON and small; cap the read so a corrupt
/// length prefix can't ask us to allocate gigabytes.
const MAX_HEADER_BYTES: u64 = 100 * 1024 * 1024;

pub fn read_safetensors_dtype(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut len_buf = [0u8; 8];
    file.read_exact(&mut len_buf).ok()?;
    let header_len = u64::from_le_bytes(len_buf);
    if header_len == 0 || header_len > MAX_HEADER_BYTES {
        return None;
    }
    let mut header = vec![0u8; header_len as usize];
    file.read_exact(&mut header).ok()?;
    let parsed: serde_json::Map<String, serde_json::Value> =
        serde_json::from_slice(&header).ok()?;
    for (key, value) in &parsed {
        if key == "__metadata__" {
            continue;
        }
        if let Some(dtype) = value.get("dtype").and_then(|d| d.as_str()) {
            if !dtype.is_empty() {
                return Some(dtype.to_uppercase());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn safetensors(header_json: &str) -> Vec<u8> {
        let mut out = (header_json.len() as u64).to_le_bytes().to_vec();
        out.extend_from_slice(header_json.as_bytes());
        out
    }

    fn write_tmp(bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "tj-st-{}-{:?}.safetensors",
            std::process::id(),
            std::thread::current().id()
        ));
        File::create(&path).unwrap().write_all(bytes).unwrap();
        path
    }

    #[test]
    fn first_tensor_in_document_order_wins_uppercased() {
        // "b" before "a" in the document: document order, not key order.
        let path = write_tmp(&safetensors(
            r#"{"__metadata__":{"x":"y"},"b":{"dtype":"bf16"},"a":{"dtype":"f32"}}"#,
        ));
        assert_eq!(read_safetensors_dtype(&path).as_deref(), Some("BF16"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn garbage_is_none_not_an_error() {
        let path = write_tmp(b"not a safetensors file at all");
        assert_eq!(read_safetensors_dtype(&path), None);
        std::fs::remove_file(path).unwrap();
        assert_eq!(
            read_safetensors_dtype(Path::new("/nonexistent-tj.safetensors")),
            None
        );
    }
}
