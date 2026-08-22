import {
  localModelsDir,
  localPeer,
  lemonadeApiKey,
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
import {
  planFlmStore,
  previewFlmStore,
  syncFlmStore,
  type FlmStoreChange,
  type FlmStorePlan,
} from '@/lib/lemonade/lemonade-flm-store';
import {
  lemonadeFlmId,
  refreshLemonadeFlm,
  type FlmRefresh,
} from '@/lib/lemonade/lemonade-flm-refresh';
import {
  lemonadeApiBase,
  lemonadeHeaders,
  type FlmSource,
} from '@/lib/lemonade/flm';
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

// FastFlowLM's registry: which repo (and files) each flm tag resolves to. The
// repos are in no catalog file, but Lemonade serves them, so they belong on
// its own side of the cache; the files say whether a held copy is whole
// enough to offer flm. Read from the registry rather than a live server: it
// lists every tag, and asking it doesn't depend on Lemonade running right now.
async function fetchFlmRegistry(): Promise<Map<string, FlmSource>> {
  try {
    const res = await fetch(FLM_REGISTRY_URL, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return new Map();
    return parseFlmRegistry(await res.json());
  } catch {
    return new Map();
  }
}

/** Everything the sync needs to know about what Lemonade lists, fetched once. */
async function lemonadeKnowledge(): Promise<{
  catalog: string[];
  listed: Set<string>;
  registry: Map<string, FlmSource>;
}> {
  const [catalog, registry] = await Promise.all([
    fetchCatalogRepoIds(),
    fetchFlmRegistry(),
  ]);
  const flm = [...registry.values()].map((s) => s.repoId);
  return {catalog, listed: listedRepoIds(catalog, flm), registry};
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

/**
 * What to offer flm: the FLM models this machine holds on fast storage, by
 * the same local-only rule as `extraPlans` — and for the same reason, since a
 * link into the archive would have the NPU serving off the slow tier.
 */
function flmPlans(registry: Map<string, FlmSource>): Promise<FlmStorePlan[]> {
  if (!localModelsDir || registry.size === 0) return Promise.resolve([]);
  return planFlmStore(
    storage,
    scanModels(localModelsDir, lemonadeDir),
    registry,
  );
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
  /** Links to add to or drop from flm's store, and FLM models held but not
   *  whole enough to link. */
  flm: FlmStoreChange[];
}

// Preview the changes a sync would make (read-only). Returns an empty preview
// when Lemonade is not configured on this machine.
export async function previewSync(): Promise<SyncPreview> {
  const s = sides();
  if (!localModelsDir || !lemonadeDir || !s)
    return {preview: [], placement: [], extra: [], flm: []};
  const {catalog, listed, registry} = await lemonadeKnowledge();
  const [placement, preview, extra, flm] = await Promise.all([
    planPlacement(storage, listed),
    previewLemonadeSync(localModelsDir, s, catalog, listed),
    previewExtraModels(storage, extraPlans(listed)),
    flmPlans(registry).then((plans) => previewFlmStore(storage, plans)),
  ]);
  return {
    preview,
    placement: placement.filter((p) => p.status !== 'in-place'),
    extra,
    flm,
  };
}

/**
 * Tell this machine's Lemonade server about links just made in flm's store,
 * when it has one configured. One no-op pull of any model flm finds in place
 * rebuilds its whole list (see lemonade-flm-refresh) — and flm verifies the
 * files of whatever is pulled, so the smallest whole model is the one to ask
 * for, not the one just linked. Without a server to tell, the links are
 * still right — Lemonade picks them up on its next restart.
 */
async function refreshFlm(
  plans: FlmStorePlan[],
  linked: FlmStoreChange[],
): Promise<FlmRefresh | undefined> {
  if (linked.length === 0) return undefined;
  if (!localPeer?.lemonade_url)
    return {
      ok: false,
      message:
        'no lemonade_url for this peer — Lemonade will list the models after its next restart',
    };
  const plan = plans
    .filter((p) => p.missing.length === 0 && p.tags.length > 0)
    .sort((a, b) => a.bytes - b.bytes)[0];
  const tag = plan?.tags[0];
  if (!tag) return undefined;
  return refreshLemonadeFlm(
    lemonadeApiBase(localPeer.lemonade_url),
    lemonadeHeaders(lemonadeApiKey(localPeer)),
    lemonadeFlmId(tag),
  );
}

// Execute the sync. Returns null when Lemonade is not configured so callers can
// surface the right error.
export async function runSync(): Promise<{
  results: SyncModelResult[];
  placement: Placement[];
  extra: ExtraChange[];
  flm: FlmStoreChange[];
  /** Whether Lemonade was told about new flm links. Absent when none were
   *  made. */
  flmRefresh?: FlmRefresh;
} | null> {
  const s = sides();
  if (!localModelsDir || !lemonadeDir || !s) return null;
  const {catalog, listed, registry} = await lemonadeKnowledge();
  // Sort the cache before consolidating it, so the passes below see every entry
  // on the side it belongs on rather than wherever it happened to be.
  const placement = await placeRepos(storage, listed);
  const results = await syncLemonadeToTurboJumbo(localModelsDir, s, catalog);
  // Last, because they reflect what local storage holds once the passes above
  // have finished moving things into it.
  const extra = await syncExtraModels(storage, extraPlans(listed));
  const plans = await flmPlans(registry);
  const flm = await syncFlmStore(storage, plans);
  const flmRefresh = await refreshFlm(
    plans,
    flm.filter((f) => f.status === 'link'),
  );
  return {
    results,
    placement: placement.filter((p) => p.status !== 'in-place'),
    extra,
    flm,
    ...(flmRefresh ? {flmRefresh} : {}),
  };
}
