// What a location still lacks to serve each Lemonade catalog entry a repo
// backs. The models table's lemon marker answers "which Lemonade models is
// this?"; this answers "and can this machine's Lemonade run them?" — a
// multi-checkpoint entry (an MTP draft model, a vision projector) is listed by
// Lemonade but never downloaded until every file it names is present, and the
// gap is invisible from the repo's own row.

import type {Model} from '@/lib/models/model-types';
import type {
  Checkpoint,
  LemonadeComponent,
  LemonadeModel,
  OmniCollection,
} from '@/lib/lemonade/lemonade-types';
import {checkpointPresence} from '@/lib/lemonade/lemonade-status';
import {resolveCheckpointFiles} from '@/lib/lemonade/lemonade-plan';

/** A catalog entry by its Lemonade name, with every checkpoint it needs. */
export interface LemonadeEntry {
  name: string;
  checkpoints: Checkpoint[];
}

/**
 * Every catalog entry, indexed by each repo one of its checkpoints lives in.
 * A plain GGUF model's checkpoints are its main weight plus its projector, as
 * a download fetches them. FLM models are left out: flm's store, not a
 * checkpoint list, says whether they're whole.
 */
export function lemonadeEntriesByRepo(catalog: {
  models?: LemonadeModel[];
  extraModels?: LemonadeComponent[];
  collections?: OmniCollection[];
}): Map<string, LemonadeEntry[]> {
  const map = new Map<string, LemonadeEntry[]>();
  const add = (entry: LemonadeEntry) => {
    for (const repoId of new Set(entry.checkpoints.map((c) => c.repoId))) {
      const list = map.get(repoId);
      if (!list) map.set(repoId, [entry]);
      else if (!list.some((e) => e.name === entry.name)) list.push(entry);
    }
  };
  for (const m of catalog.models ?? [])
    add({
      name: m.name,
      checkpoints: [
        {repoId: m.repoId, variant: m.variant},
        ...(m.mmproj ? [{repoId: m.repoId, variant: m.mmproj}] : []),
      ],
    });
  for (const c of catalog.extraModels ?? [])
    add({name: c.name, checkpoints: c.checkpoints});
  for (const col of catalog.collections ?? [])
    for (const c of col.components)
      add({name: c.name, checkpoints: c.checkpoints});
  return map;
}

export interface LemonadeEntryGap {
  name: string;
  /** Checkpoints the location holds none or only part of. */
  missing: Checkpoint[];
}

/**
 * For each entry, the checkpoints `models` (one location's scan) lacks.
 * Entries the location holds no part of are left out — those are models it
 * never had, not gaps in one it does; so are files the scan can't judge (a
 * non-weight file named by a catalog entry).
 */
export function lemonadeGaps(
  entries: LemonadeEntry[],
  models: Model[],
): LemonadeEntryGap[] {
  const out: LemonadeEntryGap[] = [];
  for (const entry of entries) {
    const presence = entry.checkpoints.map((cp) =>
      checkpointPresence(cp, models),
    );
    if (!presence.some((p) => p === 'complete' || p === 'partial')) continue;
    out.push({
      name: entry.name,
      missing: entry.checkpoints.filter(
        (_, i) => presence[i] === 'none' || presence[i] === 'partial',
      ),
    });
  }
  return out;
}

/**
 * The repo paths behind `variants` — catalog checkpoint variants of one repo
 * (a quant token, an exact file, or null for the whole repo) — resolved
 * against the repo's file list through the app's `/api/v1/hf-files`. Runs in
 * the browser.
 */
export async function checkpointRepoPaths(
  repoId: string,
  variants: Array<string | null>,
  branch = 'main',
): Promise<string[]> {
  const params = new URLSearchParams({repoId, branch});
  const res = await fetch(`/api/v1/hf-files?${params}`);
  if (!res.ok)
    throw new Error(`Couldn't list ${repoId}'s files: ${res.status}`);
  const files = (await res.json()) as Array<{path: string; size: number}>;
  return [
    ...new Set(variants.flatMap((v) => resolveCheckpointFiles(files, v))),
  ];
}
