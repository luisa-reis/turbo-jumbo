import type {FlmSource} from '@/lib/lemonade/flm';
import {cachedFlmRegistry, flmRegistryFiles} from '@/lib/lemonade/flm-registry';
import {modelFileScope, modelRevision} from '@/lib/models/model-sidecar';
import type {Site} from '@/lib/storage/site';

/**
 * The files that make a complete copy of `repoId` at `site`, or null when it is
 * judged against its whole repo tree (minus clutter). In order:
 *
 * 1. FastFlowLM's live registry, when it names this repo at the revision the
 *    copy tracks — however the copy arrived (the catalog, a plain HF download,
 *    a copy from another machine), and even if the registry changed since.
 * 2. The scope its sidecar recorded at download time — what holds while the
 *    registry can't be reached (a failed fetch reads as an empty registry).
 * 3. Neither: the whole repo.
 *
 * Every completeness check — the per-file list, the table's incomplete flag,
 * the audit's missing-file verdicts — asks this, so they agree.
 */
export async function completeFileSet(
  site: Site,
  repoId: string,
  registry: () => Promise<Map<string, FlmSource>> = cachedFlmRegistry,
): Promise<Set<string> | null> {
  const revision = await modelRevision(site, repoId);
  const live = flmRegistryFiles(await registry(), repoId, revision);
  if (live) return new Set(live);
  return modelFileScope(site, repoId);
}
