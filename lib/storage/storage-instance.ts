/**
 * The `Storage` this server acts through, wired from config once.
 *
 * Server-only: `lib/config` reads config.yaml at module load. Callers that
 * need storage import this; callers that need to be testable take a `Storage`
 * as an argument instead, so nothing but this file decides which one is real.
 */

import {localModelsDir, coldStorageDir, lemonadeDir} from '@/lib/config';
import {createLocalStorage} from '@/lib/storage/local-storage';
import type {Storage} from '@/lib/storage/storage';

export const storage: Storage = createLocalStorage({
  models: localModelsDir,
  cold: coldStorageDir,
  lemonade: lemonadeDir,
});
