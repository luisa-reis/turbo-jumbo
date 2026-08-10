import type {DiskUsage, DownloadDiskUsage} from '@/lib/storage/disk-space';
import type {Storage} from '@/lib/storage/storage';

export type {DiskUsage, DownloadDiskUsage} from '@/lib/storage/disk-space';

/**
 * Free/total bytes of the filesystems a download touches: the models
 * directory it lands in, and cold storage as the optional copy target.
 *
 * `sameDevice` is the part callers can't work out for themselves — when both
 * roots sit on one filesystem their free space is a single pool, so a kept
 * copy needs room for two and a moved one for one.
 *
 * Takes the storage rather than reaching for the module-level instance, so a
 * test can answer with numbers instead of needing two real filesystems.
 */
export async function downloadDiskUsage(
  storage: Pick<Storage, 'usage'>,
): Promise<DownloadDiskUsage> {
  const [models, cold] = await Promise.all([
    storage.usage('models'),
    storage.usage('cold'),
  ]);
  const plain = (u: {free: number; total: number}): DiskUsage => ({
    free: u.free,
    total: u.total,
  });
  return {
    models: plain(models),
    cold: plain(cold),
    sameDevice: models.device === cold.device,
  };
}
