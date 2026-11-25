import {test, expect} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {
  cacheChanged,
  refreshLemonadeList,
  REFRESH_MARKER,
} from '@/lib/lemonade/lemonade-list-refresh';
import {createLocalStorage} from '@/lib/storage/local-storage';

test('cacheChanged: links, moves and removals count; leaving things be does not', () => {
  const result = (status: string) => [
    {repoId: 'o/r', rev: 'abc', files: [{repoPath: 'a.gguf', status}]},
  ];
  for (const s of ['materialized', 'linked', 'deduplicated', 'stale-removed'])
    expect(cacheChanged(result(s) as never, [])).toBe(true);
  for (const s of ['already-linked', 'skipped', 'error'])
    expect(cacheChanged(result(s) as never, [])).toBe(false);
  const moved = {repoId: 'o/r', from: 'x', to: 'y', side: 'builtin'};
  expect(cacheChanged([], [{...moved, status: 'moved'}] as never)).toBe(true);
  expect(cacheChanged([], [{...moved, status: 'conflict'}] as never)).toBe(
    false,
  );
});

test('refreshLemonadeList creates and removes a marker in the extra-models dir', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-list-refresh-'));
  const lem = path.join(base, 'lemonade');
  const extra = path.join(lem, 'extra');
  await fsp.mkdir(extra, {recursive: true});
  try {
    const storage = createLocalStorage({
      models: path.join(base, 'tj'),
      lemonade: lem,
    });
    const calls: string[] = [];
    const out = await refreshLemonadeList({
      ...storage,
      write: (ref, bytes) => {
        calls.push(`write ${ref.root}:${ref.path}`);
        return storage.write(ref, bytes);
      },
      remove: (refs, opts) => {
        calls.push(...refs.map((r) => `remove ${r.root}:${r.path}`));
        return storage.remove(refs, opts);
      },
    });
    expect(out).toEqual({ok: true});
    const marker = `${REFRESH_MARKER.root}:${REFRESH_MARKER.path}`;
    expect(calls).toEqual([`write ${marker}`, `remove ${marker}`]);
    expect(await fsp.readdir(extra)).toEqual([]);
  } finally {
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('refreshLemonadeList reports a failure instead of throwing', async () => {
  const out = await refreshLemonadeList({
    write: () => Promise.reject(new Error('no lemonade root')),
  } as never);
  expect(out).toEqual({ok: false, message: 'no lemonade root'});
});
