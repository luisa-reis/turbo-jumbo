/**
 * How much `tj` says while it works.
 *
 * One dial, not two flags: --silent, the default, -v, -vv, -vvv. Everything it
 * controls goes to stderr, and none of it changes stdout — `-vvv
 * --output-format json` prints exactly the JSON that plain --output-format
 * json prints, or a script could not turn the noise up to debug itself.
 */

export const SILENT = -1;
export const MAX_VERBOSITY = 3;

/** -1 errors only · 0 results and warnings · 1-3 progressively more detail. */
export type Verbosity = -1 | 0 | 1 | 2 | 3;

export type VerbosityResult =
  {ok: true; value: Verbosity} | {ok: false; error: string};

/**
 * The level a run should use.
 *
 * Asking to be quiet and loud at once is a usage error rather than a
 * last-one-wins guess: you cannot stand at two points on one dial, and in
 * practice it means a wrapper and its caller are each appending a flag with
 * no idea the other exists. Guessing would hide that; saying so fixes it.
 *
 * Extra `v`s clamp instead of failing, as ssh's do — `-vvvvv` is someone
 * leaning on the key, not someone to be corrected.
 */
export function resolveVerbosity(opts: {
  verbose: number;
  silent: boolean;
}): VerbosityResult {
  if (opts.silent && opts.verbose > 0) {
    return {
      ok: false,
      error:
        '--silent and --verbose are the same dial, so only one can be set.\n' +
        'Drop whichever one you did not mean.',
    };
  }
  if (opts.silent) return {ok: true, value: SILENT};
  const level = Math.min(opts.verbose, MAX_VERBOSITY);
  return {ok: true, value: level as Verbosity};
}

export interface Diagnostics {
  /** Write a line, if the run asked for that much detail. */
  write(level: 1 | 2 | 3, message: string): void;
  /** Whether that level is being printed — for detail costly to gather. */
  enabled(level: 1 | 2 | 3): boolean;
}

/**
 * Diagnostics tagged with the level that produced them, the way ssh tags its
 * own — so `2>&1 | grep debug1` is a way to read them, and it is always
 * obvious why any given line appeared.
 */
export function createDiagnostics(
  level: Verbosity,
  write: (line: string) => void,
): Diagnostics {
  return {
    enabled: (at) => at <= level,
    write(at, message) {
      if (at > level) return;
      for (const line of message.split('\n')) write(`debug${at}: ${line}\n`);
    },
  };
}

/** Diagnostics that go nowhere, for callers that don't want any. */
export const NO_DIAGNOSTICS: Diagnostics = {
  write: () => {},
  enabled: () => false,
};
