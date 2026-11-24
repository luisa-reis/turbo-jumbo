import {
  readFileMetaByPath,
  fileProvenance,
  modelRevision,
} from '@/lib/models/model-sidecar';
import {completeFileSet} from '@/lib/models/complete-file-set';
import type {FileProvenance} from '@/lib/models/sidecar-types';
import {isPickOneBinRepo, isPickOneSafetensorsRepo} from '@/lib/hf/hf-download';
import {isDiffusersRepo} from '@/lib/models/diffusers';
import {isClutterFile} from '@/lib/models/repo-clutter';
import {entriesUnder} from '@/lib/storage/entries';
import {siteStorage, type Site} from '@/lib/storage/site';

export type RepoFileState = 'present' | 'missing' | 'invalid';

export interface RepoFile {
  path: string; // repo-relative path
  state: RepoFileState;
  size: number | null; // local size, null when missing
  expectedSize: number; // size on Hugging Face
  // The file's sidecar provenance, when the download recorded one (present
  // on-disk files only). Absent for missing files and unrecorded files.
  provenance?: FileProvenance;
}

// The repo tree changes rarely; cache it per repo and revision. The on-disk
// comparison below is recomputed every call so a fresh download flips a file
// present.
const TTL_MS = 30 * 60 * 1000;
interface TreeFile {
  path: string;
  size: number;
}
const treeCache = new Map<string, {files: TreeFile[]; fetchedAt: number}>();

/** Every file in `repoId`'s HF tree at `revision`, with its size (the LFS
 *  size for large files). Cached per repo and revision. */
export async function repoTree(
  repoId: string,
  revision: string,
  signal?: AbortSignal,
): Promise<TreeFile[]> {
  const key = `${repoId}@${revision}`;
  const hit = treeCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.files;
  const res = await fetch(
    `https://huggingface.co/api/models/${repoId}/tree/${revision}?recursive=true`,
    {headers: {'User-Agent': 'tj/1.0'}, signal},
  );
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const entries = (await res.json()) as Array<{
    type: string;
    path: string;
    size: number;
    lfs?: {size: number};
  }>;
  const files = entries
    .filter((e) => e.type === 'file')
    .map((e) => ({path: e.path, size: e.lfs?.size ?? e.size}));
  treeCache.set(key, {files, fetchedAt: Date.now()});
  return files;
}

/**
 * Every file in `repoId`'s HF tree, each judged against the site's copy under
 * `<repoId>`: `missing` (not on disk), `invalid`, else `present`.
 * Files are validated by size against the HF tree; a file HF serves a checksum
 * for is additionally invalid when its sidecar's recorded hash/size disagree
 * with the source. A checksum-less file (no LFS oid, e.g. index.json) is judged
 * by size alone — a size match is valid even though it can't be attested. No
 * live hashing — only the file size and any sidecar the download recorded.
 *
 * A pick-one `.bin` repo (ggml whisper.cpp-style, see `isPickOneBinRepo`) is
 * treated like GGUF: only files present on disk are reported, never the repo's
 * other un-downloaded variants as `missing`.
 */
export async function repoFileStatuses(
  site: Site,
  repoId: string,
): Promise<RepoFile[]> {
  const {storage, root} = siteStorage(site);
  // Judge against the revision the model tracks (its sidecar pin), not
  // whatever main looks like today — a pinned repo's main may carry different
  // files entirely.
  const revision = await modelRevision(site, repoId);
  // A model with a defined file set (a FastFlowLM model, see completeFileSet)
  // is judged only against it: the repo's other files aren't part of the
  // model, so one that isn't on disk is never missing. One that is on disk is
  // still listed, and still judged valid or not — it takes up room there.
  const scope = await completeFileSet(site, repoId);
  // One inventory of the model directory answers presence and size for every
  // file in the tree.
  const onDisk = await entriesUnder(storage, root, repoId);
  // Drop repo clutter (`.gitattributes`, docs, images): never a required file,
  // so never reported as missing.
  const tree = (await repoTree(repoId, revision)).filter(
    (f) =>
      !isClutterFile(f.path) &&
      (scope == null || scope.has(f.path) || onDisk.has(`${repoId}/${f.path}`)),
  );
  const paths = tree.map((f) => f.path);
  // A pick-one repo — ggml whisper.cpp-style `.bin` weights, a Comfy-Org
  // split_files safetensors bundle, or a diffusers pipeline (component folders
  // at two precisions) — holds independent models/components; like GGUF, an
  // un-downloaded variant isn't "missing", so report only the files present on
  // disk, not the whole repo.
  const pickOne =
    isPickOneBinRepo(paths) ||
    isPickOneSafetensorsRepo(paths) ||
    isDiffusersRepo(paths);
  const out: RepoFile[] = [];
  for (const f of tree) {
    const entry = onDisk.get(`${repoId}/${f.path}`);
    if (!entry) {
      if (pickOne) continue;
      out.push({
        path: f.path,
        state: 'missing',
        size: null,
        expectedSize: f.size,
      });
      continue;
    }
    const size = entry.size;
    let state: RepoFileState = size === f.size ? 'present' : 'invalid';
    // For a file present on disk, the sidecar (when the download recorded one)
    // both validates the copy and supplies the row's provenance.
    const meta = await readFileMetaByPath(site, `${repoId}/${f.path}`);
    if (state === 'present' && meta) {
      // The size matches HF. Validate by size alone unless the sidecar can prove
      // a problem from what the download recorded: a computed size that disagrees
      // with a known source size, or disagreeing hashes (truncated or corrupted
      // at download). An unknown source size — a checksum-less file HF serves no
      // way to attest — is left valid on the size match above, not flagged.
      if (
        (meta.sourceSize > 0 &&
          meta.computedSize > 0 &&
          meta.computedSize !== meta.sourceSize) ||
        (!!meta.sourceSha256 &&
          !!meta.computedSha256 &&
          meta.sourceSha256 !== meta.computedSha256)
      ) {
        state = 'invalid';
      }
    }
    out.push({
      path: f.path,
      state,
      size,
      expectedSize: f.size,
      ...(meta ? {provenance: fileProvenance(meta)} : {}),
    });
  }
  return out;
}
