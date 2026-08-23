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

test('a strict list refuses to pass off a truncated inventory as complete', async () => {
  // Deciding to delete a "weightless" directory requires having actually seen
  // all of it. A tolerant list swallows an unreadable subdirectory, which
  // would make it look empty; strict makes that a refusal instead.
  const {storage, models} = await tmpStorage();
  const locked = nodePath.join(models, 'org/repo/locked');
  await fsp.mkdir(locked, {recursive: true});
  await fsp.chmod(locked, 0o000);
  try {
    await expect(storage.list('models', {strict: true})).rejects.toThrow();
    // The tolerant walk still returns what it could see.
    const tolerant = await storage.list('models');
    expect(tolerant.some((e) => e.path === 'org/repo/locked')).toBe(true);
  } finally {
    await fsp.chmod(locked, 0o755);
  }
});

test('a strict list of a missing subdirectory is empty, not an error', async () => {
  // Gone is an answer — a vanished directory holds nothing. Only "couldn't
  // look" is worth failing over.
  const {storage} = await tmpStorage();
  expect(
    await storage.list('models', {under: 'no/such', strict: true}),
  ).toEqual([]);
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

test('pruning treats hf CLI .cache bookkeeping as emptiness', async () => {
  // The hf CLI leaves .cache/huggingface/... beside what it downloads. A dir
  // holding only that is a husk — deleting a model's last file must not leave
  // it behind for the audit and Lemonade sync to keep tripping over.
  const {storage, models} = await tmpStorage();
  await fsp.mkdir(nodePath.join(models, 'org/repo/.cache/huggingface'), {
    recursive: true,
  });
  await fsp.writeFile(
    nodePath.join(models, 'org/repo/.cache/huggingface/a.gguf.metadata'),
    'x',
  );
  await fsp.writeFile(nodePath.join(models, 'org/repo/a.gguf'), 'x');

  await storage.remove([{root: 'models', path: 'org/repo/a.gguf'}], {
    pruneEmptyDirs: true,
  });
  expect(await storage.list('models')).toEqual([]);
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

  expect(
    await storage.link([{target: {root: 'models', path: 'wrong.gguf'}, at}]),
  ).toEqual(['created']);
  expect(
    await storage.link([{target: {root: 'models', path: 'right.gguf'}, at}]),
  ).toEqual(['replaced']);
  expect(text(await storage.read(at))).toBe('r');
  // Already right: nothing to do, and the outcome says so.
  expect(
    await storage.link([{target: {root: 'models', path: 'right.gguf'}, at}]),
  ).toEqual(['kept']);
});

test('link never overwrites a real file, only symlinks', async () => {
  // Lemonade calls the extra dir user-managed: a real file there is somebody's
  // own model, not something a sync may replace with a link.
  const {storage} = await tmpStorage();
  await storage.write({root: 'models', path: 'real.gguf'}, bytes('r'));
  const at = {root: 'lemonade', path: 'extra/m/own.gguf'} as const;
  await storage.write(at, bytes('the user put this here'));

  expect(
    await storage.link([{target: {root: 'models', path: 'real.gguf'}, at}]),
  ).toEqual(['skipped']);
  expect(text(await storage.read(at))).toBe('the user put this here');
});

test('a dry-run link reports outcomes without touching anything', async () => {
  // The sync preview is a dry run of the sync, so the two can't disagree.
  const {storage} = await tmpStorage();
  await storage.write({root: 'models', path: 'a.gguf'}, bytes('a'));
  const at = {root: 'lemonade', path: 'extra/m/a.gguf'} as const;

  expect(
    await storage.link([{target: {root: 'models', path: 'a.gguf'}, at}], {
      dryRun: true,
    }),
  ).toEqual(['created']);
  await expect(storage.read(at)).rejects.toThrow(); // nothing was created
});

test('usage reports the filesystem holding a root', async () => {
  const {storage} = await tmpStorage();
  const {free, total, device} = await storage.usage('models');
  expect(total).toBeGreaterThan(0);
  expect(free).toBeGreaterThan(0);
  expect(free).toBeLessThanOrEqual(total);
  expect(device).not.toBe('');
  // Both temp roots are on one filesystem, which is what sameDevice detects.
  expect((await storage.usage('cold')).device).toBe(device);
});

/** A minimal safetensors file whose one tensor has the given dtype. */
function safetensors(dtype: string): Buffer {
  const header = Buffer.from(JSON.stringify({w: {dtype}}), 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([len, header]);
}

test('list reports a symlink with the size of what it points at', async () => {
  // Lemonade's extra directory and the hub cache's snapshots/ are links to
  // weights: the size anyone wants is the weight's, and a dangling link is no
  // weight at all.
  const {storage, models} = await tmpStorage();
  await fsp.writeFile(nodePath.join(models, 'real.gguf'), 'abcde');
  await fsp.mkdir(nodePath.join(models, 'extra'));
  await fsp.symlink(
    nodePath.join(models, 'real.gguf'),
    nodePath.join(models, 'extra/link.gguf'),
  );
  await fsp.symlink(
    nodePath.join(models, 'gone.gguf'),
    nodePath.join(models, 'extra/dangling.gguf'),
  );

  const byPath = new Map(
    (await storage.list('models')).map((e) => [e.path, e]),
  );
  expect(byPath.get('extra/link.gguf')).toMatchObject({
    kind: 'symlink',
    size: 5,
  });
  expect(byPath.get('extra/link.gguf')?.dangling).toBeUndefined();
  expect(byPath.get('extra/dangling.gguf')).toMatchObject({
    kind: 'symlink',
    size: 0,
    dangling: true,
  });
});

test('list reads the dtype through a symlinked safetensors', async () => {
  const {storage, models} = await tmpStorage();
  await fsp.writeFile(
    nodePath.join(models, 'real.safetensors'),
    safetensors('F16'),
  );
  await fsp.symlink(
    nodePath.join(models, 'real.safetensors'),
    nodePath.join(models, 'link.safetensors'),
  );
  const entries = await storage.list('models', {dtype: true});
  expect(entries.find((e) => e.path === 'link.safetensors')?.dtype).toBe('F16');
});

test('list re-reads a safetensors header only when the file changes', async () => {
  const {storage, models} = await tmpStorage();
  const file = nodePath.join(models, 'w.safetensors');
  await fsp.writeFile(file, safetensors('BF16'));
  expect((await storage.list('models', {dtype: true}))[0].dtype).toBe('BF16');

  // Swap the bytes underneath with the size and mtime held still: the memo
  // answers, and the header isn't consulted.
  const st = await fsp.stat(file);
  await fsp.writeFile(file, safetensors('BF32'));
  await fsp.utimes(file, st.atime, st.mtime);
  expect((await storage.list('models', {dtype: true}))[0].dtype).toBe('BF16');

  // Move the mtime and the file is read again.
  const later = new Date(st.mtimeMs + 60_000);
  await fsp.utimes(file, later, later);
  expect((await storage.list('models', {dtype: true}))[0].dtype).toBe('BF32');
});

test('hash is the SHA-256 of a file, reporting every chunk on the way', async () => {
  const {storage, models} = await tmpStorage();
  const bytes = Buffer.alloc(3 * 1024 * 1024, 7);
  await fsp.writeFile(nodePath.join(models, 'w.gguf'), bytes);
  let seen = 0;
  const digest = await storage.hash(
    {root: 'models', path: 'w.gguf'},
    {onBytes: (n) => (seen += n)},
  );
  const {createHash} = await import('crypto');
  expect(digest).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(seen).toBe(bytes.length);
});

test('hash stops when its signal aborts', async () => {
  const {storage, models} = await tmpStorage();
  await fsp.writeFile(nodePath.join(models, 'w.gguf'), Buffer.alloc(1024));
  const ctl = new AbortController();
  ctl.abort();
  await expect(
    storage.hash({root: 'models', path: 'w.gguf'}, {signal: ctl.signal}),
  ).rejects.toThrow();
});

test('move carries a file from one root to another', async () => {
  // Lemonade's cache and the models root are the two ends of a sync; what a
  // move does when they sit on different filesystems (copy, then delete) is
  // the same promise, kept by the EXDEV fallback this exercises only when
  // the temp dir happens to span one.
  const {storage, models, cold} = await tmpStorage();
  await fsp.writeFile(nodePath.join(models, 'w.gguf'), 'x');
  await storage.move(
    {root: 'models', path: 'w.gguf'},
    {root: 'cold', path: 'org/repo/w.gguf'},
  );
  expect(
    await fsp.readFile(nodePath.join(cold, 'org/repo/w.gguf'), 'utf8'),
  ).toBe('x');
  await expect(fsp.access(nodePath.join(models, 'w.gguf'))).rejects.toThrow();
});
