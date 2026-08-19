import {createLocalStorage} from '@/lib/storage/local-storage';
import type {Root, Storage} from '@/lib/storage/storage';

/**
 * Transitional bridge for the Storage migration. Modules whose own I/O has
 * moved behind `Storage` accept either the old base-path string or a
 * `{storage, root}` pair; the string arm wraps the path in a throwaway local
 * storage so not-yet-migrated callers keep compiling unchanged, and each
 * caller's own migration step is just swapping the argument. Delete this
 * module — and the string arm with it — once every caller passes a real site.
 */
export type Site = string | {storage: Storage; root: Root};

export function siteStorage(site: Site): {storage: Storage; root: Root} {
  if (typeof site !== 'string') return site;
  // Which root name the wrapper uses is arbitrary — the storage it creates
  // maps only that one root, onto exactly the directory the caller named.
  return {storage: createLocalStorage({models: site}), root: 'models'};
}
