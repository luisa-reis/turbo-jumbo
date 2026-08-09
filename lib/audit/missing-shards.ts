// Detecting the shards a split (sharded) quantization is missing. A GGUF repo
// is downloaded one quant at a time, so the whole-repo completeness checks in
// lib/audit/incomplete-models skip it — a half-transferred shard set is instead
// found from the scan (`missingIndices`) and resolved here against the repo's
// file list, which is what gives each absent shard a source to re-fetch from.
// Server-only — pulled in by the audit route.

import {expectedRelPath, hfSummary, type AuditResult} from '@/lib/audit/audit';
import {shardSetPaths} from '@/lib/hf/hf-download';
import {listRepoFiles} from '@/lib/hf/hf-infer';
import {modelRevision} from '@/lib/models/model-sidecar';
import type {Model} from '@/lib/models/models';
import nodePath from 'path';

const basename = (p: string) => p.split('/').pop() ?? p;

/**
 * Synthetic `incomplete` audit verdicts for the shards missing from every split
 * quant among `selected` — one per absent shard, keyed at the path it belongs
 * at and carrying the HF summary that powers re-download. Shards are resolved
 * against the repo's file list (at the model's pinned revision, else `branch`),
 * so a set the repo no longer offers, or a repo whose listing fails, is left
 * unflagged rather than pointed at a guessed path.
 */
export async function detectMissingShards(
  models: Model[],
  selected: Set<string>,
  storageBase: string,
  branch: string,
): Promise<AuditResult[]> {
  const base = nodePath.resolve(storageBase);
  const out: AuditResult[] = [];
  for (const model of models) {
    // Without an `<org>/<repo>` name there's no repo to resolve the shards in.
    if (!model.name.includes('/')) continue;
    for (const file of model.files) {
      if (!file.isSplit || file.missingIndices.length === 0) continue;
      if (!file.files.some((s) => selected.has(s.path))) continue;
      const pinned = await modelRevision(base, model.name);
      const repoBranch = pinned !== 'main' ? pinned : branch;
      const lfs = await listRepoFiles(model.name, repoBranch);
      if (!lfs) continue;
      const present = new Set(file.files.map((s) => basename(s.path)));
      const setPaths = shardSetPaths(
        lfs.map((f) => ({path: f.repoPath})),
        file.representativeFilename,
      );
      for (const repoPath of setPaths) {
        if (present.has(basename(repoPath))) continue;
        const hf = lfs.find((f) => f.repoPath === repoPath);
        if (!hf) continue;
        out.push({
          file: expectedRelPath(hf),
          status: 'incomplete',
          message: 'expected shard not downloaded',
          hf: hfSummary(hf),
        });
      }
    }
  }
  return out;
}
