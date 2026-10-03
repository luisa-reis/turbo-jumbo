import {afterEach, beforeEach, expect, test} from 'bun:test';
import {mkdtemp, rm} from 'fs/promises';
import {tmpdir} from 'os';
import path from 'path';
import type {FlmSource} from '@/lib/lemonade/flm';
import {completeFileSet} from '@/lib/models/complete-file-set';
import {writeModelSidecar, type TjModel} from '@/lib/models/model-sidecar';
import {dirSite} from '@/lib/storage/site';

const repoId = 'FastFlowLM/Embed-NPU2';
let base: string;
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'tj-cfs-'));
});
afterEach(async () => {
  await rm(base, {recursive: true, force: true});
});

const registryOf =
  (...sources: FlmSource[]) =>
  async () =>
    new Map(sources.map((s, i) => [`tag:${i}`, s]));
const noRegistry = registryOf();

const sidecar = (o: Partial<TjModel>) =>
  writeModelSidecar(dirSite(base), repoId, {
    modelUrl: `https://huggingface.co/${repoId}`,
    repoId,
    files: [],
    ...o,
  });

// What the registry listed before v0.9.28, kernels and all — the scope a
// catalog download recorded back then.
const oldScope = ['config.json', 'model.q4nx', 'mm.xclbin'];
const liveList = {
  repoId,
  revision: 'main',
  files: ['config.json', 'model.q4nx'],
};

test('the live registry wins over the scope recorded at download', async () => {
  await sidecar({fileScope: oldScope});
  const set = await completeFileSet(
    dirSite(base),
    repoId,
    registryOf(liveList),
  );
  expect([...(set ?? [])].sort()).toEqual(['config.json', 'model.q4nx']);
});

test('the live registry defines a copy that recorded no scope at all', async () => {
  // A plain HF download, or a copy made before scopes travelled with it.
  await sidecar({});
  const set = await completeFileSet(
    dirSite(base),
    repoId,
    registryOf(liveList),
  );
  expect([...(set ?? [])].sort()).toEqual(['config.json', 'model.q4nx']);
});

test('the recorded scope holds while the registry is out of reach', async () => {
  await sidecar({fileScope: oldScope});
  const set = await completeFileSet(dirSite(base), repoId, noRegistry);
  expect([...(set ?? [])].sort()).toEqual(oldScope.sort());
});

test('a copy pinned to a revision the registry no longer names keeps its own scope', async () => {
  await sidecar({revision: 'v1', fileScope: oldScope});
  const set = await completeFileSet(
    dirSite(base),
    repoId,
    registryOf(liveList),
  );
  expect([...(set ?? [])].sort()).toEqual(oldScope.sort());
});

test('a model the registry does not know, with no recorded scope, is the whole repo', async () => {
  await sidecar({});
  expect(await completeFileSet(dirSite(base), repoId, noRegistry)).toBeNull();
});
