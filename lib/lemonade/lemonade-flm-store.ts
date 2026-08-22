import nodePath from 'path';
import {logger} from '@/lib/util/logger';
import {filePaths, shardSize, type Model} from '@/lib/models/model-types';
import type {FlmSource} from '@/lib/lemonade/flm';
import type {FileEntry, Storage} from '@/lib/storage/storage';

/**
 * Offering Lemonade's flm backend the FLM models Turbo Jumbo holds.
 *
 * An FLM model downloaded from its Hugging Face repo lands in Turbo Jumbo
 * storage, but `flm` only ever looks in its own store — `$FLM_MODEL_PATH/models`,
 * kept at `<lemonade>/flm/models` by convention (see docs/cli.md) — and
 * Lemonade reports a model as downloaded only when `flm list` says it is
 * installed. A symlink to the model's directory, named the way Lemonade looks
 * it up (the last segment of the registry's repo URL, i.e. the repo half of
 * the id), is enough for flm to count it.
 *
 * One link per model, never per file: the directory is the unit flm reasons
 * about, and a real directory in the store is one of flm's own pulls, which
 * nothing here touches.
 */

/** Where the store lives within the `lemonade` root. */
export const FLM_STORE = 'flm/models';

export interface FlmStorePlan {
  repoId: string;
  /** The directory name in the store — what Lemonade resolves for the tag. */
  folder: string;
  /** The model's directory, relative to the models root. */
  dir: string;
  /** The flm tags the registry maps to this repo. */
  tags: string[];
  /** Registry-named files the directory lacks. Linkable only when empty. */
  missing: string[];
  /** The model's weight bytes — what a pull of it would have flm verify. */
  bytes: number;
}

export type FlmStoreStatus =
  /** Link to be created, or corrected. */
  | 'link'
  /** A link of ours the plan no longer wants. */
  | 'remove'
  /** Held, but not whole — the registry names files that are not there. */
  | 'incomplete';

export interface FlmStoreChange {
  repoId: string;
  folder: string;
  status: FlmStoreStatus;
  missing?: string[];
}

/** The directory a model's files sit in: the parent of its first file. */
function modelDir(model: Model): string | null {
  const first = model.files.flatMap(filePaths)[0];
  if (!first) return null;
  const dir = nodePath.posix.dirname(first);
  return dir === '.' ? '' : dir;
}

/** Direct children of `dir` under the models root, by basename. */
async function childNames(storage: Storage, dir: string): Promise<Set<string>> {
  const prefix = dir ? `${dir}/` : '';
  const out = new Set<string>();
  for (const e of await storage.list('models', {under: dir || undefined})) {
    const rel = e.path.startsWith(prefix)
      ? e.path.slice(prefix.length)
      : e.path;
    if (!rel.includes('/')) out.add(rel);
  }
  return out;
}

/**
 * Which held models flm could serve from a link, and whether each is whole.
 * A model whose repo no tag resolves to yields nothing: flm would not know
 * what to do with it.
 */
export async function planFlmStore(
  storage: Storage,
  models: Model[],
  registry: Map<string, FlmSource>,
): Promise<FlmStorePlan[]> {
  const byRepo = new Map<string, {tags: string[]; files: Set<string>}>();
  for (const [tag, source] of registry) {
    const entry = byRepo.get(source.repoId) ?? {tags: [], files: new Set()};
    entry.tags.push(tag);
    for (const f of source.files) entry.files.add(f);
    byRepo.set(source.repoId, entry);
  }
  const plans: FlmStorePlan[] = [];
  for (const model of [...models].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const entry = byRepo.get(model.name);
    if (!entry) continue;
    const dir = modelDir(model);
    if (dir === null) continue;
    const present = await childNames(storage, dir);
    plans.push({
      repoId: model.name,
      folder: model.name.split('/').pop() ?? model.name,
      dir,
      tags: entry.tags,
      missing: [...entry.files].filter((f) => !present.has(f)).sort(),
      bytes: model.files.reduce(
        (n, f) =>
          n +
          (f.isSplit ? f.files.reduce((s, x) => s + shardSize(x), 0) : f.size),
        0,
      ),
    });
  }
  return plans;
}

const at = (folder: string) => ({
  root: 'lemonade' as const,
  path: `${FLM_STORE}/${folder}`,
});

/** The store's direct children: our links and flm's own directories. */
async function storeEntries(storage: Storage): Promise<FileEntry[]> {
  const prefix = `${FLM_STORE}/`;
  return (await storage.list('lemonade', {under: FLM_STORE})).filter(
    (e) => !e.path.slice(prefix.length).includes('/'),
  );
}

/** Links of ours the plans don't want — the model went away, or stopped
 *  being whole. Real directories are flm's and are never candidates. */
function staleLinks(entries: FileEntry[], wanted: Set<string>): string[] {
  return entries
    .filter((e) => e.kind === 'symlink')
    .map((e) => e.path.split('/').pop() ?? '')
    .filter((name) => name && !wanted.has(name))
    .sort();
}

/** One pass over the plans and the store, linking or only looking. The link
 *  half is a dry run of the sync when `dryRun`, so preview and sync agree. */
async function pass(
  storage: Storage,
  plans: FlmStorePlan[],
  dryRun: boolean,
): Promise<FlmStoreChange[]> {
  const changes: FlmStoreChange[] = [];
  const whole = plans.filter((p) => p.missing.length === 0);
  for (const p of plans)
    if (p.missing.length > 0)
      changes.push({
        repoId: p.repoId,
        folder: p.folder,
        status: 'incomplete',
        missing: p.missing,
      });
  if (whole.length > 0) {
    const outcomes = await storage.link(
      whole.map((p) => ({
        target: {root: 'models' as const, path: p.dir},
        at: at(p.folder),
      })),
      {dryRun},
    );
    outcomes.forEach((o, i) => {
      if (o === 'created' || o === 'replaced')
        changes.push({
          repoId: whole[i].repoId,
          folder: whole[i].folder,
          status: 'link',
        });
    });
  }
  const wanted = new Set(whole.map((p) => p.folder));
  const stale = staleLinks(await storeEntries(storage), wanted);
  if (stale.length > 0 && !dryRun)
    await storage.remove(stale.map((name) => at(name)));
  for (const name of stale) {
    const plan = plans.find((p) => p.folder === name);
    changes.push({
      repoId: plan?.repoId ?? name,
      folder: name,
      status: 'remove',
    });
  }
  return changes;
}

/** What syncing the store would change, without changing it. */
export function previewFlmStore(
  storage: Storage,
  plans: FlmStorePlan[],
): Promise<FlmStoreChange[]> {
  return pass(storage, plans, true);
}

/** Make the store match the plans. Returns what changed. */
export async function syncFlmStore(
  storage: Storage,
  plans: FlmStorePlan[],
): Promise<FlmStoreChange[]> {
  try {
    return await pass(storage, plans, false);
  } catch (e) {
    logger.warn(
      `[lemonade-flm-store] ${e instanceof Error ? e.message : String(e)}`,
    );
    throw e;
  }
}
