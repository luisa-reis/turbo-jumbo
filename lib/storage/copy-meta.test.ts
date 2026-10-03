import {dirSite} from '@/lib/storage/site';
import {test, expect} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {
  applyFileMeta,
  propagateFileMeta,
  readFileMetaWithRepoHead,
} from '@/lib/storage/copy-meta';
import {
  readModelSidecar,
  writeModelSidecar,
  type TjModel,
  type TjModelFile,
} from '@/lib/models/model-sidecar';
import {readMeta, writeMeta, type TjMeta} from '@/lib/models/tjmeta';

const meta = (o: Partial<TjMeta> = {}): TjMeta => ({
  modelUrl: 'https://huggingface.co/org/repo',
  originUrl: 'https://huggingface.co/org/repo/blob/main/a.gguf',
  sourceSize: 3,
  computedSize: 3,
  sourceSha256: 'aaa',
  computedSha256: 'aaa',
  ...o,
});

const entry = (o: Partial<TjModelFile>): TjModelFile => ({
  path: 'a.gguf',
  originUrl: 'https://huggingface.co/org/repo/blob/main/a.gguf',
  sourceSize: 3,
  computedSize: 3,
  sourceSha256: 'aaa',
  computedSha256: 'aaa',
  ...o,
});

const model = (o: Partial<TjModel>): TjModel => ({
  modelUrl: 'https://huggingface.co/org/repo',
  repoId: 'org/repo',
  files: [],
  ...o,
});

async function tmpBases(): Promise<{root: string; src: string; dst: string}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-copymeta-'));
  const src = path.join(root, 'src');
  const dst = path.join(root, 'dst');
  await fsp.mkdir(src, {recursive: true});
  await fsp.mkdir(dst, {recursive: true});
  return {root, src, dst};
}

test('propagateFileMeta merges into the destination sidecar, keeping dest-only entries', async () => {
  const {root, src, dst} = await tmpBases();
  await writeModelSidecar(
    dirSite(src),
    'org/repo',
    model({files: [entry({})]}),
  );
  await writeModelSidecar(
    dirSite(dst),
    'org/repo',
    model({
      files: [
        entry({
          path: 'b.gguf',
          originUrl: 'https://huggingface.co/org/repo/blob/main/b.gguf',
        }),
      ],
    }),
  );

  await propagateFileMeta(dirSite(src), dirSite(dst), 'org/repo/a.gguf');

  const after = await readModelSidecar(dirSite(dst), 'org/repo');
  expect(after?.files.map((f) => f.path).sort()).toEqual(['a.gguf', 'b.gguf']);
  expect(after?.files.find((f) => f.path === 'a.gguf')?.sourceSha256).toBe(
    'aaa',
  );
  await fsp.rm(root, {recursive: true, force: true});
});

test('propagateFileMeta falls back to a legacy sidecar for a stray file', async () => {
  const {root, src, dst} = await tmpBases();
  // A stray file at the storage root has no model dir; its provenance lives in
  // a legacy per-file sidecar and must arrive at the destination the same way.
  await writeMeta(
    path.join(src, 'stray.gguf'),
    meta({originUrl: 'https://huggingface.co/org/repo/blob/main/stray.gguf'}),
  );

  await propagateFileMeta(dirSite(src), dirSite(dst), 'stray.gguf');

  const after = await readMeta(path.join(dst, 'stray.gguf'));
  expect(after?.sourceSha256).toBe('aaa');
  expect(await readModelSidecar(dirSite(dst), 'org/repo')).toBeNull();
  await fsp.rm(root, {recursive: true, force: true});
});

test('propagateFileMeta is a no-op when the source has no provenance', async () => {
  const {root, src, dst} = await tmpBases();
  await propagateFileMeta(dirSite(src), dirSite(dst), 'org/repo/a.gguf');
  expect(await readModelSidecar(dirSite(dst), 'org/repo')).toBeNull();
  await fsp.rm(root, {recursive: true, force: true});
});

test('readFileMetaWithRepoHead carries the source model repoCommit', async () => {
  const {root, src} = await tmpBases();
  await writeModelSidecar(
    dirSite(src),
    'org/repo',
    model({files: [entry({})], repoCommit: 'head1', repoCommitDate: 'd1'}),
  );

  const payload = await readFileMetaWithRepoHead(
    dirSite(src),
    'org/repo/a.gguf',
  );
  expect(payload?.meta.sourceSha256).toBe('aaa');
  expect(payload?.repoHead).toEqual({id: 'head1', date: 'd1'});
  await fsp.rm(root, {recursive: true, force: true});
});

test('applyFileMeta sets repoCommit only when the destination has none', async () => {
  const {root, dst} = await tmpBases();
  // Fresh destination: the forwarded head lands.
  await applyFileMeta(dirSite(dst), 'org/repo/a.gguf', meta(), {id: 'srchead'});
  expect((await readModelSidecar(dirSite(dst), 'org/repo'))?.repoCommit).toBe(
    'srchead',
  );

  // Destination already has an observation: a copy must not clobber it.
  const dst2 = path.join(root, 'dst2');
  await writeModelSidecar(
    dirSite(dst2),
    'org/repo',
    model({files: [], repoCommit: 'desthead'}),
  );
  await applyFileMeta(dirSite(dst2), 'org/repo/a.gguf', meta(), {
    id: 'srchead',
  });
  expect((await readModelSidecar(dirSite(dst2), 'org/repo'))?.repoCommit).toBe(
    'desthead',
  );
  await fsp.rm(root, {recursive: true, force: true});
});

// An FLM-style model: pinned, and complete with fewer files than its repo has.
const scoped = {revision: 'v1', fileScope: ['a.gguf', 'b.gguf']};
const bEntry = entry({
  path: 'b.gguf',
  originUrl: 'https://huggingface.co/org/repo/blob/main/b.gguf',
});

test('readFileMetaWithRepoHead carries the source model revision and file scope', async () => {
  const {root, src} = await tmpBases();
  await writeModelSidecar(
    dirSite(src),
    'org/repo',
    model({files: [entry({})], ...scoped}),
  );
  const payload = await readFileMetaWithRepoHead(
    dirSite(src),
    'org/repo/a.gguf',
  );
  expect(payload?.modelScope).toEqual(scoped);
  await fsp.rm(root, {recursive: true, force: true});
});

test('a copy of a scoped model keeps its revision and scope at a fresh destination', async () => {
  const {root, src, dst} = await tmpBases();
  await writeModelSidecar(
    dirSite(src),
    'org/repo',
    model({files: [entry({}), bEntry], ...scoped}),
  );

  // The copy route propagates a model's files concurrently.
  await Promise.all(
    ['org/repo/a.gguf', 'org/repo/b.gguf'].map((p) =>
      propagateFileMeta(dirSite(src), dirSite(dst), p),
    ),
  );

  const after = await readModelSidecar(dirSite(dst), 'org/repo');
  expect(after?.revision).toBe('v1');
  expect(after?.fileScope).toEqual(['a.gguf', 'b.gguf']);
  expect(after?.files.map((f) => f.path).sort()).toEqual(['a.gguf', 'b.gguf']);
  await fsp.rm(root, {recursive: true, force: true});
});

test('a copy never narrows or repins a model the destination already has', async () => {
  const {root, src, dst} = await tmpBases();
  await writeModelSidecar(
    dirSite(src),
    'org/repo',
    model({files: [entry({})], ...scoped}),
  );
  // A whole-repo download at the destination: unpinned and unscoped on purpose.
  await writeModelSidecar(dirSite(dst), 'org/repo', model({files: [bEntry]}));

  await propagateFileMeta(dirSite(src), dirSite(dst), 'org/repo/a.gguf');

  const after = await readModelSidecar(dirSite(dst), 'org/repo');
  expect(after?.revision).toBeUndefined();
  expect(after?.fileScope).toBeUndefined();
  expect(after?.files.map((f) => f.path).sort()).toEqual(['a.gguf', 'b.gguf']);
  await fsp.rm(root, {recursive: true, force: true});
});

test('a copy of an unscoped model adds no scope', async () => {
  const {root, src, dst} = await tmpBases();
  await writeModelSidecar(
    dirSite(src),
    'org/repo',
    model({files: [entry({})]}),
  );
  await propagateFileMeta(dirSite(src), dirSite(dst), 'org/repo/a.gguf');
  const after = await readModelSidecar(dirSite(dst), 'org/repo');
  expect(after).not.toHaveProperty('revision');
  expect(after).not.toHaveProperty('fileScope');
  await fsp.rm(root, {recursive: true, force: true});
});
