import {test, expect} from 'bun:test';
import {createHash} from 'crypto';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {peerResumeOffset, type PeerFileReader} from '@/lib/storage/peer-resume';

const SOURCE = 'the quick brown fox jumps over the lazy dog';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function sourceFile(content = SOURCE): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-resume-'));
  const full = path.join(dir, 'model-00001-of-00002.safetensors');
  await fsp.writeFile(full, content);
  return full;
}

/** A peer holding `content`, or holding nothing when null. */
const peerHolding = (content: string | null): PeerFileReader => ({
  size: async () => (content === null ? null : content.length),
  sha256: async () => (content === null ? null : sha(content)),
});

const resume = async (reader: PeerFileReader, srcFull: string, extra = {}) =>
  peerResumeOffset({
    peer: '192.0.2.1:3000',
    file: 'org/repo/model-00001-of-00002.safetensors',
    srcFull,
    srcSize: SOURCE.length,
    reader,
    ...extra,
  });

test('resumes from a partial that is a verified prefix', async () => {
  const src = await sourceFile();
  const partial = SOURCE.slice(0, 19);
  expect(await resume(peerHolding(partial), src)).toBe(19);
});

test('sends the whole file when the partial holds different bytes', async () => {
  const src = await sourceFile();
  // Same length as a real prefix, but not this file's bytes — resuming here
  // would splice a good tail onto a bad head and look complete.
  const wrong = 'THE QUICK BROWN FOX'; // 19 chars, like the prefix above
  expect(wrong.length).toBe(19);
  expect(await resume(peerHolding(wrong), src)).toBe(0);
});

test('sends the whole file when the destination is absent or empty', async () => {
  const src = await sourceFile();
  expect(await resume(peerHolding(null), src)).toBe(0);
  expect(await resume(peerHolding(''), src)).toBe(0);
});

test('sends the whole file when the destination is longer than the source', async () => {
  const src = await sourceFile();
  // Longer than what we are sending, so it cannot be a prefix of it.
  expect(await resume(peerHolding(SOURCE + ' and then some'), src)).toBe(0);
});

test('sends the whole file when the peer cannot answer with a digest', async () => {
  const src = await sourceFile();
  // A peer too old to report SHA256: unknown bytes are not a verified prefix.
  const oldPeer: PeerFileReader = {
    size: async () => 19,
    sha256: async () => null,
  };
  expect(await resume(oldPeer, src)).toBe(0);
});

test('sends nothing when the destination is already complete and identical', async () => {
  const src = await sourceFile();
  expect(await resume(peerHolding(SOURCE), src)).toBe(SOURCE.length);
});

test('reports hashing progress only when a partial is actually verified', async () => {
  const src = await sourceFile();
  const seen: Array<[number, number]> = [];
  const onVerify = (done: number, total: number) => seen.push([done, total]);

  await resume(peerHolding(null), src, {onVerify});
  expect(seen).toEqual([]); // nothing there: no hash, so no progress

  await resume(peerHolding(SOURCE.slice(0, 19)), src, {onVerify});
  expect(seen.length).toBeGreaterThan(0);
  // Progress covers this side's read only — the peer hashes out of sight.
  expect(seen.at(-1)).toEqual([19, 19]);
});

test('a source that cannot be read sends the whole file rather than throwing', async () => {
  const missing = path.join(os.tmpdir(), 'tj-resume-nonexistent', 'gone.gguf');
  expect(await resume(peerHolding(SOURCE.slice(0, 19)), missing)).toBe(0);
});
