import nodePath from 'path';
import {logger} from '@/lib/util/logger';
import {filePaths, type Model} from '@/lib/models/model-types';
import type {FileEntry, Ref, Storage} from '@/lib/storage/storage';

/**
 * Offering Lemonade the models its lists omit, in the shape it actually reads.
 *
 * This is **not** a Hugging Face cache. Lemonade's `--extra-models-dir` is a
 * plain recursive scan for `.gguf` files: it groups them by the directory they
 * sit in, names a sharded set after that directory and a standalone one after
 * its filename, and prefixes everything with `extra.`. It never looks at
 * `refs/main` or `snapshots/`, and it never loads anything but GGUF — the
 * recipe is fixed to llamacpp.
 *
 * So one directory per model, holding symlinks to that model's GGUF files under
 * their own names, is the layout that produces sensible model names: a model
 * with several quantizations lists one entry per quantization (the filenames
 * carry the quant), and a single sharded one lists as the directory.
 *
 * Non-GGUF models are left out entirely rather than linked where Lemonade
 * cannot load them.
 */

const GGUF = /\.gguf$/i;

/** Where the offered links live within the `lemonade` root. */
const EXTRA = 'extra';

export interface ExtraLink {
  /** The filename inside the model's directory. */
  name: string;
  /** The Turbo Jumbo file it points at, relative to the models root. */
  target: string;
}

export interface ExtraModelPlan {
  repoId: string;
  /** The directory under the extra dir. Lemonade names a sharded model after
   *  it, so it is the name a person will end up typing. */
  folder: string;
  links: ExtraLink[];
}

/** Every GGUF path a model holds, relative to the storage root. */
function ggufPaths(model: Model): string[] {
  return model.files.flatMap(filePaths).filter((p) => GGUF.test(p));
}

/**
 * The directory name for a repo: its repo half, qualified with the org when
 * two repos would otherwise land on the same name. Repos are visited in sorted
 * order, so which one keeps the short name doesn't drift between runs.
 */
function folderFor(repoId: string, taken: Set<string>): string {
  const [org, repo] = repoId.split('/');
  const candidates = [repo, `${org}--${repo}`, repoId.replaceAll('/', '--')];
  return candidates.find((c) => c && !taken.has(c)) ?? repoId;
}

/** A link name unique within its directory. Quantizations kept in their own
 *  folders can repeat a filename, so the folder qualifies the clash. */
function linkNameFor(repoPath: string, taken: Set<string>): string {
  const base = nodePath.posix.basename(repoPath);
  if (!taken.has(base)) return base;
  const parent = nodePath.posix.basename(nodePath.posix.dirname(repoPath));
  const qualified = parent && parent !== '.' ? `${parent}-${base}` : base;
  if (!taken.has(qualified)) return qualified;
  for (let i = 2; ; i++)
    if (!taken.has(`${i}-${qualified}`)) return `${i}-${qualified}`;
}

/**
 * What to offer Lemonade, from the models Turbo Jumbo holds locally that its
 * lists omit. Models with no GGUF weights yield no plan: Lemonade could not
 * load them from here whatever we linked.
 */
export function planExtraModels(models: Model[]): ExtraModelPlan[] {
  const folders = new Set<string>();
  const plans: ExtraModelPlan[] = [];
  for (const model of [...models].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const paths = ggufPaths(model);
    if (paths.length === 0) continue;
    const folder = folderFor(model.name, folders);
    folders.add(folder);
    const names = new Set<string>();
    const links = paths.map((p) => {
      const name = linkNameFor(p, names);
      names.add(name);
      return {name, target: p};
    });
    plans.push({repoId: model.name, folder, links});
  }
  return plans;
}

export interface ExtraChange {
  repoId: string;
  folder: string;
  /** Links that don't exist yet, or point somewhere else. */
  toLink: number;
  /** Links of ours that no longer belong — the model or file went away. */
  toRemove: number;
}

/** A plan's links as refs the `link` verb takes. */
function linkRefs(plan: ExtraModelPlan): Array<{target: Ref; at: Ref}> {
  return plan.links.map((l) => ({
    target: {root: 'models' as const, path: l.target},
    at: {
      root: 'lemonade' as const,
      path: `${EXTRA}/${plan.folder}/${l.name}`,
    },
  }));
}

/** One inventory of the extra directory, split into each folder's direct
 *  children — the only level Lemonade's grouping (and ours) cares about. */
async function extraFolders(
  storage: Storage,
): Promise<Map<string, FileEntry[]>> {
  const out = new Map<string, FileEntry[]>();
  for (const e of await storage.list('lemonade', {under: EXTRA})) {
    const rel = e.path.slice(EXTRA.length + 1);
    const parts = rel.split('/');
    if (parts.length === 1 && e.kind === 'dir') {
      if (!out.has(parts[0])) out.set(parts[0], []);
    } else if (parts.length === 2) {
      const children = out.get(parts[0]) ?? [];
      children.push(e);
      out.set(parts[0], children);
    }
  }
  return out;
}

/** The folders that hold only symlinks — the ones this wrote. A directory
 *  with a real file (or anything nested) in it belongs to whoever put it
 *  there. */
function ownedFolders(folders: Map<string, FileEntry[]>): string[] {
  return [...folders]
    .filter(
      ([, children]) =>
        children.length > 0 && children.every((c) => c.kind === 'symlink'),
    )
    .map(([name]) => name);
}

/** Links of ours in `folder` that the plan no longer wants. */
function staleLinks(
  children: FileEntry[],
  wanted: Set<string>,
): FileEntry[] {
  return children.filter(
    (c) =>
      c.kind === 'symlink' && !wanted.has(c.path.split('/').pop() ?? ''),
  );
}

/** What syncing the extra directory would change, without changing it. The
 *  link half is a dry run of the sync itself, so the two cannot disagree —
 *  e.g. about a real file occupying a link's path, which neither touches. */
export async function previewExtraModels(
  storage: Storage,
  plans: ExtraModelPlan[],
): Promise<ExtraChange[]> {
  const folders = await extraFolders(storage);
  const changes: ExtraChange[] = [];
  for (const plan of plans) {
    const outcomes = await storage.link(linkRefs(plan), {dryRun: true});
    const toLink = outcomes.filter(
      (o) => o === 'created' || o === 'replaced',
    ).length;
    const wanted = new Set(plan.links.map((l) => l.name));
    const toRemove = staleLinks(folders.get(plan.folder) ?? [], wanted).length;
    if (toLink > 0 || toRemove > 0)
      changes.push({repoId: plan.repoId, folder: plan.folder, toLink, toRemove});
  }
  // Directories for models that no longer qualify — dropped from local storage,
  // or picked up by Lemonade's catalog since.
  const planned = new Set(plans.map((p) => p.folder));
  for (const folder of ownedFolders(folders)) {
    if (planned.has(folder)) continue;
    const stale = folders.get(folder)?.length ?? 0;
    changes.push({repoId: folder, folder, toLink: 0, toRemove: stale});
  }
  return changes;
}

/** Make the extra directory match the plan. Returns what changed. */
export async function syncExtraModels(
  storage: Storage,
  plans: ExtraModelPlan[],
): Promise<ExtraChange[]> {
  const folders = await extraFolders(storage);
  const done: ExtraChange[] = [];
  for (const plan of plans) {
    let linked = 0;
    let removed = 0;
    try {
      const outcomes = await storage.link(linkRefs(plan));
      linked = outcomes.filter(
        (o) => o === 'created' || o === 'replaced',
      ).length;
      const wanted = new Set(plan.links.map((l) => l.name));
      const stale = staleLinks(folders.get(plan.folder) ?? [], wanted);
      if (stale.length > 0) {
        await storage.remove(
          stale.map((c) => ({root: 'lemonade' as const, path: c.path})),
        );
        removed = stale.length;
      }
    } catch (e) {
      logger.warn(
        `[lemonade-extra] ${plan.repoId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (linked > 0 || removed > 0)
      done.push({
        repoId: plan.repoId,
        folder: plan.folder,
        toLink: linked,
        toRemove: removed,
      });
  }

  const planned = new Set(plans.map((p) => p.folder));
  for (const folder of ownedFolders(folders)) {
    if (planned.has(folder)) continue;
    const count = folders.get(folder)?.length ?? 0;
    try {
      await storage.remove([
        {root: 'lemonade', path: `${EXTRA}/${folder}`},
      ]);
      done.push({repoId: folder, folder, toLink: 0, toRemove: count});
    } catch (e) {
      logger.warn(
        `[lemonade-extra] removing ${folder}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return done;
}
