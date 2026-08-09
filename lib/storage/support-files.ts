import {promises as fsp} from 'fs';
import nodePath from 'path';
import {isWeightFile} from '@/lib/models/weight-files';
import {MODEL_SIDECAR_NAME, TJMETA_SUFFIX} from '@/lib/models/sidecar-types';

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
 * Paths that escape `baseDir` or whose directory is gone yield nothing.
 */
export async function expandSupportFiles(
  baseDir: string,
  paths: string[],
): Promise<Array<{path: string; size: number}>> {
  const base = nodePath.resolve(baseDir);
  const known = new Set(paths);
  const dirs = new Set<string>();
  for (const p of paths) {
    const dir = nodePath.dirname(nodePath.resolve(base, p));
    if (dir.startsWith(base + nodePath.sep)) dirs.add(dir);
  }

  const out: Array<{path: string; size: number}> = [];
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, {withFileTypes: true});
    } catch {
      return; // gone or unreadable: nothing to expand
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = nodePath.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (isWeightFile(e.name)) continue;
      if (e.name === MODEL_SIDECAR_NAME || e.name.endsWith(TJMETA_SUFFIX))
        continue;
      const rel = nodePath.relative(base, full);
      if (known.has(rel)) continue;
      known.add(rel);
      try {
        out.push({path: rel, size: (await fsp.stat(full)).size});
      } catch {
        /* raced away between readdir and stat: skip */
      }
    }
  };
  for (const dir of dirs) await walk(dir);
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

/** Listing support files is a directory read, so a peer that hasn't answered
 *  by now is down rather than slow — and a copy must not wait on it. */
const PEER_LIST_TIMEOUT_MS = 10_000;

/** Ask a peer for the support files beside the given weight files. */
async function peerSupportFiles(
  addr: string,
  paths: string[],
): Promise<Array<{path: string; size: number}>> {
  const res = await fetch(`http://${addr}/api/v1/local-models/support-files`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({files: paths}),
    signal: AbortSignal.timeout(PEER_LIST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (
    ((await res.json()) as {files?: Array<{path: string; size: number}>})
      .files ?? []
  );
}

/**
 * Where to look for a copy's support files, in preference order: the sources
 * the copy already reads its weights from, then this host's cold storage and
 * local models — which routinely hold what the resolved source is missing.
 * Tiers this host hasn't configured are left out.
 */
export function supportFileSources(opts: {
  froms: Iterable<string>;
  coldBase: string;
  localBase: string;
  localPeerAddr: string;
  listPeer?: (
    addr: string,
    paths: string[],
  ) => Promise<Array<{path: string; size: number}>>;
}): SupportSource[] {
  const {coldBase, localBase, localPeerAddr} = opts;
  const listPeer = opts.listPeer ?? peerSupportFiles;
  const out: SupportSource[] = [];
  const seen = new Set<string>();

  const add = (from: string) => {
    if (!from || seen.has(from)) return;
    seen.add(from);
    if (from === 'cold-storage') {
      if (coldBase)
        out.push({from, list: (p) => expandSupportFiles(coldBase, p)});
    } else if (from === localPeerAddr) {
      if (localBase)
        out.push({from, list: (p) => expandSupportFiles(localBase, p)});
    } else {
      out.push({from, list: (p) => listPeer(from, p)});
    }
  };

  for (const from of opts.froms) add(from);
  add('cold-storage');
  add(localPeerAddr);
  return out;
}
