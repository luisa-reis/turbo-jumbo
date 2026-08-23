/**
 * Answers about one path, from the inventory verb.
 *
 * `Storage` has no `stat`: `list` is the only traversal, and a caller that
 * wants to know what sits at a path lists the directory around it. Cheap
 * for a model directory — tens of entries — and honest about what a path at
 * the root costs, which is the root.
 */

import type {FileEntry, Root, Storage} from '@/lib/storage/storage';

/** The directory part of a root-relative path; `''` for the root itself. */
export function parentDir(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i < 0 ? '' : relPath.slice(0, i);
}

/**
 * The entry at `relPath` — a file, a directory or a symlink — or null when
 * nothing is there. A missing parent directory is simply nothing there too.
 */
export async function entryAt(
  storage: Storage,
  root: Root,
  relPath: string,
): Promise<FileEntry | null> {
  const dir = parentDir(relPath);
  const entries = await storage.list(root, dir ? {under: dir} : {});
  return entries.find((e) => e.path === relPath) ?? null;
}

/**
 * What sits under `dir`, by path — dangling links left out, as following
 * them would find nothing. A directory that isn't there is an empty map.
 */
export async function entriesUnder(
  storage: Storage,
  root: Root,
  dir: string,
): Promise<Map<string, FileEntry>> {
  const out = new Map<string, FileEntry>();
  for (const e of await storage.list(root, dir ? {under: dir} : {})) {
    if (!e.dangling) out.set(e.path, e);
  }
  return out;
}

/**
 * The size of the file at `relPath`, or null when there is no file there. A
 * symlink answers with its target's size; a dangling one has no file behind
 * it and is null.
 */
export async function fileSize(
  storage: Storage,
  root: Root,
  relPath: string,
): Promise<number | null> {
  const e = await entryAt(storage, root, relPath);
  if (!e || e.kind === 'dir' || e.dangling) return null;
  return e.size;
}
