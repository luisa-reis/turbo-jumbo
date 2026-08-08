/**
 * Where the CLI sends its requests. Pure: every source is a parameter, so the
 * precedence is testable without an environment or a config file.
 */

const DEFAULT_URL = 'http://localhost:3000';

export interface UrlSources {
  /** `--url`, the explicit override. */
  flag?: string;
  /** `TJ_URL`. */
  env?: string;
  /**
   * `address` of the peer that is this machine, from config.yaml. Undefined on
   * a machine that isn't a peer — a laptop, say — which is a normal state, not
   * an error: `lib/config` leaves `localPeer` undefined rather than throwing.
   */
  localPeerAddress?: string;
}

/**
 * The server URL, first match winning: `--url`, then `TJ_URL`, then the local
 * peer's own address, then localhost. Bare `host:port` is accepted from the
 * config and the environment (that's the form config.yaml uses) and given an
 * `http://` scheme.
 */
export function resolveServerUrl(sources: UrlSources): string {
  const raw =
    firstNonEmpty(sources.flag, sources.env, sources.localPeerAddress) ??
    DEFAULT_URL;
  return withScheme(raw);
}

function firstNonEmpty(...values: Array<string | undefined>) {
  return values.find((v) => v != null && v.trim() !== '')?.trim();
}

function withScheme(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}
