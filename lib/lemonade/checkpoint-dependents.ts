// The reverse edges of the Lemonade catalog's checkpoint graph: which catalog
// entries a scanned file is a dependency of. The catalog says entry → files;
// the models table needs file → entries, so a row like a text encoder can say
// "needed by <image model>" before someone deletes or archives it blind.

import type {Model} from '@/lib/models/model-types';
import type {
  Checkpoint,
  LemonadeComponent,
  OmniCollection,
} from '@/lib/lemonade/lemonade-types';
import {matchCheckpointFiles} from '@/lib/lemonade/lemonade-status';

export interface DependentRef {
  /** The catalog entry's display name. */
  entry: string;
  checkpoint: Checkpoint;
}

/**
 * Index every checkpoint reference of the catalog's multi-checkpoint entries
 * by repo id. Single-checkpoint entries are skipped — such an entry *is* its
 * repo, and "needed by itself" is noise, not a dependency.
 */
export function checkpointDependents(catalog: {
  extraModels?: LemonadeComponent[];
  collections?: OmniCollection[];
}): Map<string, DependentRef[]> {
  const map = new Map<string, DependentRef[]>();
  const add = (entry: string, checkpoint: Checkpoint) => {
    const refs = map.get(checkpoint.repoId);
    if (refs) refs.push({entry, checkpoint});
    else map.set(checkpoint.repoId, [{entry, checkpoint}]);
  };
  const components = [
    ...(catalog.extraModels ?? []),
    ...(catalog.collections ?? []).flatMap((col) => col.components),
  ];
  for (const c of components) {
    if (c.checkpoints.length < 2) continue;
    for (const cp of c.checkpoints) add(c.name, cp);
  }
  return map;
}

/**
 * The catalog entries that need exactly this file. Matching reuses the same
 * per-checkpoint selection the Lemonade status markers judge with
 * (matchCheckpointFiles), over a single-file stand-in built from what a table
 * row knows: its model name, basename, and quant label. A whole-repo (null
 * variant) checkpoint claims every file of its repo.
 */
export function dependentsForFile(
  deps: Map<string, DependentRef[]>,
  modelName: string,
  basename: string,
  quant: string,
): string[] {
  const refs = deps.get(modelName);
  if (!refs) return [];
  const standIn: Model = {
    name: modelName,
    files: [
      {
        isSplit: false,
        filename: basename,
        path: basename,
        quant,
        size: 0,
        missing: false,
      },
    ],
  };
  const out: string[] = [];
  for (const ref of refs) {
    const needed =
      ref.checkpoint.variant == null ||
      matchCheckpointFiles(ref.checkpoint, [standIn]).length > 0;
    if (needed && !out.includes(ref.entry)) out.push(ref.entry);
  }
  return out;
}
