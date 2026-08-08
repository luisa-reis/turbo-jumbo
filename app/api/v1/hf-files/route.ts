import {repoDownloadFiles} from '@/lib/hf/hf-download';

const REPO_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9_./-]+$/;
// Nested folders are addressable (`split_files/vae`), so `/` is allowed.
const FOLDER_RE = /^[A-Za-z0-9_. /-]+$/;

// `folder` is interpolated into the HF tree URL, so a `..` segment — which the
// pattern above otherwise permits — must be rejected: it would climb out of the
// requested repo and list a different one.
function hasUnsafeSegment(p: string): boolean {
  return p.split('/').some((seg) => seg === '..');
}

type HfEntry = {type: string; path: string; size: number};

export async function GET(req: Request) {
  const {searchParams} = new URL(req.url);
  const repoId = searchParams.get('repoId') ?? '';
  const branch = searchParams.get('branch') ?? 'main';
  const folder = searchParams.get('folder') ?? '';

  if (!REPO_ID_RE.test(repoId))
    return new Response('Invalid repoId', {status: 400});
  if (!BRANCH_RE.test(branch))
    return new Response('Invalid branch', {status: 400});
  if (folder && (!FOLDER_RE.test(folder) || hasUnsafeSegment(folder)))
    return new Response('Invalid folder', {status: 400});

  // Always recurse. Repos that keep each quantization in its own directory
  // (unsloth/DeepSeek-V4-Flash-0731-GGUF and kin) show almost nothing at the
  // root, and a checkpoint naming a nested file (a Flux VAE at
  // split_files/vae/flux2-vae.safetensors) can't be resolved from a root-only
  // listing either. For a repo with no subdirectories this returns exactly what
  // the root listing did.
  const treePath = folder ? `${branch}/${folder}` : branch;
  const hfRes = await fetch(
    `https://huggingface.co/api/models/${repoId}/tree/${treePath}?recursive=true`,
    {headers: {'User-Agent': 'turbo-jumbo/1.0'}},
  );

  if (!hfRes.ok)
    return new Response(await hfRes.text(), {status: hfRes.status});

  const entries: HfEntry[] = await hfRes.json();

  const fileEntries = entries.filter((e) => e.type === 'file');
  // List what a download needs: GGUF/bin weights for a self-contained repo, or
  // weights plus companion files for a safetensors model. A folder listing is
  // curated the same way, judged on its own contents — the paths HF returns are
  // repo-relative either way — so pointing at a quant folder offers its shards
  // without the README sitting beside them.
  const sizeOf = new Map(fileEntries.map((e) => [e.path, e.size]));
  const paths = repoDownloadFiles(fileEntries.map((e) => e.path));
  const files = paths.map((p) => ({path: p, size: sizeOf.get(p) ?? 0}));

  return Response.json(files);
}
