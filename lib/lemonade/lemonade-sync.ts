import {logger} from '@/lib/util/logger';
import {
  MODEL_SIDECAR_NAME,
  readModelSidecar,
  upsertFileMeta,
  type TjModelFile,
} from '@/lib/models/model-sidecar';
import {MIXED_COMMIT} from '@/lib/models/sidecar-types';
import {
  LEMONADE_SIDES,
  sideFor,
  type LemonadeSide,
} from '@/lib/lemonade/lemonade-sides';
import {parentDir} from '@/lib/storage/entries';
import type {FileEntry, Storage} from '@/lib/storage/storage';

/**
 * The two halves of Lemonade's cache, as paths within the `lemonade` root,
 * and optionally the root above them (`''`).
 *
 * The root matters because sorting entries onto their side and consolidating
 * them are separate steps: a run sorts first, but a preview cannot move
 * anything, so it has to find an unsorted entry where it actually is. Include
 * the root and both agree; leave it out and the preview reports a cache it
 * can't see as empty.
 */
export interface LemonadeSides {
  builtin: string;
  extra: string;
  root?: string;
}

/** Every directory a cache entry might currently be in. Sides first, so an
 *  entry already sorted is found there rather than at the root. */
function cacheDirs(sides: LemonadeSides): string[] {
  return [
    ...LEMONADE_SIDES.map((s) => sides[s]),
    ...(sides.root !== undefined ? [sides.root] : []),
  ];
}

// Root-relative paths are `/`-joined; an empty segment is the root itself.
const join = (...parts: string[]) => parts.filter((p) => p !== '').join('/');
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/**
 * What the two roots hold, by path — the one `list` each that every question
 * below is answered from. A symlink's entry carries its target's size and
 * whether it still resolves, which is all the consolidation needs to know
 * about one.
 */
type Inventory = Map<string, FileEntry>;
interface Inventories {
  tj: Inventory;
  lem: Inventory;
}

const byPath = (entries: FileEntry[]): Inventory =>
  new Map(entries.map((e) => [e.path, e]));

async function inventory(storage: Storage): Promise<Inventories> {
  const [tj, lem] = await Promise.all([
    storage.list('models'),
    storage.list('lemonade'),
  ]);
  return {tj: byPath(tj), lem: byPath(lem)};
}

/** The entries below `dir` (everything, for the root). */
function* under(inv: Inventory, dir: string): Iterable<FileEntry> {
  const prefix = dir ? `${dir}/` : '';
  for (const e of inv.values()) if (e.path.startsWith(prefix)) yield e;
}

/** Whether something is at `path` with a file (or directory) behind it — a
 *  dangling link is nothing there, as following it would find. */
function present(inv: Inventory, path: string): boolean {
  const e = inv.get(path);
  return e !== undefined && !e.dangling;
}

/**
 * Where a repo's cache entry currently is: the first of the searched locations
 * that actually holds one, falling back to where a new entry would be written.
 * A plain path searches only itself, which is what materializing into one
 * specific place wants.
 */
function existingRepoDir(
  lem: Inventory,
  base: string | LemonadeSides,
  repoId: string,
): string {
  const target = typeof base === 'string' ? base : (base.root ?? base.builtin); // an unsorted entry is still at the root
  const searched =
    typeof base === 'string' ? [base] : [base.builtin, base.extra, target];
  for (const dir of searched) {
    const candidate = lemonadeRepoDir(dir, repoId);
    if (present(lem, candidate)) return candidate;
  }
  return lemonadeRepoDir(
    typeof base === 'string' ? base : base.builtin,
    repoId,
  );
}

/** Which side an entry found in `dir` counts as being on. An entry still at the
 *  root is reported as the side it is headed for. */
function sideOfDir(
  dir: string,
  sides: LemonadeSides,
  repoId: string,
  listed: Set<string>,
): LemonadeSide {
  if (dir === sides.extra) return 'extra';
  if (dir === sides.builtin) return 'builtin';
  return sideFor(repoId, listed);
}

// Sync Lemonade and Turbo Jumbo so a single copy on disk serves both, via the
// Lemonade HuggingFace-cache layout `models--<org>--<repo>/snapshots/<rev>/…`
// pointing at Turbo Jumbo's flat mirror `<tj>/<org>/<repo>/…`:
//  - a file only in Lemonade is moved into Turbo Jumbo and symlinked back;
//  - a file Turbo Jumbo already holds an identical copy of has its Lemonade
//    duplicate deleted and symlinked;
//  - a catalog model's Turbo Jumbo files that Lemonade hasn't cached are
//    materialized into the Lemonade cache as symlinks, whether the cache entry
//    is absent or merely incomplete (see materializeLemonadeModel).

const REPO_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface LemonadeRepo {
  repoId: string;
  rev: string; // snapshot revision (repo HEAD) — names the snapshots/<rev>/ dir
  dir: string; // the models--<org>--<repo> directory, within the lemonade root
}

export type SyncFileStatus =
  | 'linked' // moved to Turbo Jumbo and replaced with a symlink
  | 'deduplicated' // an identical Turbo Jumbo copy existed — Lemonade dup deleted, symlinked
  | 'materialized' // Turbo Jumbo had it, Lemonade didn't — created a Lemonade symlink
  | 'already-linked' // the Lemonade entry was already a symlink — left alone
  | 'stale-removed' // the entry was a dangling symlink (target gone) — deleted
  | 'entry-removed' // the whole cache entry was an empty husk — deleted
  | 'skipped' // Turbo Jumbo holds a *different* file — left alone
  | 'error';

/** The repoPath used for a result about the cache entry itself rather than a
 *  file inside it. */
export const EMPTY_ENTRY = '(empty cache entry)';

export interface SyncFileResult {
  repoPath: string;
  status: SyncFileStatus;
  message?: string;
}

export interface SyncModelResult {
  repoId: string;
  rev: string;
  files: SyncFileResult[];
}

/** Decode a `models--<org>--<repo>` directory name into its repo id, or null. */
export function decodeRepoDir(dirName: string): string | null {
  if (!dirName.startsWith('models--')) return null;
  const repoId = dirName.slice('models--'.length).replaceAll('--', '/');
  return REPO_ID_RE.test(repoId) ? repoId : null;
}

/** The snapshot revision for a cache repo dir: `refs/main` when present, else
 *  the sole `snapshots/` entry. Null when it can't be resolved unambiguously. */
async function resolveRev(
  storage: Storage,
  lem: Inventory,
  repoDir: string,
): Promise<string | null> {
  const refPath = join(repoDir, 'refs', 'main');
  if (present(lem, refPath)) {
    try {
      const ref = new TextDecoder()
        .decode(await storage.read({root: 'lemonade', path: refPath}))
        .trim();
      if (ref) return ref;
    } catch {
      /* unreadable refs/main — fall back to the snapshots dir */
    }
  }
  const snapshots = join(repoDir, 'snapshots');
  const snaps = [...under(lem, snapshots)].filter(
    (e) => e.kind === 'dir' && parentDir(e.path) === snapshots,
  );
  if (snaps.length === 1) return basename(snaps[0].path);
  return null;
}

/** The cache repos directly under `dir`, with their resolved revisions, from
 *  the inventory. Dirs that aren't `models--…` or whose revision can't be
 *  resolved are skipped. */
async function reposIn(
  storage: Storage,
  lem: Inventory,
  dir: string,
): Promise<LemonadeRepo[]> {
  const out: LemonadeRepo[] = [];
  for (const e of under(lem, dir)) {
    if (e.kind !== 'dir' || parentDir(e.path) !== dir) continue;
    const repoId = decodeRepoDir(basename(e.path));
    if (!repoId) continue;
    const rev = await resolveRev(storage, lem, e.path);
    if (!rev) continue;
    out.push({repoId, rev, dir: e.path});
  }
  return out;
}

/** Every Lemonade cache repo directly under `dir` (a path within the lemonade
 *  root; `''` for the root), with its resolved revision. */
export async function listLemonadeRepos(
  storage: Storage,
  dir: string,
): Promise<LemonadeRepo[]> {
  return reposIn(storage, byPath(await storage.list('lemonade')), dir);
}

// A file somewhere under a snapshot, with its path relative to the snapshot.
// Symlinks are returned too (so an already-synced entry is visible), flagged
// so the caller leaves them be. Directories are walked, not returned.
interface SnapshotEntry {
  repoPath: string;
  path: string; // within the lemonade root
  isSymlink: boolean;
  dangling: boolean;
  size: number;
}

function snapshotEntries(lem: Inventory, snapshotDir: string): SnapshotEntry[] {
  const out: SnapshotEntry[] = [];
  for (const e of under(lem, snapshotDir)) {
    if (e.kind === 'dir') continue;
    out.push({
      repoPath: e.path.slice(snapshotDir.length + 1),
      path: e.path,
      isSymlink: e.kind === 'symlink',
      dangling: e.dangling === true,
      size: e.size,
    });
  }
  return out;
}

/** Whether Turbo Jumbo already holds a copy of `repoId` (its flat dir exists and
 *  is non-empty) — such a model isn't "Lemonade-only" and is left untouched. */
function tjHasModel(tj: Inventory, repoId: string): boolean {
  for (const _ of under(tj, repoId)) return true;
  return false;
}

/** Lemonade repos under `lemonadeDir` that don't yet exist in Turbo Jumbo —
 *  the sync candidates. */
export async function findLemonadeOnlyRepos(
  storage: Storage,
  lemonadeDir: string,
): Promise<LemonadeRepo[]> {
  const inv = await inventory(storage);
  const repos = await reposIn(storage, inv.lem, lemonadeDir);
  return repos.filter((r) => !tjHasModel(inv.tj, r.repoId));
}

export interface LemonadeSyncPreview {
  repoId: string;
  /** Which half of the cache this entry lives on, or is headed for. */
  side: LemonadeSide;
  rev: string; // empty when blocked — there is no revision to show
  moveCount: number; // Lemonade-only files that would move into Turbo Jumbo
  dedupCount: number; // files Turbo Jumbo already holds — Lemonade copy deleted
  linkCount: number; // files to materialize as Lemonade symlinks into Turbo Jumbo
  staleCount: number; // dangling snapshot symlinks (target gone) to delete
  // The entry has no files left at all: refs/main and an empty snapshot, which
  // Lemonade still reads as a downloaded model. The whole entry goes.
  emptyEntry?: boolean;
  // A model the sync wants to materialize but can't: its sidecar records no
  // repoCommit, so there's no revision to name the snapshot dir. Surfaced so
  // "nothing to sync" isn't conflated with "can't sync"; a run skips it.
  blocked?: 'no-revision';
}

/** The models a sync would change, split into files to move, deduplicate, or
 *  link (materialize). Read-only — touches no files; uses the same per-file
 *  plans as the executor, so the preview and the run agree. Models with no
 *  actionable files are omitted. */
export async function previewLemonadeSync(
  storage: Storage,
  sides: LemonadeSides,
  catalogRepoIds: string[] = [],
  listed?: Set<string>,
): Promise<LemonadeSyncPreview[]> {
  const inv = await inventory(storage);
  const out: LemonadeSyncPreview[] = [];
  // Cache repos on both sides: move/dedup. Consolidation doesn't care which
  // half an entry sits on — a Lemonade-only file is worth pulling into Turbo
  // Jumbo wherever Lemonade keeps it.
  const listedSet = listed ?? new Set(catalogRepoIds);
  for (const dir of cacheDirs(sides)) {
    for (const repo of await reposIn(storage, inv.lem, dir)) {
      const entries = snapshotEntries(
        inv.lem,
        join(repo.dir, 'snapshots', repo.rev),
      );
      let moveCount = 0;
      let dedupCount = 0;
      let staleCount = 0;
      for (const entry of entries) {
        const {action} = planFile(inv.tj, repo.repoId, entry);
        if (action === 'move') moveCount++;
        else if (action === 'dedup') dedupCount++;
        else if (action === 'stale') staleCount++;
      }
      const emptyEntry = entries.length === 0;
      if (emptyEntry || moveCount + dedupCount + staleCount > 0)
        out.push({
          repoId: repo.repoId,
          side: sideOfDir(dir, sides, repo.repoId, listedSet),
          rev: repo.rev,
          moveCount,
          dedupCount,
          linkCount: 0,
          staleCount,
          ...(emptyEntry ? {emptyEntry: true} : {}),
        });
    }
  }
  // Catalog models to materialize, always into the side Lemonade reads as its
  // own: these are the models it lists.
  for (const repoId of catalogRepoIds) {
    const plan = await planMaterialize(storage, inv, sides, repoId);
    if (!plan) continue;
    if (plan.rev === null) {
      out.push({
        repoId,
        side: 'builtin',
        rev: '',
        moveCount: 0,
        dedupCount: 0,
        linkCount: 0,
        staleCount: 0,
        blocked: 'no-revision',
      });
    } else {
      out.push({
        repoId,
        side: 'builtin',
        rev: plan.rev,
        moveCount: 0,
        dedupCount: 0,
        linkCount: plan.repoPaths.length,
        staleCount: 0,
      });
    }
  }
  return out;
}

// What syncing a single Lemonade snapshot entry will do, shared by the preview
// and the executor so they can't disagree.
//  - move:           no Turbo Jumbo copy yet — relocate the real file there
//  - dedup:          an identical (same-size) Turbo Jumbo copy exists — drop ours
//  - skip-differs:   a Turbo Jumbo copy exists but differs in size — leave it
//  - already-linked: the entry is already a symlink that still resolves
//  - stale:          the entry is a dangling symlink (its target is gone)
type FileAction =
  'move' | 'dedup' | 'skip-differs' | 'already-linked' | 'stale';

interface FilePlan {
  dst: string; // the Turbo Jumbo path this entry maps to, within the models root
  action: FileAction;
}

/** Decide what to do with one snapshot entry. Files are matched by size — the
 *  app validates by size and never live-hashes; for the same in-repo path from
 *  the same repo, equal size means equal bytes. */
function planFile(
  tj: Inventory,
  repoId: string,
  entry: SnapshotEntry,
): FilePlan {
  const dst = join(repoId, entry.repoPath);
  if (entry.isSymlink) {
    // A link whose target no longer exists (e.g. the Turbo Jumbo file it
    // pointed at was deleted) is stale.
    return {dst, action: entry.dangling ? 'stale' : 'already-linked'};
  }
  const dstEntry = tj.get(dst);
  if (!dstEntry || dstEntry.dangling) return {dst, action: 'move'};
  return {
    dst,
    action: entry.size === dstEntry.size ? 'dedup' : 'skip-differs',
  };
}

/** The Lemonade cache directory for a repo: `<dir>/models--<org>--<repo>`. */
function lemonadeRepoDir(dir: string, repoId: string): string {
  return join(dir, `models--${repoId.replaceAll('/', '--')}`);
}

/** Real model files under a Turbo Jumbo model dir, as repo-relative paths, with
 *  our own sidecars (`tjmodel.json`, `*.tjmeta.json`) and the hf CLI's
 *  `.cache/` download metadata excluded — bookkeeping, not model content, so it
 *  is never linked into Lemonade and never makes a weightless dir (the husk a
 *  deletion leaves behind) count as a held model. */
function listTjFiles(tj: Inventory, repoId: string): string[] {
  const out: string[] = [];
  for (const e of under(tj, repoId)) {
    if (e.kind !== 'file') continue;
    const rel = e.path.slice(repoId.length + 1);
    if (rel === '.cache' || rel.startsWith('.cache/')) continue;
    if (rel === MODEL_SIDECAR_NAME || rel.endsWith('.tjmeta.json')) continue;
    out.push(rel);
  }
  return out;
}

/** Fallback revision for a model with no cache entry and no model sidecar:
 *  the shared `sourceCommit` of the files' own `*.tjmeta.json` records — a
 *  fresh download writes those before anything creates `tjmodel.json`. Null
 *  when any file lacks a commit or they disagree: a snapshot dir named after
 *  one file's revision would lie about the others. */
async function revFromFileMeta(
  storage: Storage,
  tj: Inventory,
  repoId: string,
  repoPaths: string[],
): Promise<string | null> {
  let shared: string | null = null;
  for (const p of repoPaths) {
    const metaPath = join(repoId, `${p}.tjmeta.json`);
    if (!present(tj, metaPath)) return null;
    let commit: unknown;
    try {
      const raw = new TextDecoder().decode(
        await storage.read({root: 'models', path: metaPath}),
      );
      commit = (JSON.parse(raw) as {sourceCommit?: unknown}).sourceCommit;
    } catch {
      return null;
    }
    if (typeof commit !== 'string' || commit === '') return null;
    if (shared === null) shared = commit;
    else if (shared !== commit) return null;
  }
  return shared;
}

/** What materializing `repoId` into Lemonade would entail: the Turbo Jumbo
 *  files its cache snapshot doesn't hold yet — per-file, so an existing entry
 *  gains the files it lacks (e.g. a quant downloaded after the entry was
 *  created). The snapshot revision is the existing entry's own (refs/main or
 *  its sole snapshot), so new links join it rather than opening a second
 *  snapshot; a fresh entry uses the sidecar's recorded repoCommit. Null when
 *  there's nothing to do: Turbo Jumbo doesn't hold the model, or every file is
 *  already in the snapshot (a resolving symlink or real file counts; presence
 *  follows links, so a dangling one reads as absent and gets replaced once the
 *  consolidation pass has cleared it). `rev: null` when the model is a
 *  candidate but no revision can name the snapshot dir, so it's blocked rather
 *  than actionable. Shared by the preview and the executor so they agree. */
async function planMaterialize(
  storage: Storage,
  inv: Inventories,
  lemonadeBase: string | LemonadeSides,
  repoId: string,
): Promise<{rev: string | null; repoPaths: string[]} | null> {
  const tjPaths = listTjFiles(inv.tj, repoId);
  if (tjPaths.length === 0) return null;
  // Where the entry already is, which need not be where it will end up: an
  // unsorted one still sits at the cache root. Looking only where it belongs
  // would read every cached file as absent and promise links that sorting the
  // cache makes unnecessary.
  const repoDir = existingRepoDir(inv.lem, lemonadeBase, repoId);
  // Revision, most authoritative first: the cache entry's own; the sidecar's
  // repo-level commit; the sidecar's file-derived commit (unless the files
  // disagree); the files' own tjmeta records (a fresh HF download has those
  // before anything writes tjmodel.json).
  const sidecar = await readModelSidecar({storage, root: 'models'}, repoId);
  const rev =
    (await resolveRev(storage, inv.lem, repoDir)) ??
    sidecar?.repoCommit ??
    (sidecar?.sourceCommit !== MIXED_COMMIT ? sidecar?.sourceCommit : null) ??
    (await revFromFileMeta(storage, inv.tj, repoId, tjPaths));
  if (rev === null) return {rev, repoPaths: tjPaths};
  const snapshotDir = join(repoDir, 'snapshots', rev);
  const repoPaths = tjPaths.filter(
    (p) => !present(inv.lem, join(snapshotDir, p)),
  );
  return repoPaths.length > 0 ? {rev, repoPaths} : null;
}

/**
 * Mirror a Turbo-Jumbo-resident model into Lemonade's cache as symlinks: for a
 * model Lemonade's catalog lists and Turbo Jumbo holds, create
 * `models--<org>--<repo>/snapshots/<rev>/<repoPath>` links to the Turbo Jumbo
 * files the snapshot doesn't hold yet, plus `refs/main`, so Lemonade sees it as
 * downloaded — filling gaps in an existing cache entry as well as creating a
 * fresh one. The revision is the entry's own when one exists, else the model's
 * recorded `repoCommit` (the repo HEAD). Returns null when there's nothing to
 * do (see `planMaterialize`). `lemonadeDir` is where the entry goes, within
 * the lemonade root.
 */
export async function materializeLemonadeModel(
  storage: Storage,
  lemonadeDir: string,
  repoId: string,
  inv?: Inventories,
): Promise<SyncModelResult | null> {
  inv ??= await inventory(storage);
  const plan = await planMaterialize(storage, inv, lemonadeDir, repoId);
  if (!plan || plan.rev === null) return null;
  const {rev, repoPaths} = plan;
  const repoDir = lemonadeRepoDir(lemonadeDir, repoId);
  const snapshotDir = join(repoDir, 'snapshots', rev);
  const files: SyncFileResult[] = [];
  for (const repoPath of repoPaths) {
    try {
      // The link's target is absolute once the storage resolves it, so it
      // holds wherever Lemonade reads it from.
      await storage.link([
        {
          target: {root: 'models', path: join(repoId, repoPath)},
          at: {root: 'lemonade', path: join(snapshotDir, repoPath)},
        },
      ]);
      files.push({repoPath, status: 'materialized'});
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.warn(
        `[lemonade-sync] materialize ${repoId}/${repoPath}: ${message}`,
      );
      files.push({repoPath, status: 'error', message});
    }
  }
  // Pin the branch to the revision, as huggingface_hub's cache does.
  try {
    await storage.write(
      {root: 'lemonade', path: join(repoDir, 'refs', 'main')},
      new TextEncoder().encode(rev),
    );
  } catch (e) {
    logger.warn(
      `[lemonade-sync] refs/main for ${repoId}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  return {repoId, rev, files};
}

/**
 * Sync one Lemonade repo into Turbo Jumbo so a single copy on disk serves both.
 * Per snapshot file: a file with no Turbo Jumbo copy is **moved** there and the
 * Lemonade entry becomes a symlink to it; a file Turbo Jumbo already holds an
 * identical (same-size) copy of is **deduplicated** — the Lemonade copy is
 * deleted and replaced with a symlink; a file Turbo Jumbo holds a *different*
 * copy of, or one already symlinked, is left untouched (no overwrite, no data
 * loss); a **stale** symlink — one whose target no longer exists — is deleted,
 * since it only misleads Lemonade's cache scan. Moved files are recorded in
 * `tjmodel.json` with the snapshot revision
 * as the model's `repoCommit`; deduplicated files already have a Turbo Jumbo
 * sidecar and aren't rewritten.
 */
export async function syncLemonadeRepo(
  storage: Storage,
  repo: LemonadeRepo,
  inv?: Inventories,
): Promise<SyncModelResult> {
  inv ??= await inventory(storage);
  const snapshotDir = join(repo.dir, 'snapshots', repo.rev);
  const entries = snapshotEntries(inv.lem, snapshotDir);
  const files: SyncFileResult[] = [];
  const movedEntries: TjModelFile[] = [];

  // An entry with nothing left in its snapshot: the weights were archived and
  // deleted, and a previous run dropped the links that then dangled. What
  // remains — refs/main and an empty snapshot directory — is what Lemonade
  // reads to decide a model is downloaded, so the husk keeps a model it cannot
  // load on its list. Drop the whole entry. A model that is still available
  // gets a proper one back from the materialize pass.
  if (entries.length === 0) {
    try {
      await storage.remove([{root: 'lemonade', path: repo.dir}]);
      logger.info(`[lemonade-sync] removed empty cache entry ${repo.repoId}`);
      return {
        repoId: repo.repoId,
        rev: repo.rev,
        files: [{repoPath: EMPTY_ENTRY, status: 'entry-removed'}],
      };
    } catch (e) {
      return {
        repoId: repo.repoId,
        rev: repo.rev,
        files: [
          {
            repoPath: EMPTY_ENTRY,
            status: 'error',
            message: e instanceof Error ? e.message : String(e),
          },
        ],
      };
    }
  }

  for (const entry of entries) {
    try {
      const {dst, action} = planFile(inv.tj, repo.repoId, entry);
      const at = {root: 'lemonade' as const, path: entry.path};
      const target = {root: 'models' as const, path: dst};
      if (action === 'already-linked') {
        files.push({repoPath: entry.repoPath, status: 'already-linked'});
        continue;
      }
      if (action === 'stale') {
        // The link's target is gone (e.g. its Turbo Jumbo file was deleted);
        // a dangling link only misleads Lemonade's cache scan, so drop it.
        await storage.remove([at]);
        files.push({repoPath: entry.repoPath, status: 'stale-removed'});
        continue;
      }
      if (action === 'skip-differs') {
        files.push({
          repoPath: entry.repoPath,
          status: 'skipped',
          message: 'a different file exists in Turbo Jumbo',
        });
        continue;
      }
      if (action === 'dedup') {
        // Turbo Jumbo already holds an identical copy: drop the Lemonade
        // duplicate and point its slot at the Turbo Jumbo file (absolute once
        // resolved, so the link holds wherever it's read from).
        await storage.remove([at]);
        await storage.link([{target, at}]);
        files.push({repoPath: entry.repoPath, status: 'deduplicated'});
        continue;
      }
      // move: relocate the only copy into Turbo Jumbo, then symlink it back.
      await storage.move(at, target);
      await storage.link([{target, at}]);
      movedEntries.push({
        path: entry.repoPath,
        originUrl: `https://huggingface.co/${repo.repoId}/blob/main/${entry.repoPath}`,
        sourceSize: 0,
        computedSize: entry.size,
        sourceSha256: '',
        computedSha256: '',
      });
      files.push({repoPath: entry.repoPath, status: 'linked'});
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.warn(
        `[lemonade-sync] ${repo.repoId}/${entry.repoPath}: ${message}`,
      );
      files.push({repoPath: entry.repoPath, status: 'error', message});
    }
  }

  // Record provenance for what landed in Turbo Jumbo: the snapshot revision is
  // the repo HEAD, stored as the model-level repoCommit.
  for (const entry of movedEntries) {
    try {
      await upsertFileMeta(
        {storage, root: 'models'},
        repo.repoId,
        repo.repoId,
        entry,
        {id: repo.rev},
      );
    } catch (e) {
      logger.warn(
        `[lemonade-sync] sidecar for ${repo.repoId}/${entry.path}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  return {repoId: repo.repoId, rev: repo.rev, files};
}

/**
 * Sync Lemonade and Turbo Jumbo so a single copy on disk serves both. Two
 * passes: (1) consolidate Lemonade's on-disk cache into Turbo Jumbo — move
 * Lemonade-only files in, deduplicate files Turbo Jumbo already holds; (2) for
 * each catalog repo in `catalogRepoIds` that Turbo Jumbo has but Lemonade hasn't
 * cached, materialize a Lemonade cache entry of symlinks into Turbo Jumbo.
 * Idempotent — a model needing no change is omitted. Returns a per-model,
 * per-file summary of the models that changed.
 */
export async function syncLemonadeToTurboJumbo(
  storage: Storage,
  sides: LemonadeSides,
  catalogRepoIds: string[] = [],
): Promise<SyncModelResult[]> {
  const out: SyncModelResult[] = [];
  // Pass 1: Lemonade cache → Turbo Jumbo (move + dedup), everywhere an entry
  // may be — including the root, since sorting is skipped when the catalog
  // couldn't be reached and the cache is still worth consolidating. One
  // inventory serves the pass: each repo's changes stay under its own paths.
  let inv = await inventory(storage);
  for (const dir of cacheDirs(sides)) {
    for (const repo of await reposIn(storage, inv.lem, dir)) {
      const result = await syncLemonadeRepo(storage, repo, inv);
      if (
        result.files.some(
          (f) =>
            f.status === 'linked' ||
            f.status === 'deduplicated' ||
            f.status === 'stale-removed' ||
            f.status === 'entry-removed',
        )
      ) {
        out.push(result);
      }
    }
  }
  // Pass 2: Turbo Jumbo → Lemonade cache (materialize catalog models as links),
  // into the half Lemonade treats as its own — from a fresh inventory, since
  // pass 1 is what put the files there.
  inv = await inventory(storage);
  for (const repoId of catalogRepoIds) {
    const result = await materializeLemonadeModel(
      storage,
      sides.builtin,
      repoId,
      inv,
    );
    if (result?.files.some((f) => f.status === 'materialized'))
      out.push(result);
  }
  return out;
}
