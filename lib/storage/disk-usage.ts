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
 * test can answer with numbers instead of needing two real filesystems — and
 * which roots the host has, since the interface can't be asked. An absent
 * root reports null; a present one that fails to stat is still an error.
 */
export async function downloadDiskUsage(
  storage: Pick<Storage, 'usage'>,
  roots: {models: boolean; cold: boolean},
): Promise<DownloadDiskUsage> {
  const [models, cold] = await Promise.all([
    roots.models ? storage.usage('models') : null,
    roots.cold ? storage.usage('cold') : null,
  ]);
  const plain = (u: {free: number; total: number}): DiskUsage => ({
    free: u.free,
    total: u.total,
  });
  return {
    models: models && plain(models),
    cold: cold && plain(cold),
    sameDevice: !!models && !!cold && models.device === cold.device,
  };
}
