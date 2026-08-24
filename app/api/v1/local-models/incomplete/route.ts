import {localModelsSite} from '@/lib/storage/storage-instance';
import {NextResponse} from 'next/server';
import {lemonadeDir} from '@/lib/config';
import {findIncompleteRepos} from '@/lib/audit/incomplete-models';

// Repo ids present in this host's storage but missing files a full download
// would include (used by the Lemonade browser and the models table to flag a
// partial download, e.g. Kokoro with only its voices sidecar).
export async function GET() {
  if (!localModelsSite) return NextResponse.json({incomplete: []});
  const incomplete = await findIncompleteRepos(localModelsSite, lemonadeDir);
  return NextResponse.json({incomplete});
}
