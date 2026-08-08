import {test, expect} from 'bun:test';
import {buildInventory, type PeerInventory} from '@/lib/cli/inventory';
import type {ModelRow, QuantInfo} from '@/lib/models/model-row';
import type {Model} from '@/lib/models/model-types';

const quant = (over: Partial<QuantInfo>): QuantInfo =>
  ({
    label: 'Q4_K_M',
    size: 100,
    localSize: 0,
    inColdStorage: false,
    coldComplete: false,
    paths: [],
    coldPaths: [],
    ...over,
  }) as unknown as QuantInfo;

const row = (name: string, quants: QuantInfo[]): ModelRow =>
  ({name, quants}) as unknown as ModelRow;

const peer = (slug: string, paths: string[]): PeerInventory => ({
  slug,
  models: [
    {
      name: 'org/repo',
      files: paths.map((path) => ({isSplit: false, path, size: 1})),
    },
  ] as unknown as Model[],
});

test('reports local and cold from the quant itself', () => {
  const inv = buildInventory([
    row('org/repo', [
      quant({
        label: 'Q8_0',
        size: 900,
        localSize: 5,
        paths: ['org/repo/a-Q8_0.gguf'],
      }),
      quant({
        label: 'Q4_K_M',
        size: 100,
        inColdStorage: true,
        coldComplete: true,
      }),
    ]),
  ]);
  expect(inv.map((r) => [r.quant, r.locations])).toEqual([
    ['Q8_0', ['local']],
    ['Q4_K_M', ['cold']],
  ]);
});

test('a peer holding the file appears as a location', () => {
  const inv = buildInventory(
    [row('org/repo', [quant({paths: ['org/repo/a-Q4_K_M.gguf']})])],
    [peer('rio', ['whatever/a-Q4_K_M.gguf'])],
  );
  expect(inv[0].locations).toEqual(['rio']);
});

test('a peer holding any shard of a set counts as holding it', () => {
  // Matches the models table: a peer part-way through a transfer is holding
  // the quantization, not missing it.
  const inv = buildInventory(
    [
      row('org/repo', [
        quant({
          paths: [
            'org/repo/x-00001-of-00002.gguf',
            'org/repo/x-00002-of-00002.gguf',
          ],
        }),
      ]),
    ],
    [peer('rio', ['x-00001-of-00002.gguf'])],
  );
  expect(inv[0].locations).toEqual(['rio']);
});

test('a cold-only quant can still be matched on a peer', () => {
  // It has no local paths at all, so the cold paths must feed the join.
  const inv = buildInventory(
    [
      row('org/repo', [
        quant({inColdStorage: true, coldPaths: ['org/repo/a-Q4_K_M.gguf']}),
      ]),
    ],
    [peer('rio', ['a-Q4_K_M.gguf'])],
  );
  expect(inv[0].locations).toEqual(['cold', 'rio']);
});

test('an unreachable peer is skipped, not reported absent', () => {
  const inv = buildInventory(
    [
      row('org/repo', [
        quant({localSize: 1, paths: ['org/repo/a-Q4_K_M.gguf']}),
      ]),
    ],
    [{slug: 'rio', models: null}],
  );
  expect(inv[0].locations).toEqual(['local']);
});

test('an undersized cold copy is flagged', () => {
  const inv = buildInventory([
    row('org/repo', [quant({inColdStorage: true, coldComplete: false})]),
  ]);
  expect(inv[0].coldIncomplete).toBe(true);
});

test('the pattern matches the model name, case-insensitively', () => {
  const rows = [
    row('Qwen/Qwen3-0.6B-GGUF', [quant({})]),
    row('unsloth/DeepSeek-V4', [quant({})]),
  ];
  expect(buildInventory(rows, [], {pattern: 'qwen'})).toHaveLength(1);
  expect(buildInventory(rows, [], {pattern: 'deep'})[0].model).toBe(
    'unsloth/DeepSeek-V4',
  );
});

test('location filters narrow the listing', () => {
  const rows = [
    row('a/one', [quant({label: 'L', localSize: 5})]),
    row('b/two', [quant({label: 'C', inColdStorage: true})]),
  ];
  expect(buildInventory(rows, [], {local: true}).map((r) => r.quant)).toEqual([
    'L',
  ]);
  expect(buildInventory(rows, [], {cold: true}).map((r) => r.quant)).toEqual([
    'C',
  ]);
});

test('--peer narrows to what that peer holds', () => {
  const inv = buildInventory(
    [
      row('org/repo', [
        quant({label: 'HERE', paths: ['org/repo/a-Q4_K_M.gguf']}),
        quant({label: 'GONE', paths: ['org/repo/b-Q8_0.gguf']}),
      ]),
    ],
    [peer('rio', ['a-Q4_K_M.gguf'])],
    {peer: 'rio'},
  );
  expect(inv.map((r) => r.quant)).toEqual(['HERE']);
});

test('rows sort by model, then largest quant first', () => {
  const inv = buildInventory([
    row('b/second', [quant({label: 'X', size: 1})]),
    row('a/first', [
      quant({label: 'SMALL', size: 10}),
      quant({label: 'BIG', size: 900}),
    ]),
  ]);
  expect(inv.map((r) => `${r.model}/${r.quant}`)).toEqual([
    'a/first/BIG',
    'a/first/SMALL',
    'b/second/X',
  ]);
});
