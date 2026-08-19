import {logger} from '@/lib/util/logger';
import {decodeRepoDir} from '@/lib/lemonade/lemonade-sync';
import {
  LEMONADE_SIDES,
  sideFor,
  type LemonadeSide,
} from '@/lib/lemonade/lemonade-sides';
import type {Storage} from '@/lib/storage/storage';

/**
 * Keeping Lemonade's cache sorted into its two halves.
 *
 * A `models--<org>--<repo>` directory belongs under `builtin` or `extra`
 * depending on whether Lemonade lists the repo, and that answer changes over
 * time: a model sitting in `extra` becomes a `builtin` one the day the catalog
 * picks it up. So this runs on every sync rather than once as a migration, and
 * it also collects entries left at the cache root by the versions that kept
 * everything in one directory.
 *
 * Moving a directory is safe: the symlinks inside it point at absolute Turbo
 * Jumbo paths, so nothing inside has to be rewritten.
 */

export type PlacementStatus =
  /** Relocated to the side it belongs on. */
  | 'moved'
  /** Already there; nothing done. */
  | 'in-place'
  /** The destination side already holds this repo — neither copy touched. */
  | 'conflict'
  | 'error';

export interface Placement {
  repoId: string;
  /** Where it is now, relative to the lemonade root. */
  from: string;
  /** Where it belongs, relative to the lemonade root. */
  to: string;
  side: LemonadeSide;
  status: PlacementStatus;
  message?: string;
}

/** Every `models--*` directory at the cache root and directly under either
 *  side, with where it currently lives (lemonade-root-relative). The root is
 *  included because that is where older versions kept everything. */
async function findRepoDirs(
  storage: Storage,
): Promise<Array<{repoId: string; dir: string}>> {
  const sides = new Set<string>(LEMONADE_SIDES);
  const out: Array<{repoId: string; dir: string}> = [];
  for (const e of await storage.list('lemonade')) {
    if (e.kind !== 'dir') continue;
    const parts = e.path.split('/');
    const atRoot = parts.length === 1;
    const underSide = parts.length === 2 && sides.has(parts[0]);
    if (!atRoot && !underSide) continue;
    const repoId = decodeRepoDir(parts[parts.length - 1]);
    if (!repoId) continue;
    out.push({repoId, dir: e.path});
  }
  return out;
}

/**
 * What placing would do, without doing it.
 *
 * Returns nothing at all when `listed` is empty. An empty set is what a failed
 * catalog fetch looks like, and acting on it would sweep every model into
 * `extra` — pulling Lemonade's whole library out from under it on the strength
 * of a request that didn't answer. Doing nothing is recoverable; that isn't.
 */
export async function planPlacement(
  storage: Storage,
  listed: Set<string>,
): Promise<Placement[]> {
  if (listed.size === 0) return [];
  const out: Placement[] = [];
  const found = await findRepoDirs(storage);
  const occupied = new Set(found.map((f) => f.dir));

  for (const {repoId, dir} of found) {
    const side = sideFor(repoId, listed);
    const name = dir.split('/').pop() ?? dir;
    const target = `${side}/${name}`;
    if (target === dir) {
      out.push({repoId, from: dir, to: target, side, status: 'in-place'});
      continue;
    }
    out.push({
      repoId,
      from: dir,
      to: target,
      side,
      status: occupied.has(target) ? 'conflict' : 'moved',
      ...(occupied.has(target)
        ? {message: `${side} already holds ${repoId}`}
        : {}),
    });
  }
  return out;
}

/**
 * Put every cache entry on the side it belongs on. Returns what happened to
 * each, including the ones already in the right place, so a caller can report
 * the whole picture rather than only the changes.
 *
 * A conflict — the same repo present on both sides — is reported and left
 * alone. One of the two is stale, but which one holds real downloaded bytes and
 * which holds symlinks is not something to guess at with a delete.
 */
export async function placeRepos(
  storage: Storage,
  listed: Set<string>,
): Promise<Placement[]> {
  const planned = await planPlacement(storage, listed);
  const out: Placement[] = [];
  for (const p of planned) {
    if (p.status !== 'moved') {
      out.push(p);
      continue;
    }
    try {
      await storage.move(
        {root: 'lemonade', path: p.from},
        {root: 'lemonade', path: p.to},
      );
      logger.info(`[lemonade-place] ${p.repoId} → ${p.side}`);
      out.push(p);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.warn(`[lemonade-place] ${p.repoId} → ${p.side}: ${message}`);
      out.push({...p, status: 'error', message});
    }
  }
  return out;
}
