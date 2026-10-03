import {repoFileStatuses} from '@/lib/models/repo-files';
import type {Site} from '@/lib/storage/site';

const REPO_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * The `repo-files` answer for one of this machine's own stores — local or cold
 * — for the models table's expanded file list: `{files}` for `?repoId=`, or a
 * plain-text error. `site` is undefined where the machine has no such store.
 */
export async function repoFilesResponse(
  req: Request,
  site: Site | undefined,
  storeName: string,
): Promise<Response> {
  const repoId = new URL(req.url).searchParams.get('repoId') ?? '';
  if (!REPO_ID_RE.test(repoId))
    return new Response('Invalid repoId', {status: 400});
  if (!site) return new Response(`No ${storeName}`, {status: 400});
  try {
    return Response.json({files: await repoFileStatuses(site, repoId)});
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(msg, {status: 502});
  }
}
