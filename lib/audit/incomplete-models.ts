import {logger} from '@/lib/util/logger';
import {scanModels, type ModelFile} from '@/lib/models/models';
import {repoFileStatuses} from '@/lib/models/repo-files';
import {
  isPickOneBinRepo,
  isPickOneSafetensorsRepo,
  repoDownloadFiles,
} from '@/lib/hf/hf-download';
import {isDiffusersRepo} from '@/lib/models/diffusers';
import {isClutterFile} from '@/lib/models/repo-clutter';
import {listRepoFiles, type HfFileInfo} from '@/lib/hf/hf-infer';
import {hfSummary, type AuditResult, type TjMeta} from '@/lib/audit/audit';
import {
  readModelSidecar,
  upsertFileMeta,
  removeFileMeta,
  metaToEntry,
  modelFileScope,
  modelRevision,
} from '@/lib/models/model-sidecar';
import {entriesUnder} from '@/lib/storage/entries';
import {siteStorage, type Site} from '@/lib/storage/site';

// A repo's Hugging Face file list changes rarely, but it's a network round-trip,
// so cache the expected-file list per repo and revision. The on-disk presence
// check is recomputed every call (cheap) so a just-finished download clears the
// flag.
const TTL_MS = 30 * 60 * 1000;
const treeCache = new Map<string, {files: string[]; fetchedAt: number}>();

// The files a complete download of `repoId` at `revision` would contain — what
// the downloader pulls (repoDownloadFiles), minus pure docs/metadata.
async function expectedFiles(
  repoId: string,
  revision: string,
): Promise<string[]> {
  const key = `${repoId}@${revision}`;
  const hit = treeCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.files;
  // Recurse so a checkpoint's nested file (e.g. a Flux VAE under
  // split_files/vae/) is seen and a missing one is flagged, rather than the
  // subdirectory being reported as a single opaque entry.
  const res = await fetch(
    `https://huggingface.co/api/models/${repoId}/tree/${revision}?recursive=true`,
    {headers: {'User-Agent': 'tj/1.0'}},
  );
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const entries = (await res.json()) as Array<{type: string; path: string}>;
  const files = repoDownloadFiles(
    entries.filter((e) => e.type === 'file').map((e) => e.path),
  ).filter((p) => !isClutterFile(p));
  treeCache.set(key, {files, fetchedAt: Date.now()});
  return files;
}

const groupName = (f: ModelFile) =>
  f.isSplit ? f.representativeFilename : f.filename;

// A GGUF repo is downloaded one quant at a time, so its full repo file list
// doesn't describe a "complete" local copy — only non-GGUF models (ONNX/Kokoro,
// safetensors, …) are judged complete by having every expected file.
const isSelfContainedGguf = (files: ModelFile[]) =>
  files.every((f) => groupName(f).toLowerCase().endsWith('.gguf'));

/**
 * Repo ids present at the site whose copy is missing files a full
 * download would include (e.g. Kokoro with only voices-v1.0.bin, missing
 * kokoro-v1.0.onnx). GGUF models are skipped — their per-quant downloads aren't
 * judged against the whole repo. A network failure for a repo leaves it
 * unflagged rather than falsely reported incomplete.
 */
export async function findIncompleteRepos(
  site: Site,
  lemonadePath?: string,
): Promise<string[]> {
  const {storage, root} = siteStorage(site);
  const local = await scanModels(site, lemonadePath);
  const candidates = local.filter((m) => !isSelfContainedGguf(m.files));
  const results = await Promise.all(
    candidates.map(async (m) => {
      try {
        const scope = await modelFileScope(site, m.name);
        const expected = (
          await expectedFiles(m.name, await modelRevision(site, m.name))
        ).filter((f) => scope == null || scope.has(f));
        if (expected.length === 0) return null;
        // A pick-one repo — ggml whisper.cpp-style `.bin` weights, a Comfy-Org
        // split_files safetensors bundle, or a diffusers pipeline — isn't a
        // whole-repo download: like GGUF, each file is an independent
        // model/component, so the repo's other variants aren't "missing".
        if (
          isPickOneBinRepo(expected) ||
          isPickOneSafetensorsRepo(expected) ||
          isDiffusersRepo(expected)
        )
          return null;
        const onDisk = await entriesUnder(storage, root, m.name);
        const incomplete = expected.some((f) => !onDisk.has(`${m.name}/${f}`));
        return incomplete ? m.name : null;
      } catch (e) {
        logger.debug(
          `[incomplete] ${m.name}: ${e instanceof Error ? e.message : String(e)}`,
        );
        return null;
      }
    }),
  );
  return results.filter((x): x is string => x != null);
}

/**
 * Repo ids present at the site with at least one local file that audits
 * `invalid` — its size differs from Hugging Face, or its sidecar can't attest it
 * (unknown source size, or a recorded size/hash that disagrees with the source);
 * see `repoFileStatuses`. Like `findIncompleteRepos`, only non-GGUF (whole-repo)
 * models are judged: a GGUF repo's per-quant copies are audited file-by-file, so
 * a bad quant already surfaces in the audit column. A network failure for a repo
 * leaves it unflagged rather than falsely reported invalid.
 */
export async function findReposWithInvalidFiles(
  site: Site,
  lemonadePath?: string,
): Promise<string[]> {
  const local = await scanModels(site, lemonadePath);
  const candidates = local.filter((m) => !isSelfContainedGguf(m.files));
  const results = await Promise.all(
    candidates.map(async (m) => {
      try {
        const files = await repoFileStatuses(site, m.name);
        return files.some((f) => f.state === 'invalid') ? m.name : null;
      } catch (e) {
        logger.debug(
          `[invalid] ${m.name}: ${e instanceof Error ? e.message : String(e)}`,
        );
        return null;
      }
    }),
  );
  return results.filter((x): x is string => x != null);
}

/**
 * Synthetic `incomplete` audit verdicts for the files a full download would
 * include but that aren't on disk at the site (e.g. a Kokoro repo's
 * kokoro-v1.0.onnx or its index.json). Uses the same expected set as the table
 * flag, so the two agree. A large (LFS) file carries the HF summary that powers
 * re-download; a small companion (no checksum) is still flagged, just without
 * it. GGUF repos are skipped — their per-quant downloads are judged
 * file-by-file, and a missing projector is handled by detectMissingMmproj.
 */
export async function detectMissingExpectedFiles(
  repoIds: string[],
  site: Site,
  branch: string,
): Promise<AuditResult[]> {
  const {storage, root} = siteStorage(site);
  const out: AuditResult[] = [];
  for (const repoId of repoIds) {
    // A model pinned to a revision (sidecar `revision`) is judged against that
    // revision; the caller's branch is the default for everything else.
    const pinned = await modelRevision(site, repoId);
    const repoBranch = pinned !== 'main' ? pinned : branch;
    const lfs = await listRepoFiles(repoId, repoBranch);
    if (!lfs) continue;
    const repoPaths = lfs.map((f) => f.repoPath);
    const hasGguf = repoPaths.some((p) => /\.gguf$/i.test(p));
    const hasSafetensors = repoPaths.some((p) => /\.safetensors$/i.test(p));
    // Repos that aren't a single whole-repo download — GGUF (per-quant), a
    // ggml .bin pick-one, a Comfy split_files bundle, or a diffusers pipeline
    // (component folders plus alternate single-file/ONNX packagings) — are
    // judged per file, not by the whole repo, so their un-downloaded files
    // aren't "missing". Clear any stale flag a prior whole-repo audit recorded,
    // then skip — otherwise a single-file checkpoint of a diffusers repo, say,
    // keeps reporting the rest of the pipeline as missing.
    if (
      (hasGguf && !hasSafetensors) ||
      isPickOneBinRepo(repoPaths) ||
      isPickOneSafetensorsRepo(repoPaths) ||
      isDiffusersRepo(repoPaths)
    ) {
      await clearMissingFlags(site, repoId);
      continue;
    }
    let expected: string[];
    try {
      const scope = await modelFileScope(site, repoId);
      expected = (await expectedFiles(repoId, repoBranch)).filter(
        (f) => scope == null || scope.has(f),
      );
    } catch {
      continue; // network failure: don't falsely flag
    }
    const expectedSet = new Set(expected);
    const lfsByPath = new Map(lfs.map((f) => [f.repoPath, f]));
    const onDisk = await entriesUnder(storage, root, repoId);
    // Files this repo's sidecar currently records as missing: a stale flag on a
    // now-present file is cleared below so the cached audit agrees with disk.
    // A flag on a file no longer expected (it fell outside a newly-recorded
    // file scope) is dropped outright.
    const sidecar = await readModelSidecar(site, repoId);
    const flaggedMissing = new Set(
      (sidecar?.files ?? []).filter((f) => f.missing).map((f) => f.path),
    );
    for (const stale of flaggedMissing) {
      if (expectedSet.has(stale)) continue;
      try {
        await removeFileMeta(site, repoId, stale);
      } catch {
        /* best-effort: a stale flag isn't worth failing the audit */
      }
    }
    for (const repoPath of expected) {
      const entry = onDisk.get(`${repoId}/${repoPath}`);
      const hf = lfsByPath.get(repoPath);
      if (!entry) {
        out.push({
          file: `${repoId}/${repoPath}`,
          status: 'incomplete',
          message: 'expected file not downloaded',
          ...(hf ? {hf: hfSummary(hf)} : {}),
        });
        await persistMissingState(
          site,
          repoId,
          repoPath,
          repoBranch,
          hf,
          0,
          true,
        );
      } else if (flaggedMissing.has(repoPath)) {
        await persistMissingState(
          site,
          repoId,
          repoPath,
          repoBranch,
          hf,
          entry.size,
          false,
        );
      }
    }
  }
  return out;
}

/**
 * Drop every `missing`-flagged entry from a repo's sidecar — the
 * expected-but-absent markers a prior whole-repo audit left. Called when the
 * repo turns out not to be a whole-repo download (pick-one / diffusers), so the
 * cached audit stops reporting its other variants as missing. Best-effort.
 */
async function clearMissingFlags(site: Site, repoId: string): Promise<void> {
  const sidecar = await readModelSidecar(site, repoId);
  if (!sidecar) return;
  for (const f of sidecar.files) {
    if (!f.missing) continue;
    try {
      await removeFileMeta(site, repoId, f.path);
    } catch {
      /* best-effort: a stale flag isn't worth failing the audit */
    }
  }
}

/**
 * Record (or clear) the `missing` flag for one file on its model sidecar. The
 * HF summary, when known, lets a later re-download verify against source.
 * Best-effort: a sidecar write failure must not fail the audit.
 */
async function persistMissingState(
  site: Site,
  repoId: string,
  repoPath: string,
  branch: string,
  hf: HfFileInfo | undefined,
  computedSize: number,
  missing: boolean,
): Promise<void> {
  const meta: TjMeta = {
    modelUrl: `https://huggingface.co/${repoId}`,
    originUrl: `https://huggingface.co/${repoId}/blob/${branch}/${repoPath}`,
    ...(hf?.commit ? {sourceCommit: hf.commit} : {}),
    ...(hf?.commitDate ? {sourceCommitDate: hf.commitDate} : {}),
    sourceSize: hf?.size ?? 0,
    computedSize,
    sourceSha256: hf?.sha256 ?? '',
    computedSha256: '',
    ...(missing ? {missing: true} : {}),
  };
  try {
    await upsertFileMeta(site, repoId, repoId, metaToEntry(repoPath, meta));
  } catch (e) {
    logger.warn(
      `[incomplete] failed to record missing state for ${repoId}/${repoPath}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}
