// FLM (FastFlowLM, AMD NPU) models, as reported by a live Lemonade server.
// These never appear in the static server_models.json catalog: a Lemonade
// server discovers them at runtime by asking its local flm binary, and their
// checkpoints are flm tags (`qwen3.6-moe:35b-a3b`), not Hugging Face repos —
// so both listing and downloading go through that server's API (the per-peer
// `lemonade_url` config), never through the HF download path.

/** Where an flm tag's weights actually live: an ordinary HF repo (FastFlowLM
 *  org), often pinned to a revision, with the exact files a model needs —
 *  resolved from FastFlowLM's public registry (lib/lemonade/flm-registry). */
export interface FlmSource {
  repoId: string;
  revision: string; // 'main' when the registry doesn't pin one
  files: string[];
}

/** One FLM model on a Lemonade server, download state included. */
export interface FlmModel {
  name: string; // Lemonade model id, e.g. "gpt-oss-20b-FLM"
  checkpoint: string; // flm tag, e.g. "gpt-oss:20b" ('' when unreported)
  sizeGb: number; // declared size in decimal GB (0 when unreported)
  downloaded: boolean; // present in that server's FLM store
  labels: string[];
  // The HF source behind the tag, when the FastFlowLM registry names one —
  // enables downloading directly into Turbo Jumbo storage instead of asking
  // the Lemonade server to pull. Attached server-side by the flm route.
  source?: FlmSource;
}

/**
 * The FLM-recipe models of a Lemonade `GET /models?show_all=true` response.
 * Tolerant of malformed shapes — the payload comes from a live server of
 * whatever version — so unknown entries are skipped rather than fatal.
 */
export function parseFlmModels(payload: unknown): FlmModel[] {
  if (payload == null || typeof payload !== 'object') return [];
  const data = (payload as {data?: unknown}).data;
  if (!Array.isArray(data)) return [];
  const models: FlmModel[] = [];
  for (const raw of data) {
    if (raw == null || typeof raw !== 'object') continue;
    const e = raw as {
      id?: unknown;
      recipe?: unknown;
      checkpoint?: unknown;
      downloaded?: unknown;
      size?: unknown;
      labels?: unknown;
    };
    if (e.recipe !== 'flm') continue;
    if (typeof e.id !== 'string' || e.id === '') continue;
    models.push({
      name: e.id,
      checkpoint: typeof e.checkpoint === 'string' ? e.checkpoint : '',
      sizeGb: typeof e.size === 'number' ? e.size : 0,
      downloaded: e.downloaded === true,
      labels: Array.isArray(e.labels)
        ? e.labels.filter((l): l is string => typeof l === 'string')
        : [],
    });
  }
  return models;
}

/** A peer's Lemonade API base with the trailing slash normalized away. */
export function lemonadeApiBase(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * The headers every request to a peer's Lemonade server needs. A server
 * started with `LEMONADE_API_KEY` rejects anything without the matching
 * Bearer token — listing and pulling alike — so the key travels on each call.
 */
export function lemonadeHeaders(
  apiKey: string | undefined,
): Record<string, string> {
  return apiKey ? {Authorization: `Bearer ${apiKey}`} : {};
}

/** What to tell a user when the Lemonade server answered with an error
 *  status. A 401 means the server wants the key above, which is a config
 *  fix — worth saying outright rather than leaving as a bare status. */
export function lemonadeStatusMessage(status: number): string {
  return status === 401
    ? 'Lemonade server requires an API key — set lemonade_api_key for this peer in config.yaml'
    : `Lemonade server: HTTP ${status}`;
}

/** Lemonade's id for an flm tag: `:` becomes `-`, suffixed `-FLM`. */
export function lemonadeFlmId(tag: string): string {
  return `${tag.replaceAll(':', '-')}-FLM`;
}

/** An FLM model as Lemonade would list it, keyed by the repo that backs it —
 *  what lets the models table badge an FLM repo the way it badges a
 *  catalog-backed one, without asking a live server. */
export interface FlmCatalogEntry {
  name: string;
  checkpoint: string;
  repoId: string;
}

/** Every registry tag as a Lemonade-named model, sorted by name. */
export function flmCatalogEntries(
  registry: Map<string, FlmSource>,
): FlmCatalogEntry[] {
  return [...registry]
    .map(([tag, source]) => ({
      name: lemonadeFlmId(tag),
      checkpoint: tag,
      repoId: source.repoId,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether a lowercase filter needle finds an FLM model: by Lemonade's name,
 *  the flm tag, a label, or the repo behind it — the models table names the
 *  model by repo, so that is often what a person types. */
export function flmMatchesFilter(m: FlmModel, needle: string): boolean {
  return [m.name, m.checkpoint, ...m.labels, m.source?.repoId ?? ''].some((s) =>
    s.toLowerCase().includes(needle),
  );
}
