import type {Model} from '@/lib/models/model-types';
import {
  fileBasename,
  fileJoinKey,
  fileSizesByKey,
} from '@/lib/peers/peer-paths';

/**
 * Which of a repo's Hugging Face files the target machine already holds in cold
 * storage, as repo-relative paths.
 *
 * Freeing space by archiving a quantization to cold storage leaves the picker
 * offering to fetch it from Hugging Face again — many gigabytes to re-download
 * something already on a disk in the same building. Marking those files lets
 * that be spotted before starting, and lets a partly-archived set be finished
 * one file at a time.
 *
 * Matching reuses the join the copy workflow already uses (`fileJoinKey`):
 * basename, since two hosts derive model names differently and the same file
 * can be named for its repo on one and its filename on the other — except for
 * generic and mmproj basenames, which recur across repos and are therefore
 * qualified by model name. A cold copy counts only when it is at least the size
 * HF reports; a smaller one is an interrupted transfer that must stay
 * re-fetchable rather than read as done.
 */
export function coldStoredPaths(
  coldModels: Model[],
  repoId: string,
  files: Array<{path: string; size: number}>,
): Set<string> {
  const coldSizes = fileSizesByKey(coldModels);
  const present = new Set<string>();
  for (const f of files) {
    const coldSize = coldSizes.get(fileJoinKey(repoId, fileBasename(f.path)));
    if (coldSize !== undefined && coldSize >= f.size) present.add(f.path);
  }
  return present;
}
