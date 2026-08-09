/**
 * Requests to a running Turbo Jumbo server. The CLI is an API client rather
 * than a second implementation, so everything it reports comes from the same
 * code the web UI uses (see docs/specs/2026-08-08-tj-cli-phase-1-design.md).
 */

import {NO_DIAGNOSTICS, type Diagnostics} from '@/lib/cli/verbosity';

/** An error already phrased for the user; the entry point prints it bare. */
export class CliError extends Error {}

/**
 * A CliError the user fixes by typing the command differently — a missing
 * argument, a flag the command can't run without. Exits 2, so a caller can
 * tell "you asked for this wrong" from "I tried and the world said no".
 */
export class UsageError extends CliError {}

export interface Client {
  /** GET and parse, or fail the command. */
  json<T>(path: string): Promise<T>;
  /** GET and parse, or null — for probes where "no answer" is itself data. */
  tryJson<T>(path: string): Promise<T | null>;
  readonly baseUrl: string;
}

export function createClient(
  baseUrl: string,
  diag: Diagnostics = NO_DIAGNOSTICS,
): Client {
  const get = async (path: string) => {
    diag.write(2, `GET ${baseUrl}${path}`);
    const started = performance.now();
    const res = await fetch(`${baseUrl}${path}`);
    const ms = Math.round(performance.now() - started);
    diag.write(2, `  ${res.status} ${res.statusText} in ${ms}ms`);
    return res;
  };

  return {
    baseUrl,

    async json<T>(path: string): Promise<T> {
      let res: Response;
      try {
        res = await get(path);
      } catch (e) {
        // Nothing can be answered at all, so say where we tried and why —
        // "fetch failed" alone sends people looking in the wrong place.
        throw new CliError(
          `Cannot reach the Turbo Jumbo server at ${baseUrl} ` +
            `(${e instanceof Error ? e.message : String(e)}).\n` +
            `Is it running? Override with --url or TJ_URL.`,
        );
      }
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).trim();
        throw new CliError(
          `${baseUrl}${path} returned ${res.status} ${res.statusText}` +
            (body ? `: ${body}` : ''),
        );
      }
      if (!diag.enabled(3)) return (await res.json()) as T;
      // Only read it as text when someone asked to see it: the body of a
      // models listing is large, and parsing it twice would be the cost of
      // a level nobody turned on.
      const body = await res.text();
      diag.write(3, body);
      return JSON.parse(body) as T;
    },

    async tryJson<T>(path: string): Promise<T | null> {
      try {
        const res = await get(path);
        return res.ok ? ((await res.json()) as T) : null;
      } catch {
        return null;
      }
    },
  };
}
