import {logger} from '@/lib/util/logger';

/**
 * Telling Lemonade about links the sync just made in flm's store.
 *
 * Lemonade builds its model list once and keeps it until one of its own
 * actions invalidates it — a pull, a backend install, a config change — so a
 * directory that appeared in flm's store from outside stays "not downloaded"
 * until then. The cheapest of those actions is a pull of a model flm already
 * finds installed: it completes at once with nothing to download, and the
 * rebuild it triggers re-runs `flm list` for every model, linked ones
 * included. One such pull refreshes the whole list.
 *
 * The guard matters: a pull flm does *not* consider installed would download,
 * and with the store entry a link into Turbo Jumbo's copy, it would write
 * through that link. So the stream is watched and the request dropped the
 * moment a byte is asked for — Lemonade treats a closed request as a cancel.
 */

export interface FlmRefresh {
  ok: boolean;
  message?: string;
}

/** Frames carry either `bytes_downloaded` or a `total_download_size`; either
 *  above zero means flm is fetching rather than confirming. */
function wantsBytes(data: Record<string, unknown>): boolean {
  const n = (k: string) =>
    typeof data[k] === 'number' ? (data[k] as number) : 0;
  return n('bytes_downloaded') > 0 || n('total_download_size') > 0;
}

export async function refreshLemonadeFlm(
  apiBase: string,
  headers: Record<string, string>,
  modelId: string,
  opts: {timeoutMs?: number} = {},
): Promise<FlmRefresh> {
  const abort = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, timeoutMs);
  try {
    const res = await fetch(`${apiBase}/pull`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', ...headers},
      body: JSON.stringify({model: modelId, stream: true}),
      signal: abort.signal,
    });
    if (!res.ok || !res.body)
      return {ok: false, message: `Lemonade server: HTTP ${res.status}`};
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      buf += dec.decode(value, {stream: true});
      const frames = buf.split('\n\n');
      buf = frames.pop() ?? '';
      for (const frame of frames) {
        let event = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (event === 'error' || typeof payload.error === 'string')
          return {
            ok: false,
            message:
              typeof payload.error === 'string' ? payload.error : 'pull failed',
          };
        if (wantsBytes(payload)) {
          abort.abort();
          return {
            ok: false,
            message: `flm wanted to download ${modelId} rather than use the link; the pull was cancelled before it wrote anything`,
          };
        }
        if (event === 'complete') return {ok: true};
      }
    }
    return {ok: false, message: 'pull ended without completing'};
  } catch (e) {
    const message = timedOut
      ? `Lemonade's pull of ${modelId} did not finish within ${Math.round(timeoutMs / 1000)}s`
      : e instanceof Error
        ? e.message
        : String(e);
    logger.warn(`[lemonade-flm-refresh] ${modelId}: ${message}`);
    return {ok: false, message};
  } finally {
    clearTimeout(timer);
  }
}

/** Lemonade's id for an flm tag: `:` becomes `-`, suffixed `-FLM`. */
export function lemonadeFlmId(tag: string): string {
  return `${tag.replaceAll(':', '-')}-FLM`;
}
