import {test, expect, afterEach} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import nodePath from 'path';
import {createLocalStorage} from '@/lib/storage/local-storage';
import {MAX_SMALL_FILE, type Storage} from '@/lib/storage/storage';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) {
    await fsp.rm(dir, {recursive: true, force: true});
  }
});

/** A storage with all three roots on real temp directories. */
async function tmpStorage(): Promise<{
  storage: Storage;
  models: string;
  cold: string;
}> {
  const base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'tj-storage-'));
  made.push(base);
  const models = nodePath.join(base, 'models');
  const cold = nodePath.join(base, 'cold');
  const lemonade = nodePath.join(base, 'lemonade');
  for (const dir of [models, cold, lemonade]) {
    await fsp.mkdir(dir, {recursive: true});
  }
  return {storage: createLocalStorage({models, cold, lemonade}), models, cold};
}

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

test('a path cannot climb out of its root', async () => {
  // The whole confinement story: there is no way to *name* a path outside a
  // root, so no caller has to be trusted to check.
  const {storage} = await tmpStorage();
  for (const path of ['../escape', 'a/../../escape', '/etc/passwd']) {
    await expect(storage.read({root: 'models', path})).rejects.toThrow();
  }
});

test('a root nobody configured is an error, not a crash elsewhere', async () => {
  const storage = createLocalStorage({models: '/tmp'});
  await expect(storage.usage('cold')).rejects.toThrow(/No cold directory/);
});

test('write then read round-trips, creating parent directories', async () => {
  const {storage} = await tmpStorage();
  const ref = {root: 'models', path: 'org/repo/tjmodel.json'} as const;
  await storage.write(ref, bytes('{"repoId":"org/repo"}'));
  expect(text(await storage.read(ref))).toBe('{"repoId":"org/repo"}');
});

test('small-file verbs refuse a large file at both ends', async () => {
  // Weights move by job. Without the cap this interface quietly becomes a way
  // to pull 116 GiB through JSON.
  const {storage, models} = await tmpStorage();
  await expect(
    storage.write(
      {root: 'models', path: 'big'},
      new Uint8Array(MAX_SMALL_FILE + 1),
    ),
  ).rejects.toThrow(/small files only/);

  await fsp.writeFile(
    nodePath.join(models, 'big.gguf'),
    Buffer.alloc(MAX_SMALL_FILE + 1),
  );
  await expect(
    storage.read({root: 'models', path: 'big.gguf'}),
  ).rejects.toThrow(/small files only/);
});

test('list walks recursively and reports kind', async () => {
  const {storage, models} = await tmpStorage();
  await fsp.mkdir(nodePath.join(models, 'org/repo'), {recursive: true});
  await fsp.writeFile(nodePath.join(models, 'org/repo/a.gguf'), 'x');

  const entries = await storage.list('models');
  const byPath = new Map(entries.map((e) => [e.path, e]));
  expect([...byPath.keys()].sort()).toEqual([
    'org',
    'org/repo',
    'org/repo/a.gguf',
  ]);
  expect(byPath.get('org')?.kind).toBe('dir');
  expect(byPath.get('org/repo/a.gguf')).toMatchObject({kind: 'file', size: 1});
});

test('list reports a symlink without following it', async () => {
  // Lemonade's extra directory is symlinks pointing back into the models
  // root; following them would report every weight twice.
  const {storage, models} = await tmpStorage();
  await fsp.writeFile(nodePath.join(models, 'real.gguf'), 'x');
  await fsp.mkdir(nodePath.join(models, 'extra'));
  await fsp.symlink(
    nodePath.join(models, 'real.gguf'),
    nodePath.join(models, 'extra/link.gguf'),
  );

  const entry = (await storage.list('models')).find(
    (e) => e.path === 'extra/link.gguf',
  );
  expect(entry?.kind).toBe('symlink');
  expect(entry?.linkTarget).toContain('real.gguf');
});

test('list reads safetensors dtype only when asked', async () => {
  // One header read per file is cheap during a walk it is already doing, and
  // expensive as a second call per file afterwards.
  const {storage, models} = await tmpStorage();
  const header = Buffer.from(JSON.stringify({w: {dtype: 'BF16'}}), 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(header.length));
  await fsp.writeFile(
    nodePath.join(models, 'model.safetensors'),
    Buffer.concat([len, header]),
  );

  const off = await storage.list('models');
  expect(off[0].dtype).toBeUndefined();
  const on = await storage.list('models', {dtype: true});
  expect(on[0].dtype).toBe('BF16');
});

test('list can be limited to a subdirectory, with paths still root-relative', async () => {
  const {storage, models} = await tmpStorage();
  await fsp.mkdir(nodePath.join(models, 'org/repo'), {recursive: true});
  await fsp.writeFile(nodePath.join(models, 'org/repo/a.gguf'), 'x');
  await fsp.writeFile(nodePath.join(models, 'elsewhere.gguf'), 'x');

  const entries = await storage.list('models', {under: 'org/repo'});
  expect(entries.map((e) => e.path)).toEqual(['org/repo/a.gguf']);
});

test('remove is bulk, and prunes the skeleton it leaves behind', async () => {
  const {storage, models} = await tmpStorage();
  await fsp.mkdir(nodePath.join(models, 'org/repo/Q4'), {recursive: true});
  await fsp.writeFile(nodePath.join(models, 'org/repo/Q4/a.gguf'), 'x');
  await fsp.writeFile(nodePath.join(models, 'org/repo/Q4/b.gguf'), 'x');

  await storage.remove(
    [
      {root: 'models', path: 'org/repo/Q4/a.gguf'},
      {root: 'models', path: 'org/repo/Q4/b.gguf'},
    ],
    {pruneEmptyDirs: true},
  );
  // Every directory the model occupied is gone, and the root itself is not.
  expect(await storage.list('models')).toEqual([]);
  await expect(fsp.stat(models)).resolves.toBeDefined();
});

test('pruning stops at a directory that still holds something', async () => {
  const {storage, models} = await tmpStorage();
  await fsp.mkdir(nodePath.join(models, 'org/repo'), {recursive: true});
  await fsp.writeFile(nodePath.join(models, 'org/repo/a.gguf'), 'x');
  await fsp.writeFile(nodePath.join(models, 'org/keep.txt'), 'x');

  await storage.remove([{root: 'models', path: 'org/repo/a.gguf'}], {
    pruneEmptyDirs: true,
  });
  expect((await storage.list('models')).map((e) => e.path).sort()).toEqual([
    'org',
    'org/keep.txt',
  ]);
});

test('move and copy create the destination directory', async () => {
  const {storage} = await tmpStorage();
  await storage.write({root: 'models', path: 'a.gguf'}, bytes('weights'));

  await storage.copy(
    {root: 'models', path: 'a.gguf'},
    {root: 'cold', path: 'org/repo/a.gguf'},
  );
  expect(
    text(await storage.read({root: 'cold', path: 'org/repo/a.gguf'})),
  ).toBe('weights');

  await storage.move(
    {root: 'models', path: 'a.gguf'},
    {root: 'models', path: 'org/repo/a.gguf'},
  );
  expect(
    text(await storage.read({root: 'models', path: 'org/repo/a.gguf'})),
  ).toBe('weights');
  await expect(
    storage.read({root: 'models', path: 'a.gguf'}),
  ).rejects.toThrow();
});

test('link replaces a link pointing at the wrong thing', async () => {
  // Correcting those is exactly what a Lemonade sync run is for.
  const {storage} = await tmpStorage();
  await storage.write({root: 'models', path: 'right.gguf'}, bytes('r'));
  await storage.write({root: 'models', path: 'wrong.gguf'}, bytes('w'));
  const at = {root: 'lemonade', path: 'extra/m/x.gguf'} as const;

  await storage.link([{target: {root: 'models', path: 'wrong.gguf'}, at}]);
  await storage.link([{target: {root: 'models', path: 'right.gguf'}, at}]);
  expect(text(await storage.read(at))).toBe('r');
});

test('usage reports the filesystem holding a root', async () => {
  const {storage} = await tmpStorage();
  const {free, total} = await storage.usage('models');
  expect(total).toBeGreaterThan(0);
  expect(free).toBeGreaterThan(0);
  expect(free).toBeLessThanOrEqual(total);
});
