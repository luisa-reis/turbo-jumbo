import type {Model} from '@/lib/models/model-types';

/** A file to copy, and where it should be read from. */
export interface SourceFile {
  path: string;
  /** `cold-storage`, or a peer address (possibly the local peer's own). */
  from: string;
  size: number;
}

export interface SourceIndex {
  get(path: string): {from: string; size: number} | undefined;
  entries(): Iterable<[string, {from: string; size: number}]>;
}

/**
 * Index every known copy of every file path, so a copy can be told where to
 * read each one from.
 *
 * Where a path exists in several places the **largest** copy wins. An
 * incomplete copy — a transfer truncated partway — must never be chosen as the
 * source for completing that same file elsewhere, since copying a shorter copy
 * over a longer one would simply be skipped and the file would stay broken.
 * Equal sizes keep the first indexed, which is why the caller's order matters:
 * cold storage first (a local mount, the cheapest source), then this machine,
 * then remote peers.
 *
 * Shared by the web UI's copy workflow and `tj copy`, so the two cannot
 * disagree about which copy of a file is authoritative.
 */
export function resolveSources(input: {
  cold?: Model[];
  local?: {address: string; models: Model[]};
  peers?: Array<{address: string; models: Model[]}>;
}): SourceIndex {
  const sources = new Map<string, {from: string; size: number}>();

  const record = (path: string, size: number, from: string) => {
    const prev = sources.get(path);
    if (!prev || size > prev.size) sources.set(path, {from, size});
  };

  const indexModels = (list: Model[], from: string) => {
    for (const m of list) {
      for (const f of m.files) {
        if (f.isSplit) {
          for (const shard of f.files) record(shard.path, shard.size, from);
        } else {
          record(f.path, f.size, from);
        }
      }
    }
  };

  if (input.cold) indexModels(input.cold, 'cold-storage');
  if (input.local) indexModels(input.local.models, input.local.address);
  for (const p of input.peers ?? []) {
    if (input.local && p.address === input.local.address) continue;
    indexModels(p.models, p.address);
  }

  return sources;
}

/**
 * Turn paths into copy sources, dropping any the index has never seen — a path
 * with no known copy anywhere cannot be a source, and passing it on would make
 * the server fail a file it was never able to read.
 */
export function buildSourceFiles(
  index: SourceIndex,
  paths: Iterable<string>,
): SourceFile[] {
  const out: SourceFile[] = [];
  for (const path of paths) {
    const entry = index.get(path);
    if (entry) out.push({path, from: entry.from, size: entry.size});
  }
  return out;
}

/**
 * Sources for a copy started from one location's tab: each path the location
 * holds is read from there, whatever its size elsewhere; any other path falls
 * back to `everywhere` (see `resolveSources`). The user picked the files on
 * that tab, so its copies are the ones meant — and "largest wins" would get an
 * updated file backwards when the update shrank it, copying the old version
 * from another machine instead of the new one from here. `at` is that
 * location's own index (`resolveSources` over just its models).
 */
export function preferLocation(
  at: SourceIndex,
  everywhere: SourceIndex,
): SourceIndex {
  const merged = new Map(everywhere.entries());
  for (const [path, entry] of at.entries()) merged.set(path, entry);
  return merged;
}
