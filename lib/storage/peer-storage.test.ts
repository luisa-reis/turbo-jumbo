import {expect, test} from 'bun:test';
import {mkdir, mkdtemp, rm, writeFile} from 'fs/promises';
import {tmpdir} from 'os';
import path from 'path';
import {mountStorageFor} from '@/lib/storage/peer-storage';

test('a peer without models_mount has no mount storage', () => {
  expect(mountStorageFor({})).toBeUndefined();
});

test('mount storage reads the mounted models root, one storage per mount', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tj-mount-'));
  try {
    await mkdir(path.join(dir, 'org/repo'), {recursive: true});
    await writeFile(path.join(dir, 'org/repo/model.gguf'), 'abc');
    const s = mountStorageFor({models_mount: dir})!;
    expect(mountStorageFor({models_mount: dir})).toBe(s);
    const entries = await s.list('models', {under: 'org/repo'});
    expect(entries.map((e) => [e.path, e.size])).toEqual([
      ['org/repo/model.gguf', 3],
    ]);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
