/**
 * `Storage` against this machine's own filesystem — what every peer does
 * today, behind the interface instead of in front of it.
 *
 * Roots are passed in rather than read from config, so a test can point one at
 * a temp directory and the production wiring stays in one place.
 */

import {promises as fsp} from 'fs';
import {statfs} from 'fs/promises';
import nodePath from 'path';
import {readSafetensorsDtype} from '@/lib/models/safetensors';
import {localSha256} from '@/lib/storage/file-transfer';
import {startCopyJob, startDownloadJob} from '@/lib/storage/local-jobs';
import {
  MAX_SMALL_FILE,
  type FileEntry,
  type JobHandle,
  type JobSpec,
  type LinkOutcome,
  type ListOptions,
  type Ref,
  type RemoveOptions,
  type Root,
  type Storage,
  type Usage,
} from '@/lib/storage/storage';

/** Absolute paths for the roots this machine has. A missing one is not an error
 *  until something asks for it — plenty of machines have no cold storage. */
export type Roots = Partial<Record<Root, string>>;

const SAFETENSORS = /\.safetensors$/i;

export function createLocalStorage(roots: Roots): Storage {
  // The inventory cache, in the two forms that can't go stale.
  //
  // Reading a safetensors header is the one expensive thing a walk does, and
  // the header of a file whose size and mtime haven't moved hasn't moved
  // either — so the dtype is remembered against both, and a walk re-reads
  // only what changed. Per root so a full walk can drop what it no longer
  // saw.
  //
  // Identical `list` calls in flight at once share one walk: a page load asks
  // for the same inventory from several places within the same second, and
  // each would otherwise walk the tree again. Nothing is kept once the walk
  // has answered — a cached inventory would have to know about every writer,
  // and the `hf` CLI, a peer's transfer and a user's shell are not among the
  // verbs here. A mutating verb forgets the root's in-flight walks, so a
  // caller listing after its own write never shares a walk that began
  // before it.
  type DtypeMemo = Map<string, {size: number; mtimeMs: number; dtype: string}>;
  const dtypeMemo = new Map<Root, DtypeMemo>();
  const inFlight = new Map<string, Promise<FileEntry[]>>();

  function forgetInFlight(root: Root): void {
    for (const key of inFlight.keys()) {
      if (key.startsWith(`${root}\0`)) inFlight.delete(key);
    }
  }

  function rootDir(root: Root): string {
    const dir = roots[root];
    if (!dir) throw new Error(`No ${root} directory is configured`);
    return dir;
  }

  /**
   * A `Ref` as an absolute path.
   *
   * Two checks, deliberately belt and braces: the segment rules reject the
   * paths that could escape, and the prefix check catches anything the rules
   * missed. A traversal bug here is the whole confinement story.
   */
  function resolve(ref: Ref): string {
    const dir = rootDir(ref.root);
    if (nodePath.isAbsolute(ref.path)) {
      throw new Error(`Path must be relative to its root: ${ref.path}`);
    }
    if (ref.path.split('/').some((seg) => seg === '..')) {
      throw new Error(`Path must not climb out of its root: ${ref.path}`);
    }
    const full = nodePath.resolve(dir, ref.path);
    const base = nodePath.resolve(dir);
    if (full !== base && !full.startsWith(base + nodePath.sep)) {
      throw new Error(`Path resolves outside its root: ${ref.path}`);
    }
    return full;
  }

  // Vanished-mid-walk is fine in any mode: a gone entry holds nothing. Every
  // other failure only passes in tolerant mode.
  const tolerable = (e: unknown, strict: boolean) =>
    !strict || (e instanceof Error && 'code' in e && e.code === 'ENOENT');

  async function walk(
    dir: string,
    rel: string,
    out: FileEntry[],
    opts: {
      dtype: boolean;
      strict: boolean;
      memo: DtypeMemo;
      seen: DtypeMemo;
    },
  ): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, {withFileTypes: true});
    } catch (e) {
      // A directory that vanished mid-walk, or one we may not read: the rest
      // of the inventory is still worth having — unless the caller asked for
      // the whole truth or nothing.
      if (tolerable(e, opts.strict)) return;
      throw e;
    }
    for (const entry of entries) {
      const full = nodePath.join(dir, entry.name);
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      let st;
      try {
        st = await fsp.lstat(full);
      } catch (e) {
        if (tolerable(e, opts.strict)) continue;
        throw e;
      }
      if (entry.isSymbolicLink()) {
        const link: FileEntry = {
          path,
          kind: 'symlink',
          size: 0,
          mtimeMs: st.mtimeMs,
          linkTarget: await fsp.readlink(full).catch(() => ''),
        };
        // Deliberately not descended into: Lemonade's extra directory is
        // symlinks pointing back into the models root, and following them
        // would report every weight twice. But the size is the target's —
        // what a link to a weight means to anyone asking.
        try {
          const target = await fsp.stat(full);
          link.size = target.size;
          link.mtimeMs = target.mtimeMs;
          if (target.isFile()) readDtype(link, full, opts);
        } catch {
          link.dangling = true;
        }
        out.push(link);
        continue;
      }
      if (entry.isDirectory()) {
        out.push({path, kind: 'dir', size: st.size, mtimeMs: st.mtimeMs});
        await walk(full, path, out, opts);
        continue;
      }
      const file: FileEntry = {
        path,
        kind: 'file',
        size: st.size,
        mtimeMs: st.mtimeMs,
      };
      readDtype(file, full, opts);
      out.push(file);
    }
  }

  /** Label a `.safetensors` entry with its dtype, from the memo when the file
   *  hasn't changed since it was last read, else from its header. */
  function readDtype(
    file: FileEntry,
    full: string,
    opts: {dtype: boolean; memo: DtypeMemo; seen: DtypeMemo},
  ): void {
    if (!opts.dtype || !SAFETENSORS.test(file.path)) return;
    const hit = opts.memo.get(full);
    if (hit && hit.size === file.size && hit.mtimeMs === file.mtimeMs) {
      file.dtype = hit.dtype;
      opts.seen.set(full, hit);
      return;
    }
    const dtype = readSafetensorsDtype(full);
    if (dtype) {
      file.dtype = dtype;
      opts.seen.set(full, {size: file.size, mtimeMs: file.mtimeMs, dtype});
    }
  }

  /**
   * Remove directories left empty by a removal, walking up towards the root.
   * A directory holding only the hf CLI's `.cache` download bookkeeping
   * counts as empty — that bookkeeping belongs to files already gone, and
   * keeping it would leave a husk the scans keep tripping over.
   */
  async function pruneUp(from: string, stopAt: string): Promise<void> {
    let dir = nodePath.dirname(from);
    const base = nodePath.resolve(stopAt);
    while (dir !== base && dir.startsWith(base + nodePath.sep)) {
      let entries: string[];
      try {
        entries = await fsp.readdir(dir);
      } catch {
        return; // already gone or unreadable — nothing to prune
      }
      if (entries.length === 1 && entries[0] === '.cache') {
        await fsp.rm(nodePath.join(dir, '.cache'), {
          recursive: true,
          force: true,
        });
        entries = [];
      }
      if (entries.length > 0) return;
      try {
        await fsp.rmdir(dir);
      } catch {
        return; // e.g. a file appeared concurrently — leave it be
      }
      dir = nodePath.dirname(dir);
    }
  }

  async function listUncached(
    root: Root,
    opts: ListOptions,
  ): Promise<FileEntry[]> {
    const dir = opts.under ? resolve({root, path: opts.under}) : rootDir(root);
    const memo = dtypeMemo.get(root) ?? new Map();
    const seen: DtypeMemo = new Map();
    const out: FileEntry[] = [];
    await walk(dir, opts.under ?? '', out, {
      dtype: opts.dtype ?? false,
      strict: opts.strict ?? false,
      memo,
      seen,
    });
    if (opts.dtype) {
      // A full walk saw every file there is, so what it didn't see is gone;
      // a partial one only adds to what's known.
      dtypeMemo.set(root, opts.under ? new Map([...memo, ...seen]) : seen);
    }
    return out;
  }

  return {
    async list(root: Root, opts: ListOptions = {}): Promise<FileEntry[]> {
      const key = [
        root,
        opts.under ?? '',
        opts.dtype ? 1 : 0,
        opts.strict ? 1 : 0,
      ].join('\0');
      let pending = inFlight.get(key);
      if (!pending) {
        pending = listUncached(root, opts).finally(() => {
          if (inFlight.get(key) === pending) inFlight.delete(key);
        });
        inFlight.set(key, pending);
      }
      // Each caller gets its own array: two of them mutating one shared
      // inventory would be a very quiet bug.
      return [...(await pending)];
    },

    async read(ref: Ref): Promise<Uint8Array> {
      const full = resolve(ref);
      const st = await fsp.stat(full);
      if (st.size > MAX_SMALL_FILE) {
        throw new Error(
          `${ref.path} is ${st.size} bytes; read is for small files only`,
        );
      }
      return new Uint8Array(await fsp.readFile(full));
    },

    async write(ref: Ref, bytes: Uint8Array): Promise<void> {
      if (bytes.byteLength > MAX_SMALL_FILE) {
        throw new Error(
          `${ref.path} is ${bytes.byteLength} bytes; write is for small files only`,
        );
      }
      forgetInFlight(ref.root);
      const full = resolve(ref);
      await fsp.mkdir(nodePath.dirname(full), {recursive: true});
      await fsp.writeFile(full, bytes);
    },

    async mkdir(ref: Ref): Promise<void> {
      forgetInFlight(ref.root);
      await fsp.mkdir(resolve(ref), {recursive: true});
    },

    async remove(refs: Ref[], opts: RemoveOptions = {}): Promise<void> {
      for (const ref of refs) forgetInFlight(ref.root);
      for (const ref of refs) {
        const full = resolve(ref);
        await fsp.rm(full, {recursive: true, force: true});
        if (opts.pruneEmptyDirs) await pruneUp(full, rootDir(ref.root));
      }
    },

    async move(from: Ref, to: Ref): Promise<void> {
      forgetInFlight(from.root);
      forgetInFlight(to.root);
      const src = resolve(from);
      const dst = resolve(to);
      await fsp.mkdir(nodePath.dirname(dst), {recursive: true});
      try {
        await fsp.rename(src, dst);
      } catch (e) {
        // Two roots need not share a filesystem (cold storage is usually a
        // different disk or a NAS): a rename that can't cross is a copy and
        // a delete.
        if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
        await fsp.copyFile(src, dst);
        await fsp.unlink(src);
      }
    },

    async copy(from: Ref, to: Ref): Promise<void> {
      forgetInFlight(to.root);
      const dst = resolve(to);
      await fsp.mkdir(nodePath.dirname(dst), {recursive: true});
      await fsp.copyFile(resolve(from), dst);
    },

    async link(
      links: Array<{target: Ref; at: Ref}>,
      opts: {dryRun?: boolean} = {},
    ): Promise<LinkOutcome[]> {
      if (!opts.dryRun) for (const {at} of links) forgetInFlight(at.root);
      const out: LinkOutcome[] = [];
      for (const {target, at} of links) {
        const linkPath = resolve(at);
        const targetPath = resolve(target);
        let present = false;
        let current: string | null = null; // readlink, when it is a symlink
        try {
          const st = await fsp.lstat(linkPath);
          present = true;
          if (st.isSymbolicLink())
            current = await fsp.readlink(linkPath).catch(() => '');
        } catch {
          /* nothing there yet */
        }
        if (!present) {
          if (!opts.dryRun) {
            await fsp.mkdir(nodePath.dirname(linkPath), {recursive: true});
            await fsp.symlink(targetPath, linkPath);
          }
          out.push('created');
        } else if (current === null) {
          // A real file. Somebody's own model — never replaced with a link.
          out.push('skipped');
        } else if (current === targetPath) {
          out.push('kept');
        } else {
          // Replace rather than fail: a link pointing at the wrong target is
          // exactly what a sync run exists to correct.
          if (!opts.dryRun) {
            await fsp.rm(linkPath, {force: true});
            await fsp.symlink(targetPath, linkPath);
          }
          out.push('replaced');
        }
      }
      return out;
    },

    hash(
      ref: Ref,
      opts: {signal?: AbortSignal; onBytes?: (n: number) => void} = {},
    ): Promise<string> {
      return localSha256(resolve(ref), opts.signal, opts.onBytes);
    },

    async start(spec: JobSpec): Promise<JobHandle> {
      switch (spec.kind) {
        case 'download':
          forgetInFlight(spec.into.root);
          return startDownloadJob(spec, resolve);
        case 'copy':
          forgetInFlight(spec.to.root);
          if (spec.move) forgetInFlight(spec.from.root);
          return startCopyJob(spec, resolve);
      }
    },

    async usage(root: Root): Promise<Usage> {
      const dir = rootDir(root);
      const [s, st] = await Promise.all([statfs(dir), fsp.stat(dir)]);
      // bavail, not bfree: the space actually usable, which is what a download
      // will be allowed to write.
      return {
        free: s.bsize * s.bavail,
        total: s.bsize * s.blocks,
        device: String(st.dev),
      };
    },
  };
}
