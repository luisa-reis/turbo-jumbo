//! The blocking storage core: LocalStorage's semantics from
//! lib/storage/local-storage.ts, held to them by the TS conformance suite.
//! Handlers call in through spawn_blocking; nothing here is async.

use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::config::RootsConfig;
use crate::error::AgentError;
use crate::refs::{resolve_ref, Ref, Root};
use crate::safetensors::read_safetensors_dtype;
use crate::wire::{EntryKind, FileEntry, LinkOutcome, ListOptions, Usage, MAX_SMALL_FILE};

pub struct LocalStorage {
    roots: RootsConfig,
    // The stale-proof half of the TS inventory cache: a safetensors header's
    // dtype remembered against the file's size and mtime, per root. (The
    // other half — identical in-flight walks sharing one traversal — is a
    // pure optimization and deliberately not ported yet.)
    dtype_memo: Mutex<HashMap<Root, HashMap<PathBuf, MemoEntry>>>,
}

#[derive(Clone)]
struct MemoEntry {
    size: u64,
    mtime_ms: f64,
    dtype: String,
}

/// Node's stat.mtimeMs: seconds*1000 + nanoseconds/1e6, as f64.
fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.mtime() as f64 * 1000.0 + meta.mtime_nsec() as f64 / 1e6
}

/// Vanished-mid-walk is fine in any mode: a gone entry holds nothing. Every
/// other failure only passes in tolerant mode.
fn tolerable(e: &std::io::Error, strict: bool) -> bool {
    !strict || e.kind() == std::io::ErrorKind::NotFound
}

impl LocalStorage {
    pub fn new(roots: RootsConfig) -> Self {
        LocalStorage {
            roots,
            dtype_memo: Mutex::new(HashMap::new()),
        }
    }

    pub fn root_dir(&self, root: Root) -> Result<&Path, AgentError> {
        self.roots.get(root).ok_or_else(|| {
            AgentError::internal(format!("No {} directory is configured", root.as_str()))
        })
    }

    pub fn resolve(&self, r: &Ref) -> Result<PathBuf, AgentError> {
        let dir = self.root_dir(r.root)?;
        resolve_ref(dir, &r.path).map_err(AgentError::internal)
    }

    pub fn list(
        &self,
        root: Root,
        under: Option<&str>,
        opts: ListOptions,
    ) -> Result<Vec<FileEntry>, AgentError> {
        let base = self.root_dir(root)?.to_path_buf();
        let dir = match under {
            Some(u) => resolve_ref(&base, u).map_err(AgentError::internal)?,
            None => base,
        };
        let memo = if opts.dtype {
            self.dtype_memo
                .lock()
                .unwrap()
                .get(&root)
                .cloned()
                .unwrap_or_default()
        } else {
            HashMap::new()
        };
        let mut seen = HashMap::new();
        let mut out = Vec::new();
        walk(&dir, under.unwrap_or(""), &mut out, opts, &memo, &mut seen)?;
        if opts.dtype {
            // A full walk saw every file there is, so what it didn't see is
            // gone; a partial one only adds to what's known.
            let mut all = self.dtype_memo.lock().unwrap();
            if under.is_some() {
                all.entry(root).or_default().extend(seen);
            } else {
                all.insert(root, seen);
            }
        }
        Ok(out)
    }

    pub fn read(&self, r: &Ref) -> Result<Vec<u8>, AgentError> {
        let full = self.resolve(r)?;
        let meta = fs::metadata(&full)?;
        if meta.len() > MAX_SMALL_FILE {
            return Err(AgentError::internal(format!(
                "{} is {} bytes; read is for small files only",
                r.path,
                meta.len()
            )));
        }
        Ok(fs::read(&full)?)
    }

    pub fn write(&self, r: &Ref, bytes: &[u8]) -> Result<(), AgentError> {
        if bytes.len() as u64 > MAX_SMALL_FILE {
            return Err(AgentError::internal(format!(
                "{} is {} bytes; write is for small files only",
                r.path,
                bytes.len()
            )));
        }
        let full = self.resolve(r)?;
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&full, bytes)?;
        Ok(())
    }

    pub fn mkdir(&self, r: &Ref) -> Result<(), AgentError> {
        fs::create_dir_all(self.resolve(r)?)?;
        Ok(())
    }

    pub fn usage(&self, root: Root) -> Result<Usage, AgentError> {
        let dir = self.root_dir(root)?;
        let sf = rustix::fs::statfs(dir).map_err(|e| AgentError::from(std::io::Error::from(e)))?;
        let meta = fs::metadata(dir)?;
        // bavail, not bfree: the space actually usable, which is what a
        // download will be allowed to write.
        Ok(Usage {
            free: sf.f_bsize as u64 * sf.f_bavail,
            total: sf.f_bsize as u64 * sf.f_blocks,
            device: meta.dev().to_string(),
        })
    }
}

fn walk(
    dir: &Path,
    rel: &str,
    out: &mut Vec<FileEntry>,
    opts: ListOptions,
    memo: &HashMap<PathBuf, MemoEntry>,
    seen: &mut HashMap<PathBuf, MemoEntry>,
) -> Result<(), AgentError> {
    let entries = match fs::read_dir(dir) {
        Ok(rd) => rd,
        // A directory that vanished mid-walk, or one we may not read: the
        // rest of the inventory is still worth having — unless the caller
        // asked for the whole truth or nothing.
        Err(e) if tolerable(&e, opts.strict) => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    for dirent in entries {
        let dirent = match dirent {
            Ok(d) => d,
            Err(e) if tolerable(&e, opts.strict) => continue,
            Err(e) => return Err(e.into()),
        };
        let name = dirent.file_name().to_string_lossy().into_owned();
        let full = dir.join(dirent.file_name());
        let path = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        let lst = match fs::symlink_metadata(&full) {
            Ok(m) => m,
            Err(e) if tolerable(&e, opts.strict) => continue,
            Err(e) => return Err(e.into()),
        };
        let ft = lst.file_type();
        if ft.is_symlink() {
            // Deliberately not descended into: Lemonade's extra directory is
            // symlinks pointing back into the models root, and following
            // them would report every weight twice. But the size is the
            // target's — what a link to a weight means to anyone asking.
            let link_target = fs::read_link(&full)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            let mut entry = FileEntry {
                path,
                kind: EntryKind::Symlink,
                size: 0,
                mtime_ms: mtime_ms(&lst),
                link_target: Some(link_target),
                dangling: None,
                dtype: None,
            };
            match fs::metadata(&full) {
                Ok(target) => {
                    entry.size = target.len();
                    entry.mtime_ms = mtime_ms(&target);
                    if target.is_file() {
                        read_dtype(&mut entry, &full, opts, memo, seen);
                    }
                }
                Err(_) => entry.dangling = Some(true),
            }
            out.push(entry);
            continue;
        }
        if ft.is_dir() {
            out.push(FileEntry {
                path: path.clone(),
                kind: EntryKind::Dir,
                size: lst.len(),
                mtime_ms: mtime_ms(&lst),
                link_target: None,
                dangling: None,
                dtype: None,
            });
            walk(&full, &path, out, opts, memo, seen)?;
            continue;
        }
        let mut entry = FileEntry {
            path,
            kind: EntryKind::File,
            size: lst.len(),
            mtime_ms: mtime_ms(&lst),
            link_target: None,
            dangling: None,
            dtype: None,
        };
        read_dtype(&mut entry, &full, opts, memo, seen);
        out.push(entry);
    }
    Ok(())
}

/// Label a `.safetensors` entry with its dtype, from the memo when the file
/// hasn't changed since it was last read, else from its header.
fn read_dtype(
    entry: &mut FileEntry,
    full: &Path,
    opts: ListOptions,
    memo: &HashMap<PathBuf, MemoEntry>,
    seen: &mut HashMap<PathBuf, MemoEntry>,
) {
    if !opts.dtype || !entry.path.to_lowercase().ends_with(".safetensors") {
        return;
    }
    if let Some(hit) = memo.get(full) {
        if hit.size == entry.size && hit.mtime_ms == entry.mtime_ms {
            entry.dtype = Some(hit.dtype.clone());
            seen.insert(full.to_path_buf(), hit.clone());
            return;
        }
    }
    if let Some(dtype) = read_safetensors_dtype(full) {
        entry.dtype = Some(dtype.clone());
        seen.insert(
            full.to_path_buf(),
            MemoEntry {
                size: entry.size,
                mtime_ms: entry.mtime_ms,
                dtype,
            },
        );
    }
}

/// Linux's EXDEV: a rename that would cross filesystems.
const EXDEV: i32 = 18;

fn remove_all_force(full: &Path) -> Result<(), std::io::Error> {
    match fs::symlink_metadata(full) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
        Ok(m) if m.is_dir() => fs::remove_dir_all(full),
        Ok(_) => fs::remove_file(full),
    }
}

impl LocalStorage {
    pub fn remove(&self, refs: &[Ref], prune: bool) -> Result<(), AgentError> {
        for r in refs {
            let full = self.resolve(r)?;
            remove_all_force(&full)?;
            if prune {
                crate::prune::prune_empty_dirs(&full, self.root_dir(r.root)?)?;
            }
        }
        Ok(())
    }

    pub fn mv(&self, from: &Ref, to: &Ref) -> Result<(), AgentError> {
        let src = self.resolve(from)?;
        let dst = self.resolve(to)?;
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        match fs::rename(&src, &dst) {
            Ok(()) => Ok(()),
            // Two roots need not share a filesystem (cold storage is usually
            // a different disk or a NAS): a rename that can't cross is a
            // copy and a delete.
            Err(e) if e.raw_os_error() == Some(EXDEV) => {
                fs::copy(&src, &dst)?;
                fs::remove_file(&src)?;
                Ok(())
            }
            Err(e) => Err(e.into()),
        }
    }

    pub fn copy(&self, from: &Ref, to: &Ref) -> Result<(), AgentError> {
        let src = self.resolve(from)?;
        let dst = self.resolve(to)?;
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&src, &dst)?;
        Ok(())
    }

    pub fn link(
        &self,
        links: &[(Ref, Ref)], // (target, at)
        dry_run: bool,
    ) -> Result<Vec<LinkOutcome>, AgentError> {
        let mut out = Vec::new();
        for (target, at) in links {
            let link_path = self.resolve(at)?;
            let target_path = self.resolve(target)?;
            // What currently sits at the link's path: None = nothing (or
            // unreadable, which the TS side also treats as nothing),
            // Some(None) = a real file, Some(Some(p)) = a symlink to p.
            let current = match fs::symlink_metadata(&link_path) {
                Err(_) => None,
                Ok(m) if m.file_type().is_symlink() => {
                    Some(Some(fs::read_link(&link_path).unwrap_or_default()))
                }
                Ok(_) => Some(None),
            };
            match current {
                None => {
                    if !dry_run {
                        if let Some(parent) = link_path.parent() {
                            fs::create_dir_all(parent)?;
                        }
                        std::os::unix::fs::symlink(&target_path, &link_path)?;
                    }
                    out.push(LinkOutcome::Created);
                }
                // A real file. Somebody's own model — never replaced.
                Some(None) => out.push(LinkOutcome::Skipped),
                Some(Some(cur)) if cur == target_path => out.push(LinkOutcome::Kept),
                // Replace rather than fail: a link pointing at the wrong
                // target is exactly what a sync run exists to correct.
                Some(Some(_)) => {
                    if !dry_run {
                        match fs::remove_file(&link_path) {
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                            other => other?,
                        }
                        std::os::unix::fs::symlink(&target_path, &link_path)?;
                    }
                    out.push(LinkOutcome::Replaced);
                }
            }
        }
        Ok(out)
    }
}
