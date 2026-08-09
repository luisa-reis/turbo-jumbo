import {test, expect} from 'bun:test';
import {
  checkStatusLabel,
  isIdenticalAtDestination,
  skipListFor,
  type ConflictItem,
} from '@/lib/storage/check-progress';

const conflict = (over: Partial<ConflictItem> = {}): ConflictItem => ({
  file: 'Qwen/Qwen3.6-27B/config.json',
  destination: '192.0.2.1:3000',
  sourceSize: 12,
  destSize: 12,
  sizeMatch: true,
  digest: 'sha256',
  digestMatch: true,
  sourceDigest: 'aa',
  destDigest: 'aa',
  ...over,
});

test('skips only what is provably the same file', () => {
  const skip = skipListFor([
    conflict({file: 'same.json'}),
    // Same size, different bytes: the destination copy is not this file.
    conflict({
      file: 'different.json',
      digestMatch: false,
      destDigest: 'bb',
    }),
    // Sizes differ, so the check never got as far as a digest.
    conflict({
      file: 'truncated.json',
      destSize: 3,
      sizeMatch: false,
      digest: null,
      digestMatch: null,
      sourceDigest: null,
      destDigest: null,
    }),
    // Same size but neither side could vouch for its bytes — unknown is not
    // identical, so it gets copied over rather than silently left alone.
    conflict({
      file: 'unverifiable.json',
      digest: null,
      digestMatch: null,
      sourceDigest: null,
      destDigest: null,
    }),
  ]);
  expect(skip).toEqual([{file: 'same.json', destination: '192.0.2.1:3000'}]);
});

test('skips per file and destination, not per file', () => {
  // The same file, already archived but missing from the peer: the archive is
  // left alone and the peer still gets its copy.
  const skip = skipListFor([
    conflict({destination: 'cold-storage'}),
    conflict({destination: '192.0.2.1:3000', digestMatch: false}),
  ]);
  expect(skip).toEqual([
    {file: 'Qwen/Qwen3.6-27B/config.json', destination: 'cold-storage'},
  ]);
});

test('an empty check skips nothing', () => {
  expect(skipListFor([])).toEqual([]);
});

test('identity is digest agreement, and nothing weaker', () => {
  expect(isIdenticalAtDestination(conflict())).toBe(true);
  // Same size, no digest: the check was told not to read, or a peer too old to
  // answer in SHA256 offered nothing. Unknown is not identical.
  expect(
    isIdenticalAtDestination(conflict({digest: null, digestMatch: null})),
  ).toBe(false);
});

test('the status label names the slow stretch', () => {
  expect(checkStatusLabel(null)).toBe('Checking…');
  expect(
    checkStatusLabel({done: 2, total: 10, file: 'a', hashing: false}),
  ).toBe('Checking 3/10…');
  expect(checkStatusLabel({done: 2, total: 10, file: 'a', hashing: true})).toBe(
    'Verifying 3/10…',
  );
});
