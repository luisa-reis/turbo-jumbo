import {test, expect} from 'bun:test';
import {
  matchEntries,
  planCatalogDownload,
  planFlmDownload,
  type LemonadeEntry,
} from '@/lib/cli/lemonade-get-plan';
import type {LemonadeModel} from '@/lib/lemonade/lemonade-types';
import type {FlmModel} from '@/lib/lemonade/flm';
import type {Model} from '@/lib/models/model-types';

const catalogModel = (
  name: string,
  repoId: string,
  variant: string | null = 'Q4_K_M',
): LemonadeModel => ({
  name,
  repoId,
  variant,
  mmproj: null,
  suggested: false,
  labels: [],
  sizeGb: 1,
});

const flmModel = (name: string, source?: FlmModel['source']): FlmModel => ({
  name,
  checkpoint: 'qwen3:4b',
  sizeGb: 4,
  downloaded: false,
  labels: [],
  ...(source ? {source} : {}),
});

const entries = (models: LemonadeModel[], flm: FlmModel[]): LemonadeEntry[] => [
  ...models.map((model) => ({kind: 'catalog' as const, model})),
  ...flm.map((model) => ({kind: 'flm' as const, model})),
];

// A storage location holding `filenames` of `repoId`.
const held = (repoId: string, filenames: string[]): Model[] => [
  {
    name: repoId,
    files: filenames.map((filename) => ({
      isSplit: false as const,
      filename,
      path: `${repoId}/${filename}`,
      quant: 'Q4_K_M',
      size: 10,
      missing: false,
    })),
  },
];

test('matchEntries finds a model by part of its name', () => {
  const all = entries(
    [catalogModel('Qwen3-8B-GGUF', 'unsloth/Qwen3-8B-GGUF')],
    [flmModel('Qwen3-4B-FLM')],
  );
  expect(matchEntries(all, 'qwen3-4b').map((e) => e.model.name)).toEqual([
    'Qwen3-4B-FLM',
  ]);
});

test('matchEntries searches the catalog and the FLM models together', () => {
  const all = entries(
    [catalogModel('Qwen3-8B-GGUF', 'unsloth/Qwen3-8B-GGUF')],
    [flmModel('Qwen3-4B-FLM')],
  );
  expect(matchEntries(all, 'qwen').map((e) => e.model.name)).toEqual([
    'Qwen3-8B-GGUF',
    'Qwen3-4B-FLM',
  ]);
});

test('matchEntries prefers an exact name to the longer ones containing it', () => {
  const all = entries(
    [
      catalogModel('Qwen3-4B', 'unsloth/Qwen3-4B-GGUF'),
      catalogModel('Qwen3-4B-Instruct', 'unsloth/Qwen3-4B-Instruct-GGUF'),
    ],
    [],
  );
  expect(matchEntries(all, 'Qwen3-4B').map((e) => e.model.name)).toEqual([
    'Qwen3-4B',
  ]);
});

test('matchEntries returns nothing when the name matches none', () => {
  expect(matchEntries(entries([], []), 'nope')).toEqual([]);
});

test('planCatalogDownload takes the variant files the target lacks', () => {
  const model = catalogModel('M', 'org/repo', 'Q4_K_M');
  const repoFiles = [
    {path: 'model-Q4_K_M.gguf', size: 10},
    {path: 'model-Q8_0.gguf', size: 20},
  ];
  const result = planCatalogDownload(model, repoFiles, []);
  expect(result).toEqual({
    ok: true,
    plan: {
      repoId: 'org/repo',
      branch: 'main',
      filePaths: ['model-Q4_K_M.gguf'],
    },
  });
});

test('planCatalogDownload re-checks the whole variant when nothing is missing', () => {
  const model = catalogModel('M', 'org/repo', 'Q4_K_M');
  const repoFiles = [{path: 'model-Q4_K_M.gguf', size: 10}];
  const result = planCatalogDownload(
    model,
    repoFiles,
    held('org/repo', ['model-Q4_K_M.gguf']),
  );
  expect(result).toEqual({
    ok: true,
    plan: {
      repoId: 'org/repo',
      branch: 'main',
      filePaths: ['model-Q4_K_M.gguf'],
    },
  });
});

test('planCatalogDownload reports a variant the repo does not offer', () => {
  const model = catalogModel('M', 'org/repo', 'Q2_K');
  const result = planCatalogDownload(
    model,
    [{path: 'model-Q4_K_M.gguf', size: 10}],
    [],
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain('Q2_K');
});

test('planFlmDownload fetches what is missing and records the whole set', () => {
  const source = {
    repoId: 'FastFlowLM/Qwen3-4B',
    revision: 'v1.2',
    files: ['config.json', 'model.q4nx'],
  };
  const repoFiles = [
    {path: 'config.json', size: 1},
    {path: 'model.q4nx', size: 40},
    {path: 'kernels/other.bin', size: 5},
  ];
  const result = planFlmDownload(
    source,
    repoFiles,
    held('FastFlowLM/Qwen3-4B', ['config.json']),
  );
  expect(result).toEqual({
    ok: true,
    plan: {
      repoId: 'FastFlowLM/Qwen3-4B',
      branch: 'v1.2',
      filePaths: ['model.q4nx'],
      // The registry's list, not just what's fetched: the repo's other files
      // aren't part of the model.
      fileScope: ['config.json', 'model.q4nx'],
    },
  });
});

test('planFlmDownload takes the whole set when the target has none of it', () => {
  const source = {
    repoId: 'FastFlowLM/Qwen3-4B',
    revision: 'main',
    files: ['config.json', 'model.q4nx'],
  };
  const repoFiles = [
    {path: 'config.json', size: 1},
    {path: 'model.q4nx', size: 40},
  ];
  const result = planFlmDownload(source, repoFiles, []);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.plan.filePaths).toEqual(['config.json', 'model.q4nx']);
    expect(result.plan.fileScope).toEqual(['config.json', 'model.q4nx']);
  }
});

test('planFlmDownload refuses when the registry and the repo have drifted', () => {
  // A named file the repo no longer has would otherwise download a partial
  // model that reads as complete.
  const source = {
    repoId: 'FastFlowLM/Qwen3-4B',
    revision: 'v1.2',
    files: ['config.json', 'model.q4nx'],
  };
  const result = planFlmDownload(source, [{path: 'config.json', size: 1}], []);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain('model.q4nx');
    expect(result.error).toContain('v1.2');
  }
});

test('planFlmDownload falls back to the whole repo when the registry names no files', () => {
  const source = {repoId: 'FastFlowLM/Qwen3-4B', revision: 'main', files: []};
  const repoFiles = [
    {path: 'config.json', size: 1},
    {path: 'model.q4nx', size: 40},
  ];
  const result = planFlmDownload(source, repoFiles, []);
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(result.plan.fileScope).toEqual(['config.json', 'model.q4nx']);
});
