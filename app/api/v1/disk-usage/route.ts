import {hasColdStorage, hasModelStorage} from '@/lib/config';
import {logger} from '@/lib/util/logger';
import {downloadDiskUsage} from '@/lib/storage/disk-usage';
import {storage} from '@/lib/storage/storage-instance';

// Free/total bytes of the filesystems a download touches — the local models
// directory (where it lands) and cold storage (the optional copy target) — so
// the UI can warn before a transfer that wouldn't fit. A host with only one
// of the two reports that one; a viewer with neither has nothing to report.
export async function GET() {
  if (!hasModelStorage && !hasColdStorage) {
    return new Response('No local storage configured', {status: 400});
  }
  try {
    return Response.json(
      await downloadDiskUsage(storage, {
        models: hasModelStorage,
        cold: hasColdStorage,
      }),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[disk-usage] statfs failed: ${msg}`);
    return new Response(msg, {status: 500});
  }
}
