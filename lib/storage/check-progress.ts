// Shared client helper for reading the /api/v1/copy/check NDJSON stream. The
// check emits one `progress` frame per file/destination pair it examines and a
// final `result` frame; hashing a pair whose sidecars can't answer reads the
// whole file, so the frames are what keeps the UI honest about the wait.

import {readNdjson} from '@/lib/util/ndjson';

export interface CheckProgress {
  done: number;
  total: number;
  file: string;
  // True while both copies of `file` are being read to compare md5s — the slow
  // path, taken only when the sidecars have no usable SHA256 for them.
  hashing: boolean;
}

/**
 * What the Copy button says while a check runs. Counting pairs only becomes
 * meaningful once the first frame lands, and "Verifying" marks the stretch
 * that reads whole files — the one actually worth waiting through.
 */
export function checkStatusLabel(progress?: CheckProgress | null): string {
  if (!progress || progress.total === 0) return 'Checking…';
  const verb = progress.hashing ? 'Verifying' : 'Checking';
  const at = Math.min(progress.done + 1, progress.total);
  return `${verb} ${at}/${progress.total}…`;
}

/** One file that already exists at one destination, as the check reports it. */
export interface ConflictItem {
  file: string;
  destination: string; // "cold-storage" | peer address
  sourceSize: number;
  destSize: number;
  sizeMatch: boolean;
  // Which digest the two copies were compared with, and the result. The check
  // prefers the SHA256 both sidecars already record (no bytes read) and falls
  // back to md5-ing both copies; null means it couldn't compare at all — the
  // sizes differ, or one side offered no digest.
  digest: 'sha256' | 'md5' | null;
  digestMatch: boolean | null;
  sourceDigest: string | null;
  destDigest: string | null;
}

/**
 * Whether the destination's copy is provably the same file — the one case a
 * copy leaves alone by default, in the Copy button's conflict modal and in
 * `tj copy` alike. Anything the check couldn't compare (differing sizes, a
 * side with no digest) is not "identical" and is copied over.
 */
export function isIdenticalAtDestination(c: ConflictItem): boolean {
  return c.digestMatch === true;
}

/**
 * The skip list a copy sends for a set of conflicts, leaving alone every
 * destination copy that is provably the same file. This is what the conflict
 * modal starts the user off with, and what `tj copy` uses outright — a command
 * has nobody to ask, and re-sending a file that is already there is never the
 * more useful default.
 *
 * A pair, not a file: the same file can be identical on one destination and
 * missing from another, and only the first should be skipped.
 */
export function skipListFor(
  conflicts: ConflictItem[],
): Array<{file: string; destination: string}> {
  return conflicts
    .filter(isIdenticalAtDestination)
    .map((c) => ({file: c.file, destination: c.destination}));
}

export interface ConflictCheckResult<C, F> {
  conflicts: C[];
  files: F[];
}

type Frame<C, F> =
  | ({type: 'progress'} & CheckProgress)
  | ({type: 'result'} & ConflictCheckResult<C, F>);

/**
 * Read the check stream to completion, reporting progress as it goes. Resolves
 * with the final result, or null when the stream ended without one — which is
 * what an aborted check looks like from here.
 */
export async function readCheckStream<C, F>(
  res: Response,
  onProgress: (p: CheckProgress) => void,
): Promise<ConflictCheckResult<C, F> | null> {
  let result: ConflictCheckResult<C, F> | null = null;
  await readNdjson<Frame<C, F>>(res, (frame) => {
    if (frame.type === 'progress') {
      const {done, total, file, hashing} = frame;
      onProgress({done, total, file, hashing});
    } else if (frame.type === 'result') {
      result = {conflicts: frame.conflicts, files: frame.files};
    }
  });
  return result;
}
