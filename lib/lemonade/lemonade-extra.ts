import {promises as fsp} from 'fs';
import nodePath from 'path';
import {logger} from '@/lib/util/logger';
import {filePaths, type Model} from '@/lib/models/model-types';

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

export interface ExtraLink {
  /** The filename inside the model's directory. */
  name: string;
  /** Absolute path to the Turbo Jumbo file it points at. */
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
  const base = nodePath.basename(repoPath);
  if (!taken.has(base)) return base;
  const parent = nodePath.basename(nodePath.dirname(repoPath));
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
export function planExtraModels(
  tjBase: string,
  models: Model[],
): ExtraModelPlan[] {
  const tj = nodePath.resolve(tjBase);
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
      return {name, target: nodePath.resolve(tj, p)};
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

/** Whether `full` is a symlink, and where it points. */
async function linkTarget(full: string): Promise<string | null> {
  try {
    const st = await fsp.lstat(full);
    if (!st.isSymbolicLink()) return null;
    return await fsp.readlink(full);
  } catch {
    return null;
  }
}

/**
 * Compare one model's directory with its plan.
 *
 * Only symlinks are ever counted for removal. Lemonade calls this directory
 * user-managed, and a real file in it is somebody's own model rather than
 * something this put there.
 */
async function diffFolder(
  extraDir: string,
  plan: ExtraModelPlan,
): Promise<ExtraChange> {
  const dir = nodePath.join(extraDir, plan.folder);
  const wanted = new Map(plan.links.map((l) => [l.name, l.target]));
  let toLink = 0;
  for (const [name, target] of wanted) {
    if ((await linkTarget(nodePath.join(dir, name))) !== target) toLink++;
  }
  let toRemove = 0;
  for (const name of await entriesIn(dir)) {
    if (wanted.has(name)) continue;
    if ((await linkTarget(nodePath.join(dir, name))) !== null) toRemove++;
  }
  return {repoId: plan.repoId, folder: plan.folder, toLink, toRemove};
}

async function entriesIn(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

/** The directories under `extraDir` that hold only symlinks — the ones this
 *  wrote. A directory with a real file in it belongs to whoever put it there. */
async function ownedFolders(extraDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await entriesIn(extraDir)) {
    const dir = nodePath.join(extraDir, name);
    const names = await entriesIn(dir);
    if (names.length === 0) continue;
    const allLinks = await Promise.all(
      names.map(
        async (n) => (await linkTarget(nodePath.join(dir, n))) !== null,
      ),
    );
    if (allLinks.every(Boolean)) out.push(name);
  }
  return out;
}

/** What syncing the extra directory would change, without changing it. */
export async function previewExtraModels(
  extraDir: string,
  plans: ExtraModelPlan[],
): Promise<ExtraChange[]> {
  const changes: ExtraChange[] = [];
  for (const plan of plans) {
    const change = await diffFolder(extraDir, plan);
    if (change.toLink > 0 || change.toRemove > 0) changes.push(change);
  }
  // Directories for models that no longer qualify — dropped from local storage,
  // or picked up by Lemonade's catalog since.
  const planned = new Set(plans.map((p) => p.folder));
  for (const folder of await ownedFolders(extraDir)) {
    if (planned.has(folder)) continue;
    const stale = (await entriesIn(nodePath.join(extraDir, folder))).length;
    changes.push({repoId: folder, folder, toLink: 0, toRemove: stale});
  }
  return changes;
}

/** Make the extra directory match the plan. Returns what changed. */
export async function syncExtraModels(
  extraDir: string,
  plans: ExtraModelPlan[],
): Promise<ExtraChange[]> {
  const done: ExtraChange[] = [];
  for (const plan of plans) {
    const dir = nodePath.join(extraDir, plan.folder);
    let linked = 0;
    let removed = 0;
    try {
      await fsp.mkdir(dir, {recursive: true});
      const wanted = new Map(plan.links.map((l) => [l.name, l.target]));
      for (const [name, target] of wanted) {
        const full = nodePath.join(dir, name);
        const current = await linkTarget(full);
        if (current === target) continue;
        // Replace a link pointing elsewhere; never overwrite a real file.
        if (current !== null) await fsp.rm(full, {force: true});
        else if (await exists(full)) continue;
        await fsp.symlink(target, full);
        linked++;
      }
      for (const name of await entriesIn(dir)) {
        if (wanted.has(name)) continue;
        const full = nodePath.join(dir, name);
        if ((await linkTarget(full)) === null) continue;
        await fsp.rm(full, {force: true});
        removed++;
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
  for (const folder of await ownedFolders(extraDir)) {
    if (planned.has(folder)) continue;
    const dir = nodePath.join(extraDir, folder);
    const names = await entriesIn(dir);
    try {
      for (const n of names) await fsp.rm(nodePath.join(dir, n), {force: true});
      await fsp.rmdir(dir);
      done.push({repoId: folder, folder, toLink: 0, toRemove: names.length});
    } catch (e) {
      logger.warn(
        `[lemonade-extra] removing ${folder}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return done;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}
