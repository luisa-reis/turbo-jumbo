import path from 'path';
import {pathImpliedRepo} from '@/lib/audit/audit-verdict';
import {parseHubCachePath} from '@/lib/hf/hf-cache';
import {repoIdFromModelUrl} from '@/lib/models/model-name';
import {modelDirForRepo, removeFileMeta} from '@/lib/models/model-sidecar';
import {metaPath, readMetaResolved} from '@/lib/models/tjmeta';
import {isWeightFile} from '@/lib/models/weight-files';
import type {Root, Storage} from '@/lib/storage/storage';

/**
 * Delete a model file along with its provenance records, then prune the
 * directories the deletion emptied: the file's entry leaves its model sidecar
 * (`tjmodel.json`, which `removeFileMeta` deletes outright when no entries
 * remain), a legacy per-file `.tjmeta.json` is removed, and every ancestor
 * directory left empty — or holding only the hf CLI's `.cache` download
 * bookkeeping — is removed by the storage's prune. So deleting a model's last
 * file removes the whole directory husk instead of leaving a ghost the audit
 * and Lemonade sync would keep tripping over.
 *
 * `basePath` is transitional: the sidecar helpers still speak absolute paths,
 * and it leaves this signature when `tjmeta.ts`/`model-sidecar.ts` migrate to
 * the `Storage` interface.
 */
export async function deleteFileWithMeta(
  storage: Storage,
  root: Root,
  basePath: string,
  relPath: string,
): Promise<void> {
  // Read provenance before deleting — it names the sidecar that owns the file.
  const meta = await readMetaResolved(basePath, relPath);

  await storage.remove([{root, path: relPath}]);

  // Drop the file's entry from its model sidecar. The owning repo comes from
  // the recorded provenance when there is one, else from the file's placement.
  const repoId =
    (meta ? repoIdFromModelUrl(meta.modelUrl) : '') ||
    parseHubCachePath(relPath)?.repoId ||
    pathImpliedRepo(relPath)?.repoId ||
    '';
  const loc = repoId ? modelDirForRepo(relPath, repoId) : null;
  if (loc) await removeFileMeta(basePath, loc.dir, loc.key);

  // The legacy per-file sidecar goes last, carrying the prune: by now the
  // model sidecar may have deleted itself, so the prune sees the directory's
  // final state instead of stopping on a tjmodel.json about to disappear.
  await storage.remove([{root, path: metaPath(relPath)}], {
    pruneEmptyDirs: true,
  });
}

/**
 * After a batch of deletions, remove every affected model directory that no
 * longer holds any weight file. The scan — and so the delete selection — only
 * tracks weight files, so deleting a whole-repo model's weights would
 * otherwise leave a husk of support files (config.json, tokenizer files, …)
 * no table row can reach. A directory keeping any weight (another quant, a
 * projector, a weight in a subdirectory) is left untouched, as is anything in
 * a hub-cache layout (`models--…` — the hub structure owns refs/snapshots).
 */
export async function cleanupWeightlessModelDirs(
  storage: Storage,
  root: Root,
  relPaths: string[],
): Promise<void> {
  const dirs = new Set<string>();
  for (const rel of relPaths) {
    if (parseHubCachePath(rel)) continue;
    const dir = path.posix.dirname(rel);
    if (dir === '.' || dir === '') continue;
    if (dir.split('/').some((seg) => seg === '..')) continue;
    dirs.add(dir);
  }
  for (const dir of dirs) {
    if (await holdsWeightFile(storage, root, dir)) continue;
    await storage.remove([{root, path: dir}], {pruneEmptyDirs: true});
  }
}

// Whether any weight file survives under `dir` (recursively). The list is
// strict because this answer authorizes a recursive delete: an inventory
// with a hole reports true — never delete what can't be fully inspected —
// while a missing directory lists empty and reports false
// (deleteFileWithMeta may have pruned it already).
async function holdsWeightFile(
  storage: Storage,
  root: Root,
  dir: string,
): Promise<boolean> {
  let entries;
  try {
    entries = await storage.list(root, {under: dir, strict: true});
  } catch {
    return true;
  }
  return entries.some((e) => e.kind === 'file' && isWeightFile(e.path));
}
