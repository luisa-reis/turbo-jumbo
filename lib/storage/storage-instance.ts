/**
 * The `Storage` this server acts through, wired from config once.
 *
 * Server-only: `lib/config` reads config.yaml at module load. Callers that
 * need storage import this; callers that need to be testable take a `Storage`
 * as an argument instead, so nothing but this file decides which one is real.
 */

import {localModelsDir, coldStorageDir, lemonadeDir} from '@/lib/config';
import {createLocalStorage, type Roots} from '@/lib/storage/local-storage';
import type {Site} from '@/lib/storage/site';
import type {Storage} from '@/lib/storage/storage';

/** The directories behind this server's roots — also what the agent handlers
 *  need for their byte endpoints, which work past the small-file cap that
 *  keeps weights out of `read`/`write`. */
export const storageRoots: Roots = {
  models: localModelsDir,
  cold: coldStorageDir,
  lemonade: lemonadeDir,
};

export const storage: Storage = createLocalStorage(storageRoots);

/** This host's tiers as sites — undefined where a tier isn't configured, so
 *  `scanModels(localModelsSite)`-style callers keep their empty answer on a
 *  machine without one. */
export const localModelsSite: Site | undefined = localModelsDir
  ? {storage, root: 'models'}
  : undefined;
export const coldStorageSite: Site | undefined = coldStorageDir
  ? {storage, root: 'cold'}
  : undefined;
export const lemonadeSite: Site | undefined = lemonadeDir
  ? {storage, root: 'lemonade'}
  : undefined;
