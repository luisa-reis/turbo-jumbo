import type {ModelRow, QuantInfo} from '@/lib/models/model-row';
import {fileBasename, fileJoinKey} from '@/lib/peers/peer-paths';
import {
  buildSourceFiles,
  type SourceFile,
  type SourceIndex,
} from '@/lib/copy/source-files';

/**
 * Pick the one model a `tj copy <pattern>` refers to.
 *
 * Refuses to guess: a pattern matching several models returns them all so the
 * caller can list them and stop. Copying the wrong hundred gigabytes because a
 * substring was ambiguous is not a recoverable mistake.
 */
export function matchModels(rows: ModelRow[], pattern: string): ModelRow[] {
  const needle = pattern.trim().toLowerCase();
  const hits = rows.filter((r) => r.name.toLowerCase().includes(needle));
  // An exact name beats being a prefix of longer ones.
  const exact = hits.filter((r) => r.name.toLowerCase() === needle);
  return exact.length === 1 ? exact : hits;
}

/** The quantizations of `row` a run applies to: all of them, or those named. */
export function selectQuants(row: ModelRow, labels: string[]): QuantInfo[] {
  if (labels.length === 0) return row.quants;
  const wanted = new Set(labels.map((l) => l.toLowerCase()));
  return row.quants.filter((q) => wanted.has(q.label.toLowerCase()));
}

/**
 * The files to copy, resolved against whichever copies actually exist.
 *
 * A quantization's paths differ between hosts — the same file can sit at a bare
 * path on one machine and under `<org>/<repo>/` on another — so candidates are
 * matched by `fileJoinKey`, the basename join the models table and the copy
 * workflow already use, rather than by path equality. `index` then supplies the
 * source and size for each path it knows.
 */
export function planCopyFiles(
  modelName: string,
  quants: QuantInfo[],
  index: SourceIndex,
): SourceFile[] {
  // Every join key this selection covers, from whichever tier listed it.
  const wanted = new Set<string>();
  for (const q of quants) {
    for (const p of [...q.paths, ...q.coldPaths]) {
      wanted.add(fileJoinKey(modelName, fileBasename(p)));
    }
  }

  const paths: string[] = [];
  for (const [path] of index.entries()) {
    if (wanted.has(fileJoinKey(modelName, fileBasename(path))))
      paths.push(path);
  }
  return buildSourceFiles(index, paths);
}
