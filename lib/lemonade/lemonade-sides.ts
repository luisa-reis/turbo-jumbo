/**
 * Which half of Lemonade's cache a repo belongs in.
 *
 * Lemonade's cache is split in two (see `lemonadeBuiltinDir` /
 * `lemonadeExtraDir`): `builtin` for the models Lemonade knows about itself,
 * `extra` for everything else. Both are ordinary Hugging Face cache trees, so
 * Lemonade can be pointed at either — the split is about provenance, not format.
 *
 * "Knows about itself" means listed in the catalog it serves, or served as a
 * FastFlowLM tag. FLM models appear in no catalog file at all — they are
 * discovered from a live server's `flm` binary — but Lemonade plainly knows
 * them, so they belong beside the catalog's own.
 */

export type LemonadeSide = 'builtin' | 'extra';

export const LEMONADE_SIDES: readonly LemonadeSide[] = ['builtin', 'extra'];

/**
 * The repos Lemonade knows, as one set to test membership against.
 *
 * Both inputs are best effort: a catalog that couldn't be fetched or an `flm`
 * binary that didn't answer yields fewer ids, never wrong ones. That matters
 * for what callers do with an empty set — see `placeRepos`, which declines to
 * move anything when it can't tell listed from unlisted.
 */
export function listedRepoIds(
  catalogRepoIds: Iterable<string>,
  flmRepoIds: Iterable<string> = [],
): Set<string> {
  return new Set([...catalogRepoIds, ...flmRepoIds]);
}

/** Which side `repoId` belongs on, given what Lemonade is known to list. */
export function sideFor(repoId: string, listed: Set<string>): LemonadeSide {
  return listed.has(repoId) ? 'builtin' : 'extra';
}
