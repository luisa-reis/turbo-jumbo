import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {mkdtemp, rm, writeFile} from 'fs/promises';
import {tmpdir} from 'os';
import path from 'path';
import {servedBinaries} from '@/lib/cli/served-binaries';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'tj-cli-'));
});
afterEach(async () => {
  await rm(dir, {recursive: true, force: true});
});

describe('servedBinaries', () => {
  test('lists nothing from an empty or missing dir', async () => {
    expect(await servedBinaries(dir)).toEqual([]);
    expect(await servedBinaries(path.join(dir, 'absent'))).toEqual([]);
  });

  test('lists only the binaries present, in target order, with hashes', async () => {
    const hash = 'c'.repeat(64);
    await writeFile(path.join(dir, 'tj-linux-x64'), 'xx');
    await writeFile(path.join(dir, 'tj-darwin-arm64'), 'xyz');
    await writeFile(path.join(dir, 'SHA256SUMS'), `${hash}  tj-darwin-arm64\n`);
    await writeFile(path.join(dir, 'tj-unknown'), 'ignored');

    expect(await servedBinaries(dir)).toEqual([
      {
        target: 'darwin-arm64',
        platform: 'macOS, Apple silicon',
        name: 'tj-darwin-arm64',
        size: 3,
        sha256: hash,
        path: '/api/v1/cli/tj-darwin-arm64',
      },
      {
        target: 'linux-x64',
        platform: 'Linux, x86-64',
        name: 'tj-linux-x64',
        size: 2,
        sha256: null,
        path: '/api/v1/cli/tj-linux-x64',
      },
    ]);
  });
});
