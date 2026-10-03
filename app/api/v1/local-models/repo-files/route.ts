import {localModelsSite} from '@/lib/storage/storage-instance';
import {repoFilesResponse} from '@/lib/models/repo-files-response';

// Per-file present/missing/invalid status for one repo's local copy, for the
// models table's expanded file list.
export async function GET(req: Request) {
  return repoFilesResponse(req, localModelsSite, 'local storage');
}
