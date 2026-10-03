import {coldStorageSite} from '@/lib/storage/storage-instance';
import {findReposWithInvalidFiles} from '@/lib/audit/incomplete-models';

// Repo ids in cold storage with at least one file that audits invalid — the
// Cold Storage tab's invalid flag, as the peers' invalid routes are theirs.
export async function GET() {
  if (!coldStorageSite) return Response.json({invalid: []});
  return Response.json({
    invalid: await findReposWithInvalidFiles(coldStorageSite),
  });
}
