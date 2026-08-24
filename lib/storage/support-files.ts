import nodePath from 'path';
import {isWeightFile} from '@/lib/models/weight-files';
import {MODEL_SIDECAR_NAME, TJMETA_SUFFIX} from '@/lib/models/sidecar-types';
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
 * Each support file is therefore taken from whichever source actually has it,
 * with the **largest** copy winning and ties keeping the earlier source —
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
  opts: {onError?: (from: string, message: string) => void} = {},
): Promise<Array<{path: string; from: string; size: number}>> {
  const carried = new Set(paths);
  const best = new Map<string, {from: string; size: number}>();

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
      if (!prev || f.size > prev.size)
        best.set(f.path, {from: source.from, size: f.size});
    }
  }

  return [...best]
    .map(([path, {from, size}]) => ({path, from, size}))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Where to look for a copy's support files, in preference order: the sources
 * the copy already reads its weights from, then cold storage and the local
 * models — which routinely hold what the resolved source is missing. Every
 * source is one `expandSupportFiles` over its site, a remote peer's models
 * included — the same directory listing whichever machine holds it. A tier
 * `siteFor` can't reach (null) is simply not asked.
 */
export function supportFileSources(opts: {
  froms: Iterable<string>;
  localPeerAddr: string;
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
  return out;
}
