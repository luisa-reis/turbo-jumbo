import type {Storage} from '@/lib/storage/storage';
import type {SyncModelResult} from '@/lib/lemonade/lemonade-sync';
import type {Placement} from '@/lib/lemonade/lemonade-place';

/**
 * Making Lemonade re-read its HuggingFace cache after the sync changed it.
 *
 * Lemonade decides which models are downloaded once, when it builds its model
 * list, and keeps that answer until something invalidates the list. Links the
 * sync makes in its cache are invisible to it until then: the checkpoints read
 * as present, the model still as not downloaded. One thing that invalidates
 * the whole list is a change in the extra-models directory, which Lemonade
 * watches — so creating and removing a marker file there makes it rebuild,
 * re-checking every model, without a pull (which would re-verify, and could
 * download, gigabytes) or a restart.
 */

/** The marker, at the top of the extra-models directory Lemonade watches. */
export const REFRESH_MARKER = {
  root: 'lemonade' as const,
  path: 'extra/.tj-refresh',
};

const CHANGED = new Set([
  'linked',
  'deduplicated',
  'materialized',
  'stale-removed',
  'entry-removed',
]);

/** Whether the sync changed what Lemonade's cache holds. */
export function cacheChanged(
  results: SyncModelResult[],
  placement: Placement[],
): boolean {
  return (
    placement.some((p) => p.status === 'moved') ||
    results.some((r) => r.files.some((f) => CHANGED.has(f.status)))
  );
}

export async function refreshLemonadeList(
  storage: Storage,
): Promise<{ok: boolean; message?: string}> {
  try {
    await storage.write(REFRESH_MARKER, new Uint8Array());
    await storage.remove([REFRESH_MARKER]);
    return {ok: true};
  } catch (e) {
    return {ok: false, message: e instanceof Error ? e.message : String(e)};
  }
}
