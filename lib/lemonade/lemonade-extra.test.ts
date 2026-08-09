import {test, expect} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {
  planExtraModels,
  previewExtraModels,
  syncExtraModels,
} from '@/lib/lemonade/lemonade-extra';
import type {Model} from '@/lib/models/model-types';

const single = (name: string, filename: string, quant = 'Q4_K_M') => ({
  isSplit: false as const,
  filename,
  path: `${name}/${filename}`,
  quant,
  size: 1,
  missing: false,
});

const model = (name: string, files: Model['files']): Model =>
  ({name, files}) as Model;

async function dirs() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-extra-'));
  return {root, tj: path.join(root, 'tj'), extra: path.join(root, 'extra')};
}

const listing = async (dir: string) =>
  (await fsp.readdir(dir).catch(() => [] as string[])).sort();

test('a model becomes one directory of symlinks named for its repo', async () => {
  const {root, tj, extra} = await dirs();
  const m = model('unsloth/DeepSeek-GGUF', [
    single('unsloth/DeepSeek-GGUF', 'DeepSeek-UD-IQ3_S.gguf'),
  ]);
  const plans = planExtraModels(tj, [m]);
  expect(plans).toEqual([
    {
      repoId: 'unsloth/DeepSeek-GGUF',
      folder: 'DeepSeek-GGUF',
      links: [
        {
          name: 'DeepSeek-UD-IQ3_S.gguf',
          target: path.join(tj, 'unsloth/DeepSeek-GGUF/DeepSeek-UD-IQ3_S.gguf'),
        },
      ],
    },
  ]);

  await fsp.mkdir(path.dirname(plans[0].links[0].target), {recursive: true});
  await fsp.writeFile(plans[0].links[0].target, 'W');
  await syncExtraModels(extra, plans);

  const link = path.join(extra, 'DeepSeek-GGUF/DeepSeek-UD-IQ3_S.gguf');
  expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
  expect(await fsp.readFile(link, 'utf8')).toBe('W');
  await fsp.rm(root, {recursive: true, force: true});
});

test('a model with no GGUF is not offered at all', async () => {
  const {tj} = await dirs();
  // Lemonade's extra directory only ever loads GGUF — the recipe is fixed to
  // llamacpp — so linking a safetensors model there would be a dead entry.
  const m = model('Qwen/Qwen3.6-27B', [
    single('Qwen/Qwen3.6-27B', 'model-00001-of-00015.safetensors', 'BF16'),
  ]);
  expect(planExtraModels(tj, [m])).toEqual([]);
});

test('shards of one quantization keep their own names in one directory', async () => {
  // Lemonade merges a shard series into a single model named for the
  // directory, which is why the directory is named for the repo.
  const {tj} = await dirs();
  const m = model('org/Split-GGUF', [
    {
      isSplit: true,
      representativeFilename: 'm-Q4-00001-of-00002.gguf',
      files: [
        {path: 'org/Split-GGUF/Q4/m-Q4-00001-of-00002.gguf', size: 1},
        {path: 'org/Split-GGUF/Q4/m-Q4-00002-of-00002.gguf', size: 1},
      ],
      quant: 'Q4',
      totalShards: 2,
      presentShards: 2,
      missingIndices: [],
      totalSize: 2,
    },
  ] as unknown as Model['files']);
  const [plan] = planExtraModels(tj, [m]);
  expect(plan.folder).toBe('Split-GGUF');
  expect(plan.links.map((l) => l.name)).toEqual([
    'm-Q4-00001-of-00002.gguf',
    'm-Q4-00002-of-00002.gguf',
  ]);
});

test('two repos with the same name are told apart by their org', async () => {
  const {tj} = await dirs();
  const plans = planExtraModels(tj, [
    model('bbb/Same-GGUF', [single('bbb/Same-GGUF', 'b.gguf')]),
    model('aaa/Same-GGUF', [single('aaa/Same-GGUF', 'a.gguf')]),
  ]);
  // Sorted by repo id, so which one keeps the short name is stable.
  expect(plans.map((p) => [p.repoId, p.folder])).toEqual([
    ['aaa/Same-GGUF', 'Same-GGUF'],
    ['bbb/Same-GGUF', 'bbb--Same-GGUF'],
  ]);
});

test('a filename repeated across quantization folders is qualified', async () => {
  const {tj} = await dirs();
  const m = model('org/Repeat-GGUF', [
    {
      ...single('org/Repeat-GGUF', 'model.gguf'),
      path: 'org/Repeat-GGUF/Q4/model.gguf',
    },
    {
      ...single('org/Repeat-GGUF', 'model.gguf'),
      path: 'org/Repeat-GGUF/Q8/model.gguf',
    },
  ]);
  const [plan] = planExtraModels(tj, [m]);
  expect(plan.links.map((l) => l.name)).toEqual([
    'model.gguf',
    'Q8-model.gguf',
  ]);
});

test('re-running changes nothing, and a vanished model is cleared away', async () => {
  const {root, tj, extra} = await dirs();
  const m = model('org/Gone-GGUF', [single('org/Gone-GGUF', 'g.gguf')]);
  const plans = planExtraModels(tj, [m]);
  await fsp.mkdir(path.join(tj, 'org/Gone-GGUF'), {recursive: true});
  await fsp.writeFile(plans[0].links[0].target, 'W');

  expect((await syncExtraModels(extra, plans)).length).toBe(1);
  expect(await syncExtraModels(extra, plans)).toEqual([]); // idempotent
  expect(await previewExtraModels(extra, plans)).toEqual([]);

  // The model stops qualifying: its directory of links goes with it.
  expect(await previewExtraModels(extra, [])).toEqual([
    {repoId: 'Gone-GGUF', folder: 'Gone-GGUF', toLink: 0, toRemove: 1},
  ]);
  await syncExtraModels(extra, []);
  expect(await listing(extra)).toEqual([]);
  await fsp.rm(root, {recursive: true, force: true});
});

test("a directory holding somebody's own file is never touched", async () => {
  // Lemonade calls this directory user-managed. A real file in it is theirs.
  const {root, extra} = await dirs();
  await fsp.mkdir(path.join(extra, 'MyOwnModel'), {recursive: true});
  await fsp.writeFile(path.join(extra, 'MyOwnModel/mine.gguf'), 'MINE');

  expect(await previewExtraModels(extra, [])).toEqual([]);
  await syncExtraModels(extra, []);
  expect(await listing(path.join(extra, 'MyOwnModel'))).toEqual(['mine.gguf']);
  await fsp.rm(root, {recursive: true, force: true});
});
