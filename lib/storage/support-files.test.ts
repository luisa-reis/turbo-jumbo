import {test, expect} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {
  expandSupportFiles,
  resolveSupportFiles,
  supportFileSources,
} from '@/lib/storage/support-files';

async function makeRepo(files: Record<string, string>): Promise<string> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-support-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(base, rel);
    await fsp.mkdir(path.dirname(full), {recursive: true});
    await fsp.writeFile(full, content);
  }
  return base;
}

test('expands a whole-repo model with its non-weight support files', async () => {
  const base = await makeRepo({
    'Qwen/Qwen3.6-35B-A3B/model-00001-of-00002.safetensors': 'ww',
    'Qwen/Qwen3.6-35B-A3B/model-00002-of-00002.safetensors': 'ww',
    'Qwen/Qwen3.6-35B-A3B/model.safetensors.index.json': '{}',
    'Qwen/Qwen3.6-35B-A3B/config.json': '{}',
    'Qwen/Qwen3.6-35B-A3B/tokenizer.json': '{"a":1}',
  });
  const extra = await expandSupportFiles(base, [
    'Qwen/Qwen3.6-35B-A3B/model-00001-of-00002.safetensors',
    'Qwen/Qwen3.6-35B-A3B/model-00002-of-00002.safetensors',
  ]);
  expect(extra.map((f) => f.path).sort()).toEqual([
    'Qwen/Qwen3.6-35B-A3B/config.json',
    'Qwen/Qwen3.6-35B-A3B/model.safetensors.index.json',
    'Qwen/Qwen3.6-35B-A3B/tokenizer.json',
  ]);
  expect(extra.find((f) => f.path.endsWith('tokenizer.json'))!.size).toBe(7);
});

test('never drags along other quants, sidecars, or dot-clutter', async () => {
  const base = await makeRepo({
    'unsloth/repo-GGUF/model-Q4_K_M.gguf': 'ww',
    'unsloth/repo-GGUF/model-Q8_0.gguf': 'wwww',
    'unsloth/repo-GGUF/model-Q4_K_M.gguf.tjmeta.json': '{}',
    'unsloth/repo-GGUF/tjmodel.json': '{}',
    'unsloth/repo-GGUF/.cache/huggingface/x': 'c',
    'unsloth/repo-GGUF/notes.txt': 'n',
  });
  const extra = await expandSupportFiles(base, [
    'unsloth/repo-GGUF/model-Q4_K_M.gguf',
  ]);
  // The other quant (a weight file), both sidecars (they ride the meta
  // channel), and the dot-dir stay out; only the plain support file rides.
  expect(extra.map((f) => f.path)).toEqual(['unsloth/repo-GGUF/notes.txt']);
});

test('includes support files in nested subdirectories', async () => {
  const base = await makeRepo({
    'org/onnx-repo/model.safetensors': 'ww',
    'org/onnx-repo/assets/vocab.txt': 'vv',
  });
  const extra = await expandSupportFiles(base, [
    'org/onnx-repo/model.safetensors',
  ]);
  expect(extra.map((f) => f.path)).toEqual(['org/onnx-repo/assets/vocab.txt']);
});

test('ignores paths that escape the base or point at missing dirs', async () => {
  const base = await makeRepo({'org/repo/a.gguf': 'w'});
  const extra = await expandSupportFiles(base, [
    '../outside/evil.gguf',
    'org/gone/x.gguf',
  ]);
  expect(extra).toEqual([]);
});

const WEIGHTS = ['Qwen/Qwen3.6-27B/model-00001-of-00002.safetensors'];
const src = (
  from: string,
  files: Array<{path: string; size: number}>,
): Parameters<typeof resolveSupportFiles>[1][number] => ({
  from,
  list: async () => files,
});

test('takes support files from a source that has them when the weights resolve elsewhere', async () => {
  // The reported bug: a model archived to cold storage holds the weights
  // alone, and `resolveSources` prefers cold storage, so every weight file
  // resolves to a source with no support files beside it. Asking only that
  // source expanded to nothing and the copy carried bare weights.
  const resolved = await resolveSupportFiles(WEIGHTS, [
    src('cold-storage', []),
    src('192.0.2.1:3000', [
      {path: 'Qwen/Qwen3.6-27B/config.json', size: 12},
      {path: 'Qwen/Qwen3.6-27B/tokenizer.json', size: 40},
    ]),
  ]);
  expect(resolved).toEqual([
    {path: 'Qwen/Qwen3.6-27B/config.json', from: '192.0.2.1:3000', size: 12},
    {path: 'Qwen/Qwen3.6-27B/tokenizer.json', from: '192.0.2.1:3000', size: 40},
  ]);
});

test('prefers the largest copy of a support file, then the earlier source', async () => {
  const resolved = await resolveSupportFiles(WEIGHTS, [
    src('cold-storage', [
      {path: 'Qwen/Qwen3.6-27B/config.json', size: 12},
      {path: 'Qwen/Qwen3.6-27B/vocab.json', size: 5},
    ]),
    src('192.0.2.1:3000', [
      // A truncated copy must never win: copying it over a complete one is
      // skipped as "already there" and leaves the file broken.
      {path: 'Qwen/Qwen3.6-27B/config.json', size: 3},
      {path: 'Qwen/Qwen3.6-27B/vocab.json', size: 99},
    ]),
  ]);
  expect(resolved).toEqual([
    {path: 'Qwen/Qwen3.6-27B/config.json', from: 'cold-storage', size: 12},
    {path: 'Qwen/Qwen3.6-27B/vocab.json', from: '192.0.2.1:3000', size: 99},
  ]);
});

test('never re-adds a file the copy already carries', async () => {
  const resolved = await resolveSupportFiles(WEIGHTS, [
    src('cold-storage', [
      {path: WEIGHTS[0], size: 100},
      {path: 'Qwen/Qwen3.6-27B/config.json', size: 12},
    ]),
  ]);
  expect(resolved.map((f) => f.path)).toEqual(['Qwen/Qwen3.6-27B/config.json']);
});

test('an unreachable source does not sink the others', async () => {
  const seen: string[] = [];
  const resolved = await resolveSupportFiles(
    WEIGHTS,
    [
      {
        from: 'cold-storage',
        list: async () => {
          throw new Error('mount is gone');
        },
      },
      src('192.0.2.1:3000', [{path: 'Qwen/Qwen3.6-27B/config.json', size: 12}]),
    ],
    {onError: (from, message) => seen.push(`${from}: ${message}`)},
  );
  expect(resolved.map((f) => f.from)).toEqual(['192.0.2.1:3000']);
  expect(seen).toEqual(['cold-storage: mount is gone']);
});

test('drops support paths that escape the model tree', async () => {
  // A peer answers this over HTTP, so its paths are untrusted: an absolute or
  // climbing path must never reach a destination write.
  const resolved = await resolveSupportFiles(WEIGHTS, [
    src('192.0.2.1:3000', [
      {path: '../../etc/passwd', size: 1},
      {path: '/etc/shadow', size: 1},
      {path: 'Qwen/Qwen3.6-27B/config.json', size: 12},
    ]),
  ]);
  expect(resolved.map((f) => f.path)).toEqual(['Qwen/Qwen3.6-27B/config.json']);
});

test('asks the copy sources first, then cold storage and local models', () => {
  const sources = supportFileSources({
    froms: ['cold-storage'],
    coldBase: '/cold',
    localBase: '/local',
    localPeerAddr: '192.0.2.1:3000',
    listPeer: async () => [],
  });
  // Cold storage came in as a copy source, so it is not asked twice; the
  // local peer is appended because it may hold what cold storage lacks.
  expect(sources.map((s) => s.from)).toEqual([
    'cold-storage',
    '192.0.2.1:3000',
  ]);
});

test('skips tiers this host has not configured', () => {
  const sources = supportFileSources({
    froms: ['192.0.2.9:3000'],
    coldBase: '',
    localBase: '',
    localPeerAddr: '192.0.2.1:3000',
    listPeer: async () => [],
  });
  expect(sources.map((s) => s.from)).toEqual(['192.0.2.9:3000']);
});
