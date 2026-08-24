import {scanModels} from '@/lib/models/models';
import {dirSite} from '@/lib/storage/site';
import type {Model} from '@/lib/models/model-types';
import {LEMONADE_SIDES, type LemonadeSide} from '@/lib/lemonade/lemonade-sides';

/** The two halves of Lemonade's cache as directories to scan — absolute, the
 *  transitional string form of a site (see `lib/storage/site`). */
export interface LemonadeCacheDirs {
  builtin: string;
  extra: string;
}

/**
 * A model found in Lemonade's cache, carrying which half it was found on.
 *
 * It extends `Model` rather than wrapping it so every existing consumer — the
 * catalog's presence checks, the browser's inventory — keeps taking the list as
 * it always did, and only the callers that care about the split look at `side`.
 */
export interface CachedModel extends Model {
  side: LemonadeSide;
}

/**
 * Scan both halves of Lemonade's cache as one list.
 *
 * The cache is two Hugging Face trees now, and a model is in Lemonade if it is
 * in either — which half only says whether Lemonade lists the model itself.
 */
export async function scanLemonadeCache(
  sides: LemonadeCacheDirs,
): Promise<CachedModel[]> {
  const scans = await Promise.all(
    LEMONADE_SIDES.map(async (side) =>
      (await scanModels(dirSite(sides[side]))).map((m) => ({...m, side})),
    ),
  );
  return scans.flat();
}
