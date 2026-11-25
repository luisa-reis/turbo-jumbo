import {test, expect} from 'bun:test';
import {
  buildSourceFiles,
  preferLocation,
  resolveSources,
} from '@/lib/copy/source-files';
import type {Model} from '@/lib/models/model-types';

const single = (path: string, size: number): Model =>
  ({
    name: 'org/repo',
    files: [{isSplit: false, path, size}],
  }) as unknown as Model;

const split = (paths: Array<[string, number]>): Model =>
  ({
    name: 'org/repo',
    files: [
      {isSplit: true, files: paths.map(([path, size]) => ({path, size}))},
    ],
  }) as unknown as Model;

test('a single-source path resolves to that source', () => {
  const idx = resolveSources({cold: [single('a.gguf', 10)]});
  expect(idx.get('a.gguf')).toEqual({from: 'cold-storage', size: 10});
});

test('shards are indexed individually', () => {
  const idx = resolveSources({
    cold: [
      split([
        ['x-00001-of-00002.gguf', 5],
        ['x-00002-of-00002.gguf', 7],
      ]),
    ],
  });
  expect(idx.get('x-00002-of-00002.gguf')).toEqual({
    from: 'cold-storage',
    size: 7,
  });
});

test('the largest copy wins, so a truncated one is never the source', () => {
  // Copying a shorter copy over a longer one would be skipped, leaving the
  // file broken — the reason size beats index order here.
  const idx = resolveSources({
    cold: [single('a.gguf', 4)],
    local: {address: '192.0.2.1:3000', models: [single('a.gguf', 10)]},
  });
  expect(idx.get('a.gguf')).toEqual({from: '192.0.2.1:3000', size: 10});
});

test('equal sizes keep cold storage, the cheapest source', () => {
  const idx = resolveSources({
    cold: [single('a.gguf', 10)],
    local: {address: '192.0.2.1:3000', models: [single('a.gguf', 10)]},
    peers: [{address: '192.0.2.2:3000', models: [single('a.gguf', 10)]}],
  });
  expect(idx.get('a.gguf')!.from).toBe('cold-storage');
});

test('the local peer is not indexed twice when it also appears among peers', () => {
  const local = {address: '192.0.2.1:3000', models: [single('a.gguf', 10)]};
  const idx = resolveSources({
    local,
    peers: [local, {address: '192.0.2.2:3000', models: [single('a.gguf', 20)]}],
  });
  expect(idx.get('a.gguf')).toEqual({from: '192.0.2.2:3000', size: 20});
});

test('buildSourceFiles pairs each path with its source', () => {
  const idx = resolveSources({cold: [single('a.gguf', 10)]});
  expect(buildSourceFiles(idx, ['a.gguf'])).toEqual([
    {path: 'a.gguf', from: 'cold-storage', size: 10},
  ]);
});

test('a path with no known copy is dropped rather than passed on', () => {
  const idx = resolveSources({cold: [single('a.gguf', 10)]});
  expect(buildSourceFiles(idx, ['a.gguf', 'ghost.gguf'])).toHaveLength(1);
});

test('a copy from a tab reads that location even when a larger old copy exists', () => {
  // An upstream update shrank the file: the tab's peer has the new, smaller
  // one; cold storage still holds the old, larger one. Copying from the tab
  // must send the new file, not "the largest" old one.
  const everywhere = resolveSources({
    cold: [single('m.gguf', 200)],
    peers: [
      {address: 'peer-a', models: [single('m.gguf', 150)]},
      {address: 'peer-b', models: [single('other.gguf', 5)]},
    ],
  });
  const at = resolveSources({
    peers: [{address: 'peer-a', models: [single('m.gguf', 150)]}],
  });
  const idx = preferLocation(at, everywhere);
  expect(buildSourceFiles(idx, ['m.gguf', 'other.gguf'])).toEqual([
    {path: 'm.gguf', from: 'peer-a', size: 150},
    // Not on the tab's location: falls back to wherever it is.
    {path: 'other.gguf', from: 'peer-b', size: 5},
  ]);
});
