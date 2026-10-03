import {test, expect} from 'bun:test';
import {
  flmRegistryFiles,
  parseFlmRegistry,
  parseFlmSourceUrl,
} from '@/lib/lemonade/flm-registry';

test('parseFlmSourceUrl handles plain, resolve- and tree-pinned HF urls', () => {
  expect(
    parseFlmSourceUrl('https://huggingface.co/FastFlowLM/Nanbeige4.1-3B-NPU2'),
  ).toEqual({repoId: 'FastFlowLM/Nanbeige4.1-3B-NPU2', revision: 'main'});
  expect(
    parseFlmSourceUrl(
      'https://huggingface.co/FastFlowLM/Gemma3-1B-NPU2/resolve/v0.9.20-faster-q4-1',
    ),
  ).toEqual({
    repoId: 'FastFlowLM/Gemma3-1B-NPU2',
    revision: 'v0.9.20-faster-q4-1',
  });
  expect(
    parseFlmSourceUrl('https://huggingface.co/org/repo/tree/some-tag/?x=1'),
  ).toEqual({repoId: 'org/repo', revision: 'some-tag'});
  // Non-HF hosts (a ModelScope mirror) and junk yield nothing.
  expect(
    parseFlmSourceUrl('https://modelscope.cn/models/amd/Nanbeige4.1-3B-NPU2'),
  ).toBeNull();
  expect(parseFlmSourceUrl('not a url')).toBeNull();
});

test('parseFlmRegistry maps flm tags to their HF sources', () => {
  const registry = parseFlmRegistry({
    model_path: 'models',
    models: {
      gemma3: {
        '1b': {
          name: 'Gemma3-1B-NPU2',
          url: 'https://huggingface.co/FastFlowLM/Gemma3-1B-NPU2/resolve/v0.9.20-faster-q4-1',
          files: ['config.json', 'model.q4nx', 'tokenizer.json'],
        },
        '4b': {
          name: 'Gemma3-4B-NPU2',
          url: 'https://huggingface.co/FastFlowLM/Gemma3-4B-NPU2',
          files: ['config.json', 'model.q4nx'],
        },
      },
      broken: {
        x: {url: 42}, // malformed: skipped
        y: {url: 'https://modelscope.cn/models/amd/thing'}, // non-HF: skipped
      },
    },
  });
  expect(registry.get('gemma3:1b')).toEqual({
    repoId: 'FastFlowLM/Gemma3-1B-NPU2',
    revision: 'v0.9.20-faster-q4-1',
    files: ['config.json', 'model.q4nx', 'tokenizer.json'],
  });
  expect(registry.get('gemma3:4b')?.revision).toBe('main');
  expect(registry.has('broken:x')).toBe(false);
  expect(registry.has('broken:y')).toBe(false);
});

test('parseFlmRegistry tolerates junk payloads', () => {
  expect(parseFlmRegistry(null).size).toBe(0);
  expect(parseFlmRegistry({models: 'nope'}).size).toBe(0);
});

test('flmRegistryFiles: the files the registry lists for a repo at a revision', () => {
  const registry = new Map([
    [
      'embed:300m',
      {repoId: 'FastFlowLM/E', revision: 'main', files: ['a', 'b']},
    ],
    // Two tags sharing one repo and revision: their lists are unioned.
    [
      'embed:alt',
      {repoId: 'FastFlowLM/E', revision: 'main', files: ['b', 'c']},
    ],
    ['embed:v2', {repoId: 'FastFlowLM/E', revision: 'v2', files: ['z']}],
    ['empty:1b', {repoId: 'FastFlowLM/Empty', revision: 'main', files: []}],
  ]);
  expect(flmRegistryFiles(registry, 'FastFlowLM/E', 'main')?.sort()).toEqual([
    'a',
    'b',
    'c',
  ]);
  expect(flmRegistryFiles(registry, 'FastFlowLM/E', 'v2')).toEqual(['z']);
  // A revision the registry doesn't pin, an unknown repo, an entry without a
  // file list: the registry doesn't define this copy.
  expect(flmRegistryFiles(registry, 'FastFlowLM/E', 'v3')).toBeNull();
  expect(flmRegistryFiles(registry, 'other/repo', 'main')).toBeNull();
  expect(flmRegistryFiles(registry, 'FastFlowLM/Empty', 'main')).toBeNull();
});
