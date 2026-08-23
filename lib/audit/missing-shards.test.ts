import {test, expect, afterEach} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {detectMissingShards} from '@/lib/audit/missing-shards';
import {scanModels} from '@/lib/models/models';
import {MODEL_SIDECAR_NAME, type TjModel} from '@/lib/models/model-sidecar';
import {clearHfCache} from '@/lib/hf/hf-infer';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  // The repo tree cache lives for one audit run (the route clears it per run),
  // so each test starts from a cold one too.
  clearHfCache();
});

const REPO = 'unsloth/Split-Test-GGUF';
const QUANT = 'UD-IQ3_S';
const shard = (i: number) => `Split-Test-${QUANT}-0000${i}-of-00004.gguf`;
const repoPath = (i: number) => `${QUANT}/${shard(i)}`;

// The repo's four shards as an LFS tree, so listRepoFiles (which drops
// checksum-less entries) returns them.
const treeFiles = [1, 2, 3, 4].map((i) => ({
  type: 'file',
  path: repoPath(i),
  size: i * 1000,
  lfs: {oid: `sha256:shard${i}`, size: i * 1000},
}));

function mockTree(revision: string, files: unknown[] = treeFiles) {
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes(`/api/models/${REPO}/tree/${revision}`)) {
      return new Response(JSON.stringify(files), {status: 200});
    }
    return new Response('nf', {status: 404});
  }) as typeof fetch;
}

// A storage root holding the given shards of the split quant.
async function storageWith(indices: number[]): Promise<string> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-shards-'));
  await fsp.mkdir(path.join(base, REPO, QUANT), {recursive: true});
  for (const i of indices) {
    await fsp.writeFile(path.join(base, REPO, repoPath(i)), Buffer.alloc(10));
  }
  return base;
}

const localPath = (i: number) => `${REPO}/${repoPath(i)}`;

test('flags every shard a split is missing, with its Hugging Face source', async () => {
  const base = await storageWith([1]);
  mockTree('main');

  const out = await detectMissingShards(
    await scanModels(base),
    new Set([localPath(1)]),
    base,
    'main',
  );

  expect(out.map((r) => r.file)).toEqual([
    localPath(2),
    localPath(3),
    localPath(4),
  ]);
  expect(out[0].status).toBe('incomplete');
  expect(out[0].hf?.expectedSize).toBe(2000);
  expect(out[0].hf?.repoId).toBe(REPO);
  await fsp.rm(base, {recursive: true, force: true});
});

test('flags nothing for a split whose shards are all present', async () => {
  const base = await storageWith([1, 2, 3, 4]);
  mockTree('main');

  expect(
    await detectMissingShards(
      await scanModels(base),
      new Set([1, 2, 3, 4].map(localPath)),
      base,
      'main',
    ),
  ).toEqual([]);
  await fsp.rm(base, {recursive: true, force: true});
});

test('flags nothing for a split none of whose shards were audited', async () => {
  const base = await storageWith([1]);
  mockTree('main');

  expect(
    await detectMissingShards(await scanModels(base), new Set(), base, 'main'),
  ).toEqual([]);
  await fsp.rm(base, {recursive: true, force: true});
});

test('flags nothing when the repo listing cannot be fetched', async () => {
  const base = await storageWith([1]);
  globalThis.fetch = (async () =>
    new Response('nope', {status: 500})) as typeof fetch;

  expect(
    await detectMissingShards(
      await scanModels(base),
      new Set([localPath(1)]),
      base,
      'main',
    ),
  ).toEqual([]);
  await fsp.rm(base, {recursive: true, force: true});
});

test('flags nothing when the repo no longer lists the shard set', async () => {
  const base = await storageWith([1]);
  // The repo holds a different quantization only — the local set isn't there
  // to re-fetch, so guessing its paths would be wrong.
  mockTree('main', [
    {
      type: 'file',
      path: 'UD-IQ4_XS/Split-Test-UD-IQ4_XS-00001-of-00002.gguf',
      size: 5,
      lfs: {oid: 'sha256:other', size: 5},
    },
  ]);

  expect(
    await detectMissingShards(
      await scanModels(base),
      new Set([localPath(1)]),
      base,
      'main',
    ),
  ).toEqual([]);
  await fsp.rm(base, {recursive: true, force: true});
});

test('resolves the shards at the revision the model is pinned to', async () => {
  const base = await storageWith([1]);
  const sidecar: TjModel = {
    modelUrl: `https://huggingface.co/${REPO}`,
    repoId: REPO,
    revision: 'v2.0',
    files: [],
  };
  await fsp.writeFile(
    path.join(base, REPO, MODEL_SIDECAR_NAME),
    JSON.stringify(sidecar),
  );
  // Only the pinned revision answers: resolving against main would find nothing.
  mockTree('v2.0');

  const out = await detectMissingShards(
    await scanModels(base),
    new Set([localPath(1)]),
    base,
    'main',
  );

  expect(out.map((r) => r.file)).toEqual([
    localPath(2),
    localPath(3),
    localPath(4),
  ]);
  expect(out[0].hf?.fileUrl).toContain('/blob/v2.0/');
  await fsp.rm(base, {recursive: true, force: true});
});
