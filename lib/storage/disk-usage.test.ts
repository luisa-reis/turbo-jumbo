import {test, expect} from 'bun:test';
import {downloadDiskUsage} from '@/lib/storage/disk-usage';
import type {Root, Usage} from '@/lib/storage/storage';

/** The whole dependency is `usage`, so the fake is one function. */
const fake = (byRoot: Partial<Record<Root, Usage>>) => ({
  usage: async (root: Root) => {
    const u = byRoot[root];
    if (!u) throw new Error(`No ${root} directory is configured`);
    return u;
  },
});

const usage = (free: number, device: string): Usage => ({
  free,
  total: free * 2,
  device,
});

test('two roots on one filesystem share their free space', async () => {
  // The pool is single, so a kept copy needs room for two — which is what
  // sameDevice tells the warning logic.
  const out = await downloadDiskUsage(
    fake({models: usage(100, 'dev-1'), cold: usage(100, 'dev-1')}),
  );
  expect(out.sameDevice).toBe(true);
  expect(out.models).toEqual({free: 100, total: 200});
});

test('two roots on different filesystems do not', async () => {
  const out = await downloadDiskUsage(
    fake({models: usage(100, 'dev-1'), cold: usage(900, 'dev-2')}),
  );
  expect(out.sameDevice).toBe(false);
  expect(out.cold).toEqual({free: 900, total: 1800});
});

test('the device id never reaches the wire', async () => {
  // It is an implementation detail of the comparison; DiskUsage is a public
  // response shape and gains nothing from a host's st_dev.
  const out = await downloadDiskUsage(
    fake({models: usage(1, 'dev-1'), cold: usage(1, 'dev-1')}),
  );
  expect(Object.keys(out.models).sort()).toEqual(['free', 'total']);
});

test('a machine with no cold storage surfaces the reason', async () => {
  await expect(
    downloadDiskUsage(fake({models: usage(1, 'dev-1')})),
  ).rejects.toThrow(/No cold directory/);
});
