import {localModelsSite} from '@/lib/storage/storage-instance';
import {NextResponse} from 'next/server';
import {repoFileStatuses} from '@/lib/models/repo-files';

const REPO_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Per-file present/missing/invalid status for one repo's local copy, for the
// models table's expanded file list.
export async function GET(req: Request) {
  const repoId = new URL(req.url).searchParams.get('repoId') ?? '';
  if (!REPO_ID_RE.test(repoId))
    return new Response('Invalid repoId', {status: 400});
  if (!localModelsSite) return new Response('No local storage', {status: 400});
  try {
    const files = await repoFileStatuses(localModelsSite, repoId);
    return NextResponse.json({files});
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(msg, {status: 502});
  }
}
