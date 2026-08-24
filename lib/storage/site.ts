import nodePath from 'path';
import {createLocalStorage} from '@/lib/storage/local-storage';
import type {Root, Storage} from '@/lib/storage/storage';

/**
 * A place policy acts on: a storage and which of its roots. Every
 * fs-flavored module speaks in these; the real ones are minted by
 * storage-instance (this server's own tiers) and peer-storage (another
 * machine's agent). The migration-era union that also accepted a bare
 * directory string is gone — a path only becomes a site explicitly, through
 * `dirSite` below.
 */
export interface Site {
  storage: Storage;
  root: Root;
}

/** The parts of a site. A leftover seam from the migration's union type;
 *  new code may simply destructure the site. */
export function siteStorage(site: Site): Site {
  return site;
}

// One wrapper per directory rather than one per call: a `LocalStorage` holds
// the safetensors-header memo that makes repeated scans cheap, and a fresh
// instance per call would start it empty every time.
const wrappers = new Map<string, Storage>();

/**
 * An arbitrary directory as a site, wrapped in a throwaway local storage —
 * for the callers that genuinely scan ad-hoc directories: the Lemonade
 * cache's two halves, and tests over temp dirs. Production paths use the
 * real sites instead.
 */
export function dirSite(dir: string): Site {
  const full = nodePath.resolve(dir);
  let storage = wrappers.get(full);
  if (!storage) {
    // Which root name the wrapper uses is arbitrary — the storage it creates
    // maps only that one root, onto exactly the directory the caller named.
    storage = createLocalStorage({models: full});
    wrappers.set(full, storage);
  }
  return {storage, root: 'models'};
}
