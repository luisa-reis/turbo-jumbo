import nodePath from 'path';
import {isWeightFile} from '@/lib/models/weight-files';
import {MODEL_SIDECAR_NAME, TJMETA_SUFFIX} from '@/lib/models/sidecar-types';
import {modelRevision} from '@/lib/models/model-sidecar';
import {repoTree} from '@/lib/models/repo-files';
import {siteStorage, type Site} from '@/lib/storage/site';

/**
 * The support files that must travel with the given weight files: everything
 * else on disk in the same model directories — config.json, tokenizer files,
 * a safetensors index — without which a whole-repo model's copy can't be
 * loaded. The weight scan (and so the copy selection) only tracks weight
 * files, so a copy built from selected paths alone would strand these.
 *
 * Excluded: other weight files (a selection of one quant must not drag its
 * siblings along), sidecars (`tjmodel.json`, `*.tjmeta.json` — the copy's
 * meta-propagation channel owns those), and dot-entries (`.cache/…`).
 * Paths that escape the root or whose directory is gone yield nothing.
 */
export async function expandSupportFiles(
  site: Site,
  paths: string[],
): Promise<Array<{path: string; size: number}>> {
  const {storage, root} = siteStorage(site);
  const known = new Set(paths);
  const dirs = new Set<string>();
  for (const p of paths) {
    const dir = nodePath.posix.dirname(nodePath.posix.normalize(p));
    if (dir === '.' || dir === '' || nodePath.posix.isAbsolute(dir)) continue;
    if (dir.split('/').some((seg) => seg === '..')) continue;
    dirs.add(dir);
  }

  const out: Array<{path: string; size: number}> = [];
  for (const dir of dirs) {
    // Tolerant list: a directory that is gone or unreadable expands to
    // nothing, same as the walk it replaces.
    const entries = await storage.list(root, {under: dir});
    for (const e of entries) {
      if (e.kind !== 'file') continue;
      // Dot-entries at any depth below the model dir stay out (.cache/…).
      const below = e.path.slice(dir.length + 1);
      if (below.split('/').some((seg) => seg.startsWith('.'))) continue;
      const name = e.path.split('/').pop() ?? '';
      if (isWeightFile(name)) continue;
      if (name === MODEL_SIDECAR_NAME || name.endsWith(TJMETA_SUFFIX)) continue;
      if (known.has(e.path)) continue;
      known.add(e.path);
      out.push({path: e.path, size: e.size});
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** One place a copy can read support files from, and how to list them there. */
export interface SupportSource {
  /** `cold-storage`, or a peer address. */
  from: string;
  list: (paths: string[]) => Promise<Array<{path: string; size: number}>>;
}

/** A model-relative path, safe to join onto any base. Peers answer these over
 *  HTTP, so an absolute or climbing path must never reach a write. */
function isContainedPath(p: string): boolean {
  if (!p || nodePath.isAbsolute(p)) return false;
  const norm = nodePath.normalize(p);
  return norm !== '..' && !norm.startsWith('..' + nodePath.sep);
}

/**
 * The support files a copy of `paths` must carry, looked for in **every** place
 * that might hold them rather than only where the weights are read from.
 *
 * A model's weights and its support files need not sit in the same tier.
 * `resolveSources` gives each weight file exactly one source and prefers cold
 * storage (the cheapest to read), so every file of a model that has been
 * archived resolves to cold storage — and an archive written before support
 * files travelled at all holds the weights alone. Asking only that one source
 * expanded to nothing, and the copy carried bare weights: no config.json, no
 * tokenizer, no safetensors index, so the model could not be loaded at the
 * destination.
 *
 * Each support file is therefore taken from whichever source actually has it.
 * A copy whose size matches Hugging Face's (`expectedSize`) wins: support files
 * are small and do change upstream — a repo's tokenizer_config.json rewritten
 * — and a copy made before that is the wrong one to spread, whatever its size.
 * Otherwise the **largest** copy wins, ties keeping the earlier source —
 * matching `resolveSources`, and for the same reason: a truncated copy would be
 * skipped as "already there" at the destination and leave the file broken.
 *
 * Sources are best effort. One that throws (an unreachable peer, a cold mount
 * that went away) is reported through `onError` and skipped, because the
 * copy it is holding up is still worth making.
 */
export async function resolveSupportFiles(
  paths: string[],
  sources: SupportSource[],
  opts: {
    onError?: (from: string, message: string) => void;
    /** Hugging Face's size for a path, when known. */
    expectedSize?: (path: string) => number | undefined;
  } = {},
): Promise<Array<{path: string; from: string; size: number}>> {
  const carried = new Set(paths);
  const best = new Map<string, {from: string; size: number}>();
  const beats = (path: string, size: number, prev: {size: number}) => {
    const want = opts.expectedSize?.(path);
    if (want !== undefined && (size === want) !== (prev.size === want))
      return size === want;
    return size > prev.size;
  };

  for (const source of sources) {
    let extra: Array<{path: string; size: number}>;
    try {
      extra = await source.list(paths);
    } catch (e) {
      opts.onError?.(source.from, e instanceof Error ? e.message : String(e));
      continue;
    }
    for (const f of extra ?? []) {
      if (typeof f?.path !== 'string' || typeof f?.size !== 'number') continue;
      if (carried.has(f.path) || !isContainedPath(f.path)) continue;
      const prev = best.get(f.path);
      if (!prev || beats(f.path, f.size, prev))
        best.set(f.path, {from: source.from, size: f.size});
    }
  }

  return [...best]
    .map(([path, {from, size}]) => ({path, from, size}))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Where to look for a copy's support files, in preference order: the sources
 * the copy already reads its weights from, then cold storage, the local
 * models, and every other peer — any of which may hold what the resolved
 * source is missing, or the one copy that is current. Every source is one
 * `expandSupportFiles` over its site, a remote peer's models included — the
 * same directory listing whichever machine holds it. A tier `siteFor` can't
 * reach (null) is simply not asked.
 */
export function supportFileSources(opts: {
  froms: Iterable<string>;
  localPeerAddr: string;
  /** The other peers' addresses, asked last. */
  peers?: Iterable<string>;
  /** The site a source name reads from; null for an unreachable tier. */
  siteFor: (from: string) => Site | null;
}): SupportSource[] {
  const out: SupportSource[] = [];
  const seen = new Set<string>();

  const add = (from: string) => {
    if (!from || seen.has(from)) return;
    seen.add(from);
    const site = opts.siteFor(from);
    if (site) out.push({from, list: (p) => expandSupportFiles(site, p)});
  };

  for (const from of opts.froms) add(from);
  add('cold-storage');
  add(opts.localPeerAddr);
  for (const peer of opts.peers ?? []) add(peer);
  return out;
}

/** How long a copy waits on Hugging Face for a repo's file sizes before
 *  choosing support files by size alone. */
const HF_SIZES_TIMEOUT_MS = 10_000;

/**
 * Hugging Face's size for every file of the repos `files` belong to, at the
 * revision each model tracks (read from the sidecar where its first file is
 * copied from). Best effort: a repo HF can't answer for — offline, gated,
 * not an HF repo at all — contributes nothing, and the choice falls back to
 * the largest copy.
 */
export async function hfFileSizes(
  files: Array<{path: string; from: string}>,
  siteFor: (from: string) => Site | null,
): Promise<(path: string) => number | undefined> {
  const repos = new Map<string, string>(); // repoId → a source holding it
  for (const f of files) {
    const [org, repo] = f.path.split('/');
    if (!org || !repo || f.path.split('/').length < 3) continue;
    const id = `${org}/${repo}`;
    if (!repos.has(id)) repos.set(id, f.from);
  }
  const sizes = new Map<string, number>();
  const signal = AbortSignal.timeout(HF_SIZES_TIMEOUT_MS);
  await Promise.all(
    [...repos].map(async ([repoId, from]) => {
      try {
        const site = siteFor(from);
        const revision = site ? await modelRevision(site, repoId) : 'main';
        for (const f of await repoTree(repoId, revision, signal))
          sizes.set(`${repoId}/${f.path}`, f.size);
      } catch {
        // No answer for this repo: its support files go by size alone.
      }
    }),
  );
  return (path) => sizes.get(path);
}

/**
 * The support files a copy of `files` carries (see `resolveSupportFiles`),
 * looked for across every source `supportFileSources` names and chosen by
 * Hugging Face's sizes where it can say. The one entry point for the copy
 * route and its conflict check, so both expand a selection the same way.
 */
export async function copySupportFiles(
  files: Array<{path: string; from: string}>,
  opts: {
    localPeerAddr: string;
    peers: Iterable<string>;
    siteFor: (from: string) => Site | null;
    onError?: (from: string, message: string) => void;
  },
): Promise<Array<{path: string; from: string; size: number}>> {
  const paths = files.map((f) => f.path);
  const sources = supportFileSources({
    froms: files.map((f) => f.from),
    localPeerAddr: opts.localPeerAddr,
    peers: opts.peers,
    siteFor: opts.siteFor,
  });
  const expectedSize = await hfFileSizes(files, opts.siteFor);
  return resolveSupportFiles(paths, sources, {
    onError: opts.onError,
    expectedSize,
  });
}
