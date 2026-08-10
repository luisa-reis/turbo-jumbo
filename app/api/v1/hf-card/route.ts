import {NextResponse} from 'next/server';
import {fetchRepoCard} from '@/lib/hf/repo-card';

// A repo's model card, for the download picker to show beside its file list.
// Its own route rather than part of hf-files: the card is prose fetched from a
// different endpoint, it is often absent, and a picker should list files
// whether or not the card resolves.

const REPO_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9_./-]+$/;

// `branch` is interpolated into the raw-file URL, so a `..` segment — which
// the pattern above otherwise permits — must be rejected before it can climb
// out of the requested repo.
function hasUnsafeSegment(p: string): boolean {
  return p.split('/').some((seg) => seg === '..');
}

export async function GET(req: Request) {
  const {searchParams} = new URL(req.url);
  const repoId = searchParams.get('repoId') ?? '';
  const branch = searchParams.get('branch') ?? 'main';

  if (!REPO_ID_RE.test(repoId))
    return new Response('Invalid repoId', {status: 400});
  if (!BRANCH_RE.test(branch) || hasUnsafeSegment(branch))
    return new Response('Invalid branch', {status: 400});

  // No card is an ordinary answer, not a failure: plenty of repos ship weights
  // and nothing else, and the picker just shows no card.
  return NextResponse.json(await fetchRepoCard(repoId, branch));
}
