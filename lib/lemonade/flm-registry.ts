// FastFlowLM's public model registry: `src/model_list.json` in its GitHub
// repo maps every flm tag (`gemma3:1b`) to an ordinary Hugging Face repo in
// the FastFlowLM org — often pinned to a revision tag — plus the exact files
// a model needs. This is what `flm pull` itself downloads from, so Turbo
// Jumbo can fetch the same files directly through its regular HF pipeline.

import type {FlmSource} from '@/lib/lemonade/flm';
import {logger} from '@/lib/util/logger';

// The project moved to the ROCm org; the old FastFlowLM/FastFlowLM path still
// redirects, but this is where it lives now.
export const FLM_REGISTRY_URL =
  'https://raw.githubusercontent.com/ROCm/FastFlowLM/main/src/model_list.json';

/**
 * The HF repo and revision a registry `url` names. The url is either the bare
 * repo page or pinned via `/resolve/<rev>` or `/tree/<rev>`. Null for non-HF
 * hosts (the ModelScope mirrors) and malformed urls.
 */
export function parseFlmSourceUrl(
  url: string,
): {repoId: string; revision: string} | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== 'huggingface.co') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const repoId = `${parts[0]}/${parts[1]}`;
  if (
    parts.length >= 4 &&
    (parts[2] === 'resolve' || parts[2] === 'tree') &&
    parts[3]
  ) {
    return {repoId, revision: parts[3]};
  }
  return {repoId, revision: 'main'};
}

/**
 * Parse the registry into a map of flm tag (`family:size`) → HF source.
 * Tolerant of malformed shapes — the file is fetched from a moving branch
 * head — so unknown entries are skipped rather than fatal.
 */
export function parseFlmRegistry(payload: unknown): Map<string, FlmSource> {
  const out = new Map<string, FlmSource>();
  if (payload == null || typeof payload !== 'object') return out;
  const models = (payload as {models?: unknown}).models;
  if (models == null || typeof models !== 'object' || Array.isArray(models))
    return out;
  for (const [family, sizes] of Object.entries(models)) {
    if (sizes == null || typeof sizes !== 'object') continue;
    for (const [size, raw] of Object.entries(
      sizes as Record<string, unknown>,
    )) {
      if (raw == null || typeof raw !== 'object') continue;
      const e = raw as {url?: unknown; files?: unknown};
      if (typeof e.url !== 'string') continue;
      const source = parseFlmSourceUrl(e.url);
      if (!source) continue;
      out.set(`${family}:${size}`, {
        ...source,
        files: Array.isArray(e.files)
          ? e.files.filter((f): f is string => typeof f === 'string')
          : [],
      });
    }
  }
  return out;
}

/**
 * The files the registry says make a complete copy of `repoId` at `revision`,
 * or null when no entry names that repo at that revision with a file list.
 * Several tags sharing one repo and revision are unioned.
 *
 * This is the live definition, not the one recorded at download time: the
 * registry's lists change under existing copies (v0.9.28 dropped every
 * model's NPU `.xclbin` kernels, which FastFlowLM no longer fetches per
 * model), and a copy downloaded any other way records no list at all.
 */
export function flmRegistryFiles(
  registry: Map<string, FlmSource>,
  repoId: string,
  revision: string,
): string[] | null {
  const files = new Set<string>();
  for (const source of registry.values()) {
    if (source.repoId !== repoId || source.revision !== revision) continue;
    for (const f of source.files) files.add(f);
  }
  return files.size > 0 ? [...files] : null;
}

// The registry changes rarely; cache it like the HF repo trees. A failed
// fetch caches an empty map for the TTL rather than hammering GitHub — the
// callers then simply know no FLM sources until it is retried.
const REGISTRY_TTL_MS = 30 * 60 * 1000;
let registryCache: {map: Map<string, FlmSource>; fetchedAt: number} | null =
  null;

/** The registry, fetched at most once per TTL. */
export async function cachedFlmRegistry(): Promise<Map<string, FlmSource>> {
  if (registryCache && Date.now() - registryCache.fetchedAt < REGISTRY_TTL_MS)
    return registryCache.map;
  let map = new Map<string, FlmSource>();
  try {
    const res = await fetch(FLM_REGISTRY_URL, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) map = parseFlmRegistry(await res.json());
    else logger.warn(`[flm] registry fetch: HTTP ${res.status}`);
  } catch (e) {
    logger.warn(`[flm] registry fetch failed: ${String(e)}`);
  }
  registryCache = {map, fetchedAt: Date.now()};
  return map;
}
