import {test, expect} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {placeRepos, planPlacement} from '@/lib/lemonade/lemonade-place';
import {createLocalStorage} from '@/lib/storage/local-storage';
import {listedRepoIds, sideFor} from '@/lib/lemonade/lemonade-sides';

const LISTED = listedRepoIds(
  ['unsloth/gemma-3-270m-it-GGUF'],
  ['FastFlowLM/Qwen3-8B'],
);

/** A cache root with the given `models--…` dirs, each holding one file. */
async function cacheRoot(dirs: string[]): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-place-'));
  for (const d of dirs) {
    const full = path.join(root, d, 'snapshots', 'abc123');
    await fsp.mkdir(full, {recursive: true});
    await fsp.writeFile(path.join(full, 'model.gguf'), 'w');
  }
  return root;
}

const exists = async (p: string) =>
  await fsp
    .stat(p)
    .then(() => true)
    .catch(() => false);

test('a listed repo goes to builtin and an unlisted one to extra', () => {
  expect(sideFor('unsloth/gemma-3-270m-it-GGUF', LISTED)).toBe('builtin');
  expect(sideFor('unsloth/DeepSeek-V4-Flash-0731-GGUF', LISTED)).toBe('extra');
  // A FastFlowLM tag's repo is Lemonade's own, catalog or not.
  expect(sideFor('FastFlowLM/Qwen3-8B', LISTED)).toBe('builtin');
});

test('entries left at the cache root are sorted onto both sides', async () => {
  const root = await cacheRoot([
    'models--unsloth--gemma-3-270m-it-GGUF',
    'models--unsloth--DeepSeek-V4-Flash-0731-GGUF',
  ]);
  const done = await placeRepos(createLocalStorage({lemonade: root}), LISTED);
  expect(done.every((p) => p.status === 'moved')).toBe(true);

  expect(
    await exists(
      path.join(root, 'builtin', 'models--unsloth--gemma-3-270m-it-GGUF'),
    ),
  ).toBe(true);
  expect(
    await exists(
      path.join(root, 'extra', 'models--unsloth--DeepSeek-V4-Flash-0731-GGUF'),
    ),
  ).toBe(true);
  // Nothing is left behind at the root.
  expect(
    await exists(path.join(root, 'models--unsloth--gemma-3-270m-it-GGUF')),
  ).toBe(false);
});

test('the files inside travel with the directory', async () => {
  const root = await cacheRoot(['models--unsloth--gemma-3-270m-it-GGUF']);
  await placeRepos(createLocalStorage({lemonade: root}), LISTED);
  const moved = path.join(
    root,
    'builtin',
    'models--unsloth--gemma-3-270m-it-GGUF',
    'snapshots',
    'abc123',
    'model.gguf',
  );
  expect(await fsp.readFile(moved, 'utf8')).toBe('w');
});

test('a repo already on the right side is left where it is', async () => {
  const root = await cacheRoot([
    path.join('builtin', 'models--unsloth--gemma-3-270m-it-GGUF'),
  ]);
  const done = await placeRepos(createLocalStorage({lemonade: root}), LISTED);
  expect(done.map((p) => p.status)).toEqual(['in-place']);
});

test('a repo the catalog has since picked up moves back from extra', async () => {
  // The case that makes this run every sync rather than once: listedness
  // changes under a cache that was sorted correctly at the time.
  const root = await cacheRoot([
    path.join('extra', 'models--unsloth--gemma-3-270m-it-GGUF'),
  ]);
  const done = await placeRepos(createLocalStorage({lemonade: root}), LISTED);
  expect(done.map((p) => p.status)).toEqual(['moved']);
  expect(
    await exists(
      path.join(root, 'builtin', 'models--unsloth--gemma-3-270m-it-GGUF'),
    ),
  ).toBe(true);
});

test('the same repo on both sides is reported, and neither copy is touched', async () => {
  const root = await cacheRoot([
    path.join('builtin', 'models--unsloth--gemma-3-270m-it-GGUF'),
    path.join('extra', 'models--unsloth--gemma-3-270m-it-GGUF'),
  ]);
  const done = await placeRepos(createLocalStorage({lemonade: root}), LISTED);
  const conflict = done.find((p) => p.status === 'conflict');
  expect(conflict?.repoId).toBe('unsloth/gemma-3-270m-it-GGUF');
  // One of them is stale, but which one holds real bytes is not a guess worth
  // making with a delete — both survive.
  for (const side of ['builtin', 'extra']) {
    expect(
      await exists(
        path.join(root, side, 'models--unsloth--gemma-3-270m-it-GGUF'),
      ),
    ).toBe(true);
  }
});

test('nothing moves when Lemonade could not say what it lists', async () => {
  // An empty set is what a failed catalog fetch looks like. Acting on it would
  // sweep the whole library into extra.
  const root = await cacheRoot([
    'models--unsloth--gemma-3-270m-it-GGUF',
    'models--unsloth--DeepSeek-V4-Flash-0731-GGUF',
  ]);
  expect(await planPlacement(createLocalStorage({lemonade: root}), new Set())).toEqual([]);
  expect(await placeRepos(createLocalStorage({lemonade: root}), new Set())).toEqual([]);
  expect(
    await exists(path.join(root, 'models--unsloth--gemma-3-270m-it-GGUF')),
  ).toBe(true);
});

test('planning reports the moves without making them', async () => {
  const root = await cacheRoot(['models--unsloth--gemma-3-270m-it-GGUF']);
  const plan = await planPlacement(createLocalStorage({lemonade: root}), LISTED);
  expect(plan.map((p) => [p.repoId, p.side, p.status])).toEqual([
    ['unsloth/gemma-3-270m-it-GGUF', 'builtin', 'moved'],
  ]);
  expect(
    await exists(path.join(root, 'models--unsloth--gemma-3-270m-it-GGUF')),
  ).toBe(true); // still where it was
});

test('directories that are not cache entries are ignored', async () => {
  const root = await cacheRoot(['models--unsloth--gemma-3-270m-it-GGUF']);
  await fsp.mkdir(path.join(root, 'tmp-not-a-repo'), {recursive: true});
  const done = await placeRepos(createLocalStorage({lemonade: root}), LISTED);
  expect(done.map((p) => p.repoId)).toEqual(['unsloth/gemma-3-270m-it-GGUF']);
  expect(await exists(path.join(root, 'tmp-not-a-repo'))).toBe(true);
});
