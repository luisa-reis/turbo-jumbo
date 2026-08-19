import nodePath from 'path';
import {readModelSidecar} from '@/lib/models/model-sidecar';
import {MODEL_SIDECAR_NAME} from '@/lib/models/sidecar-types';
import {siteStorage, type Site} from '@/lib/storage/site';

/**
 * The SHA256 a model's sidecar already recorded for one of its files, when
 * that record can still be trusted — so a comparison between two copies can
 * answer from `tjmodel.json` instead of re-reading gigabytes through the
 * slowest disk in the system.
 *
 * Trust is deliberately narrow. The record is used only when the file's size
 * still matches the recorded `computedSize` (a truncated or resumed copy
 * changes it) and the file has not been written since the sidecar was (its
 * mtime is not newer). Anything else — no sidecar, no recorded hash (a
 * Lemonade-consolidated model records none), a missing file — returns null,
 * and the caller falls back to hashing the bytes.
 *
 * `relPath` is relative to the site's root; the sidecar is looked up in the
 * model directory containing the file, and one list of that directory
 * supplies both the file's and the sidecar's size and mtime.
 */
export async function recordedSha256(
  site: Site,
  relPath: string,
): Promise<string | null> {
  const {storage, root} = siteStorage(site);
  if (!relPath || nodePath.posix.isAbsolute(relPath)) return null;

  let dir = nodePath.posix.dirname(relPath);
  while (dir && dir !== '.' && dir !== '/') {
    const model = await readModelSidecar(site, dir);
    if (model) {
      const key = nodePath.posix.relative(dir, relPath);
      const entry = model.files.find((f) => f.path === key);
      if (!entry?.computedSha256) return null;
      const entries = await storage.list(root, {under: dir});
      const file = entries.find((e) => e.path === relPath && e.kind === 'file');
      if (!file) return null;
      if (entry.computedSize !== file.size) return null;
      const sidecar = entries.find(
        (e) => e.path === `${dir}/${MODEL_SIDECAR_NAME}`,
      );
      if (!sidecar) return null;
      if (file.mtimeMs > sidecar.mtimeMs) return null;
      return entry.computedSha256;
    }
    dir = nodePath.posix.dirname(dir);
  }
  return null;
}
