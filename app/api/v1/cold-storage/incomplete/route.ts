import {coldStorageSite} from '@/lib/storage/storage-instance';
import {findIncompleteRepos} from '@/lib/audit/incomplete-models';

// Repo ids in cold storage whose copy is missing files the model needs — the
// Cold Storage tab's incomplete flag, as the peers' incomplete routes are
// theirs.
export async function GET() {
  if (!coldStorageSite) return Response.json({incomplete: []});
  return Response.json({
    incomplete: await findIncompleteRepos(coldStorageSite),
  });
}
