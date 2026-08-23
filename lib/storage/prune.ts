/**
 * Removing a file can leave its directory — and its directory's directory —
 * with nothing in it. What every removal does about that lives here, so the
 * delete verb and a job's move agree on what "nothing" means.
 */

import {promises as fsp} from 'fs';
import nodePath from 'path';

/**
 * Remove directories left empty around `from` (a file that is now gone),
 * walking up towards — never onto — `stopAt`. A directory holding only the hf
 * CLI's `.cache` download bookkeeping counts as empty: that bookkeeping
 * belongs to files already gone, and keeping it would leave a husk the scans
 * keep tripping over.
 */
export async function pruneEmptyDirs(
  from: string,
  stopAt: string,
): Promise<void> {
  let dir = nodePath.dirname(from);
  const base = nodePath.resolve(stopAt);
  while (dir !== base && dir.startsWith(base + nodePath.sep)) {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return; // already gone or unreadable — nothing to prune
    }
    if (entries.length === 1 && entries[0] === '.cache') {
      await fsp.rm(nodePath.join(dir, '.cache'), {
        recursive: true,
        force: true,
      });
      entries = [];
    }
    if (entries.length > 0) return;
    try {
      await fsp.rmdir(dir);
    } catch {
      return; // e.g. a file appeared concurrently — leave it be
    }
    dir = nodePath.dirname(dir);
  }
}
