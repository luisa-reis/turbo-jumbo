import {repoIdFromModelUrl} from '@/lib/models/model-name';
import {
  modelDirForRepo,
  modelScopeOf,
  readModelSidecar,
  type ModelScope,
} from '@/lib/models/model-sidecar';
import {
  readMetaResolved,
  updateMetaAt,
  updateMetaResolved,
  type TjMeta,
} from '@/lib/models/tjmeta';
import type {Site} from '@/lib/storage/site';

export interface RepoHead {
  id: string;
  date?: string;
}

/**
 * A file's provenance plus its model's repo-level state, ready to travel: the
 * repo commit, and the revision pin and file scope that define a complete copy.
 */
export interface FileMetaPayload {
  meta: TjMeta;
  repoHead?: RepoHead;
  modelScope?: ModelScope;
}

/**
 * Source side of a copy: a file's provenance entry together with its model
 * sidecar's repo-level commit and scope. Null when the file has no recorded
 * provenance — a copy never fabricates one.
 */
export async function readFileMetaWithRepoHead(
  srcBase: Site,
  relPath: string,
): Promise<FileMetaPayload | null> {
  const meta = await readMetaResolved(srcBase, relPath);
  if (!meta) return null;
  const repoId = repoIdFromModelUrl(meta.modelUrl);
  const loc = repoId ? modelDirForRepo(relPath, repoId) : null;
  const model = loc ? await readModelSidecar(srcBase, loc.dir) : null;
  const modelScope = modelScopeOf(model);
  return {
    meta,
    ...(model?.repoCommit
      ? {
          repoHead: {
            id: model.repoCommit,
            ...(model.repoCommitDate ? {date: model.repoCommitDate} : {}),
          },
        }
      : {}),
    ...(modelScope ? {modelScope} : {}),
  };
}

/**
 * Destination side of a copy: merge one file's provenance into this base's
 * sidecars (model sidecar when the file sits in a model dir, legacy per-file
 * sidecar otherwise). The forwarded `repoHead` applies only when the
 * destination sidecar records no repoCommit of its own — a copy is not a fresh
 * HF resolution and must not clobber a newer observation here. The forwarded
 * `modelScope` applies only when the model is new here (see `upsertFileMeta`):
 * without it, a copy of a pinned or file-scoped model would be audited against
 * `main` and the whole repo tree, and flag files the model never had.
 */
export async function applyFileMeta(
  dstBase: Site,
  relPath: string,
  meta: TjMeta,
  repoHead?: RepoHead,
  modelScope?: ModelScope,
): Promise<void> {
  const repoId = repoIdFromModelUrl(meta.modelUrl);
  if (!repoId) {
    await updateMetaAt(dstBase, relPath, meta);
    return;
  }
  let head = repoHead;
  if (head) {
    const loc = modelDirForRepo(relPath, repoId);
    const dest = loc ? await readModelSidecar(dstBase, loc.dir) : null;
    if (dest?.repoCommit) head = undefined;
  }
  await updateMetaResolved(dstBase, relPath, repoId, meta, head, modelScope);
}

/** Both sides at once. Either site may be another machine's storage — the
 *  sidecar reads and writes are small and travel the interface. */
export async function propagateFileMeta(
  srcBase: Site,
  dstBase: Site,
  relPath: string,
): Promise<void> {
  const payload = await readFileMetaWithRepoHead(srcBase, relPath);
  if (!payload) return;
  await applyFileMeta(
    dstBase,
    relPath,
    payload.meta,
    payload.repoHead,
    payload.modelScope,
  );
}
