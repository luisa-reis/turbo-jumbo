import {repoFileSizes} from '@/lib/hf/hf-infer';
import {fileSize} from '@/lib/storage/entries';
import type {Storage} from '@/lib/storage/storage';
import {formatSize} from '@/lib/format/bytes';

/**
 * The bytes a download of `filePaths` still has to write: each file's
 * Hugging Face size, unless the copy already at its destination is that
 * size. A stale or partial copy counts in full — `hf` writes a fresh file
 * beside it and only then replaces it, so the old one frees nothing until
 * the new one is down. A file whose size HF didn't give is left out.
 */
export function bytesNeeded(
  filePaths: string[],
  sizes: Map<string, number>,
  onDisk: Map<string, number | null>,
): number {
  let need = 0;
  for (const fp of filePaths) {
    const expected = sizes.get(fp);
    if (expected === undefined) continue;
    if (onDisk.get(fp) === expected) continue;
    need += expected;
  }
  return need;
}

/**
 * Why a download of `filePaths` from `repoId` into `<models>/<repoId>` can't
 * fit, or null when it can — or when there's no telling (HF unreachable, the
 * storage can't report its usage). Checked before `hf` starts, so a download
 * that would fill the disk fails at once instead of an hour in, with `hf`'s
 * opaque writer error.
 */
export async function downloadSpaceProblem(
  storage: Storage,
  repoId: string,
  branch: string,
  filePaths: string[],
): Promise<string | null> {
  try {
    const sizes = await repoFileSizes(repoId, branch);
    if (!sizes) return null;
    const onDisk = new Map<string, number | null>();
    await Promise.all(
      filePaths.map(async (fp) =>
        onDisk.set(fp, await fileSize(storage, 'models', `${repoId}/${fp}`)),
      ),
    );
    const need = bytesNeeded(filePaths, sizes, onDisk);
    if (need === 0) return null;
    const {free} = await storage.usage('models');
    if (need <= free) return null;
    return (
      `Not enough free space: this download needs ${formatSize(need)}, ` +
      `and only ${formatSize(free)} is free. Free up ` +
      `${formatSize(need - free)} or more and try again.`
    );
  } catch {
    return null; // no telling: let hf try
  }
}
