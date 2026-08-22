import {test, expect} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {
  planFlmStore,
  previewFlmStore,
  syncFlmStore,
} from '@/lib/lemonade/lemonade-flm-store';
import type {FlmSource} from '@/lib/lemonade/flm';
import {createLocalStorage} from '@/lib/storage/local-storage';
import type {Storage} from '@/lib/storage/storage';
import type {Model} from '@/lib/models/model-types';

const REPO = 'FastFlowLM/Embedding-Gemma-300M-NPU2';
const FOLDER = 'Embedding-Gemma-300M-NPU2';
const FILES = ['config.json', 'tokenizer.json', 'model.q4nx'];

const registry = (): Map<string, FlmSource> =>
  new Map([
    ['embed-gemma:300m', {repoId: REPO, revision: 'main', files: FILES}],
  ]);

const single = (name: string, filename: string) => ({
  isSplit: false as const,
  filename,
  path: `${name}/${filename}`,
  quant: 'Q4NX',
  size: 1,
  missing: false,
});

const model = (name: string, files: Model['files']): Model =>
  ({name, files}) as Model;

async function dirs(): Promise<{
  tj: string;
  store: string;
  storage: Storage;
}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-flm-store-'));
  const tj = path.join(root, 'tj');
  const lemonade = path.join(root, 'lemonade');
  await fsp.mkdir(tj, {recursive: true});
  await fsp.mkdir(lemonade, {recursive: true});
  return {
    tj,
    store: path.join(lemonade, 'flm', 'models'),
    storage: createLocalStorage({models: tj, lemonade}),
  };
}

/** The model's directory on fast storage, holding the given files. */
async function held(tj: string, files: string[]): Promise<Model> {
  const dir = path.join(tj, REPO);
  await fsp.mkdir(dir, {recursive: true});
  for (const f of files) await fsp.writeFile(path.join(dir, f), 'w');
  return model(REPO, [single(REPO, 'model.q4nx')]);
}

const readlink = async (p: string) => fsp.readlink(p).catch(() => null);

test('a held model the registry names plans a link under its repo name', async () => {
  const {tj, storage} = await dirs();
  const m = await held(tj, FILES);
  expect(await planFlmStore(storage, [m], registry())).toEqual([
    {
      repoId: REPO,
      folder: FOLDER,
      dir: REPO,
      tags: ['embed-gemma:300m'],
      missing: [],
      bytes: 1,
    },
  ]);
});

test('a model no tag resolves to is not offered', async () => {
  const {tj, storage} = await dirs();
  const other = model('unsloth/Qwen3-GGUF', [
    single('unsloth/Qwen3-GGUF', 'q.gguf'),
  ]);
  await fsp.mkdir(path.join(tj, 'unsloth/Qwen3-GGUF'), {recursive: true});
  expect(await planFlmStore(storage, [other], registry())).toEqual([]);
});

test('a model missing a registry file is planned as incomplete', async () => {
  const {tj, storage} = await dirs();
  const m = await held(tj, ['config.json', 'model.q4nx']); // no tokenizer.json
  const [plan] = await planFlmStore(storage, [m], registry());
  expect(plan.missing).toEqual(['tokenizer.json']);
});

test('sync links the model directory into the store, and preview agrees', async () => {
  const {tj, store, storage} = await dirs();
  const plans = await planFlmStore(
    storage,
    [await held(tj, FILES)],
    registry(),
  );
  expect(await previewFlmStore(storage, plans)).toEqual([
    {repoId: REPO, folder: FOLDER, status: 'link'},
  ]);
  expect(await syncFlmStore(storage, plans)).toEqual([
    {repoId: REPO, folder: FOLDER, status: 'link'},
  ]);
  expect(await readlink(path.join(store, FOLDER))).toBe(path.join(tj, REPO));
  // Nothing left to do once it is in place.
  expect(await previewFlmStore(storage, plans)).toEqual([]);
  expect(await syncFlmStore(storage, plans)).toEqual([]);
});

test("a real directory in the store — one of flm's own pulls — is left alone", async () => {
  const {tj, store, storage} = await dirs();
  await fsp.mkdir(path.join(store, FOLDER), {recursive: true});
  await fsp.writeFile(path.join(store, FOLDER, 'model.q4nx'), 'theirs');
  const plans = await planFlmStore(
    storage,
    [await held(tj, FILES)],
    registry(),
  );
  expect(await previewFlmStore(storage, plans)).toEqual([]);
  expect(await syncFlmStore(storage, plans)).toEqual([]);
  expect(
    await fsp.readFile(path.join(store, FOLDER, 'model.q4nx'), 'utf8'),
  ).toBe('theirs');
});

test('a link of ours that no plan wants is removed; real directories are not', async () => {
  const {tj, store, storage} = await dirs();
  await fsp.mkdir(store, {recursive: true});
  await fsp.symlink(path.join(tj, 'gone'), path.join(store, 'Gone-NPU2'));
  await fsp.mkdir(path.join(store, 'Theirs-NPU2'));
  expect(await previewFlmStore(storage, [])).toEqual([
    {repoId: 'Gone-NPU2', folder: 'Gone-NPU2', status: 'remove'},
  ]);
  expect(await syncFlmStore(storage, [])).toEqual([
    {repoId: 'Gone-NPU2', folder: 'Gone-NPU2', status: 'remove'},
  ]);
  expect(await readlink(path.join(store, 'Gone-NPU2'))).toBeNull();
  expect((await fsp.stat(path.join(store, 'Theirs-NPU2'))).isDirectory()).toBe(
    true,
  );
});

test('an incomplete model is reported, not linked, and loses any stale link', async () => {
  const {tj, store, storage} = await dirs();
  const m = await held(tj, ['model.q4nx']);
  await fsp.mkdir(store, {recursive: true});
  await fsp.symlink(path.join(tj, REPO), path.join(store, FOLDER)); // from a fuller past
  const plans = await planFlmStore(storage, [m], registry());
  const expected = [
    {
      repoId: REPO,
      folder: FOLDER,
      status: 'incomplete',
      missing: ['config.json', 'tokenizer.json'],
    },
    {repoId: REPO, folder: FOLDER, status: 'remove'},
  ];
  expect(await previewFlmStore(storage, plans)).toEqual(expected);
  expect(await syncFlmStore(storage, plans)).toEqual(expected);
  expect(await readlink(path.join(store, FOLDER))).toBeNull();
});

test('a link pointing somewhere else is corrected', async () => {
  const {tj, store, storage} = await dirs();
  await fsp.mkdir(store, {recursive: true});
  await fsp.symlink(path.join(tj, 'elsewhere'), path.join(store, FOLDER));
  const plans = await planFlmStore(
    storage,
    [await held(tj, FILES)],
    registry(),
  );
  expect(await syncFlmStore(storage, plans)).toEqual([
    {repoId: REPO, folder: FOLDER, status: 'link'},
  ]);
  expect(await readlink(path.join(store, FOLDER))).toBe(path.join(tj, REPO));
});
