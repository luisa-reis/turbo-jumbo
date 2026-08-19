import {test, expect} from 'bun:test';
import {existsSync, promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {readMetaResolved, updateMetaResolved, type TjMeta} from '@/lib/models/tjmeta';
import {createLocalStorage} from '@/lib/storage/local-storage';

const meta = (o: Partial<TjMeta>): TjMeta => ({
  modelUrl: 'https://huggingface.co/org/repo',
  originUrl: 'https://huggingface.co/org/repo/blob/main/a.gguf',
  sourceSize: 3,
  computedSize: 3,
  sourceSha256: '',
  computedSha256: '',
  ...o,
});

async function mkbase() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-tjmeta-'));
  return {
    base,
    site: {storage: createLocalStorage({models: base}), root: 'models'} as const,
  };
}

test('readMetaResolved migrates a legacy sidecar through a storage site', async () => {
  const {base, site} = await mkbase();
  await fsp.mkdir(path.join(base, 'org/repo'), {recursive: true});
  await fsp.writeFile(
    path.join(base, 'org/repo/a.gguf.tjmeta.json'),
    JSON.stringify(meta({})),
  );

  const got = await readMetaResolved(site, 'org/repo/a.gguf');
  expect(got?.modelUrl).toBe('https://huggingface.co/org/repo');
  // Lazily migrated: the model sidecar exists, the legacy per-file one is gone.
  expect(existsSync(path.join(base, 'org/repo/tjmodel.json'))).toBe(true);
  expect(existsSync(path.join(base, 'org/repo/a.gguf.tjmeta.json'))).toBe(false);
  await fsp.rm(base, {recursive: true, force: true});
});

test('updateMetaResolved writes a stray file legacy sidecar through a site', async () => {
  const {base, site} = await mkbase();
  // A stray at the storage root has no model dir; provenance falls back to a
  // legacy per-file sidecar.
  await updateMetaResolved(site, 'stray.gguf', 'org/repo', meta({}));
  expect(existsSync(path.join(base, 'stray.gguf.tjmeta.json'))).toBe(true);
  await fsp.rm(base, {recursive: true, force: true});
});
