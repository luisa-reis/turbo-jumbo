import {
  localModelsDir,
  lemonadeDir,
  lemonadeBuiltinDir,
  lemonadeExtraDir,
} from '@/lib/config';
import {
  catalogRepoIds,
  parseLemonade,
  LEMONADE_CATALOG_URL,
} from '@/lib/lemonade/lemonade';
import {FLM_REGISTRY_URL, parseFlmRegistry} from '@/lib/lemonade/flm-registry';
import {listedRepoIds} from '@/lib/lemonade/lemonade-sides';
import {
  placeRepos,
  planPlacement,
  type Placement,
} from '@/lib/lemonade/lemonade-place';
import {
  planExtraModels,
  previewExtraModels,
  syncExtraModels,
  type ExtraChange,
  type ExtraModelPlan,
} from '@/lib/lemonade/lemonade-extra';
import {scanModels} from '@/lib/models/models';
import {storage} from '@/lib/storage/storage-instance';
import {
  previewLemonadeSync,
  syncLemonadeToTurboJumbo,
  type LemonadeSides,
  type LemonadeSyncPreview,
  type SyncModelResult,
} from '@/lib/lemonade/lemonade-sync';

// Shared Lemonade↔Turbo Jumbo consolidation handlers. The work always runs on
// the machine whose config is loaded here, so both the local route and the
// per-peer route (its local branch) call these against their own config —
// a remote peer consolidates its own Lemonade cache into its own store.

// The HuggingFace repos Lemonade's catalog references — best-effort, since the
// materialize pass is a bonus on top of cache consolidation. An unreachable
// catalog just yields no materialize candidates.
async function fetchCatalogRepoIds(): Promise<string[]> {
  try {
    const res = await fetch(LEMONADE_CATALOG_URL, {
      headers: {'User-Agent': 'tj/1.0'},
    });
    if (!res.ok) return [];
    return catalogRepoIds(parseLemonade(await res.json()));
  } catch {
    return [];
  }
}

// The repos behind FastFlowLM's tags. They are in no catalog file, but Lemonade
// serves them, so they belong on its own side of the cache. Read from the
// registry rather than a live server: the registry lists every tag's repo, and
// asking it doesn't depend on Lemonade running right now.
async function fetchFlmRepoIds(): Promise<string[]> {
  try {
    const res = await fetch(FLM_REGISTRY_URL, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    return [...parseFlmRegistry(await res.json()).values()].map(
      (s) => s.repoId,
    );
  } catch {
    return [];
  }
}

/** Everything the sync needs to know about what Lemonade lists, fetched once. */
async function lemonadeKnowledge(): Promise<{
  catalog: string[];
  listed: Set<string>;
}> {
  const [catalog, flm] = await Promise.all([
    fetchCatalogRepoIds(),
    fetchFlmRepoIds(),
  ]);
  return {catalog, listed: listedRepoIds(catalog, flm)};
}

/**
 * What to offer Lemonade in its extra-models directory: the models this machine
 * holds on fast storage that Lemonade's own lists don't cover.
 *
 * Local storage only. A model that lives solely in cold storage has no fast
 * copy to point at, and an entry reaching into the archive would be one
 * Lemonade could open but shouldn't — serving a model off the slow tier
 * without saying so.
 */
function extraPlans(listed: Set<string>): ExtraModelPlan[] {
  if (!localModelsDir) return [];
  const unlisted = scanModels(localModelsDir, lemonadeDir).filter(
    (m) => !listed.has(m.name),
  );
  return planExtraModels(unlisted);
}

function sides(): LemonadeSides | null {
  if (!lemonadeBuiltinDir || !lemonadeExtraDir) return null;
  return {
    builtin: lemonadeBuiltinDir,
    extra: lemonadeExtraDir,
    // Entries an older version left here are still part of the cache.
    ...(lemonadeDir ? {root: lemonadeDir} : {}),
  };
}

export interface SyncPreview {
  preview: LemonadeSyncPreview[];
  /** Cache entries sitting on the wrong side of the split, or at the old
   *  single-directory root. Empty once everything is where it belongs. */
  placement: Placement[];
  /** Links to add to or drop from Lemonade's extra-models directory. */
  extra: ExtraChange[];
}

// Preview the changes a sync would make (read-only). Returns an empty preview
// when Lemonade is not configured on this machine.
export async function previewSync(): Promise<SyncPreview> {
  const s = sides();
  if (!localModelsDir || !lemonadeDir || !s)
    return {preview: [], placement: [], extra: []};
  const {catalog, listed} = await lemonadeKnowledge();
  const [placement, preview, extra] = await Promise.all([
    planPlacement(lemonadeDir, listed),
    previewLemonadeSync(localModelsDir, s, catalog, listed),
    previewExtraModels(storage, extraPlans(listed)),
  ]);
  return {
    preview,
    placement: placement.filter((p) => p.status !== 'in-place'),
    extra,
  };
}

// Execute the sync. Returns null when Lemonade is not configured so callers can
// surface the right error.
export async function runSync(): Promise<{
  results: SyncModelResult[];
  placement: Placement[];
  extra: ExtraChange[];
} | null> {
  const s = sides();
  if (!localModelsDir || !lemonadeDir || !s) return null;
  const {catalog, listed} = await lemonadeKnowledge();
  // Sort the cache before consolidating it, so the passes below see every entry
  // on the side it belongs on rather than wherever it happened to be.
  const placement = await placeRepos(lemonadeDir, listed);
  const results = await syncLemonadeToTurboJumbo(localModelsDir, s, catalog);
  // Last, because it reflects what local storage holds once the passes above
  // have finished moving things into it.
  const extra = await syncExtraModels(storage, extraPlans(listed));
  return {
    results,
    placement: placement.filter((p) => p.status !== 'in-place'),
    extra,
  };
}
