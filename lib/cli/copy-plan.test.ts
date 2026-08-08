import {test, expect} from 'bun:test';
import {matchModels, planCopyFiles, selectQuants} from '@/lib/cli/copy-plan';
import {resolveSources} from '@/lib/copy/source-files';
import type {ModelRow, QuantInfo} from '@/lib/models/model-row';
import type {Model} from '@/lib/models/model-types';

const quant = (label: string, over: Partial<QuantInfo> = {}): QuantInfo =>
  ({label, paths: [], coldPaths: [], ...over}) as unknown as QuantInfo;

const row = (name: string, quants: QuantInfo[] = [quant('Q4_K_M')]): ModelRow =>
  ({name, quants}) as unknown as ModelRow;

const model = (files: Array<[string, number]>): Model =>
  ({
    name: 'org/repo',
    files: files.map(([path, size]) => ({isSplit: false, path, size})),
  }) as unknown as Model;

test('a substring matches one model', () => {
  const rows = [row('unsloth/DeepSeek-V4'), row('Qwen/Qwen3-0.6B')];
  expect(matchModels(rows, 'deepseek').map((r) => r.name)).toEqual([
    'unsloth/DeepSeek-V4',
  ]);
});

test('an ambiguous pattern returns every match, so the caller can refuse', () => {
  const rows = [row('unsloth/Qwen3-8B'), row('Qwen/Qwen3-0.6B')];
  expect(matchModels(rows, 'qwen3')).toHaveLength(2);
});

test('an exact name wins over models that merely contain it', () => {
  const rows = [row('org/model'), row('org/model-instruct')];
  expect(matchModels(rows, 'org/model').map((r) => r.name)).toEqual([
    'org/model',
  ]);
});

test('no --quant means every quantization', () => {
  const r = row('org/repo', [quant('Q4_K_M'), quant('Q8_0')]);
  expect(selectQuants(r, [])).toHaveLength(2);
});

test('--quant narrows, case-insensitively', () => {
  const r = row('org/repo', [quant('Q4_K_M'), quant('Q8_0')]);
  expect(selectQuants(r, ['q8_0']).map((q) => q.label)).toEqual(['Q8_0']);
});

test('files resolve through the source index', () => {
  const index = resolveSources({
    cold: [model([['org/repo/a-Q4_K_M.gguf', 10]])],
  });
  const files = planCopyFiles(
    'org/repo',
    [quant('Q4_K_M', {coldPaths: ['org/repo/a-Q4_K_M.gguf']})],
    index,
  );
  expect(files).toEqual([
    {path: 'org/repo/a-Q4_K_M.gguf', from: 'cold-storage', size: 10},
  ]);
});

test('a differing layout still matches, since the join is by basename', () => {
  // The same file sits at a bare path on the source and under <org>/<repo>/
  // in the listing the selection came from.
  const index = resolveSources({
    local: {
      address: '192.0.2.1:3000',
      models: [model([['a-Q4_K_M.gguf', 10]])],
    },
  });
  const files = planCopyFiles(
    'org/repo',
    [quant('Q4_K_M', {paths: ['org/repo/a-Q4_K_M.gguf']})],
    index,
  );
  expect(files.map((f) => f.path)).toEqual(['a-Q4_K_M.gguf']);
});

test('every shard of a selected quantization is included', () => {
  const index = resolveSources({
    cold: [
      model([
        ['x-00001-of-00002.gguf', 5],
        ['x-00002-of-00002.gguf', 7],
      ]),
    ],
  });
  const files = planCopyFiles(
    'org/repo',
    [
      quant('Q4_K_M', {
        coldPaths: ['x-00001-of-00002.gguf', 'x-00002-of-00002.gguf'],
      }),
    ],
    index,
  );
  expect(files).toHaveLength(2);
});

test('files of other quantizations are left out', () => {
  const index = resolveSources({
    cold: [
      model([
        ['a-Q4_K_M.gguf', 10],
        ['a-Q8_0.gguf', 20],
      ]),
    ],
  });
  const files = planCopyFiles(
    'org/repo',
    [quant('Q4_K_M', {coldPaths: ['a-Q4_K_M.gguf']})],
    index,
  );
  expect(files.map((f) => f.path)).toEqual(['a-Q4_K_M.gguf']);
});
