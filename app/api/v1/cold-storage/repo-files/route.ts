import {coldStorageSite} from '@/lib/storage/storage-instance';
import {repoFilesResponse} from '@/lib/models/repo-files-response';

// Per-file present/missing/invalid status for one repo's cold copy, for the
// models table's expanded file list on the Cold Storage tab.
export async function GET(req: Request) {
  return repoFilesResponse(req, coldStorageSite, 'cold storage');
}
