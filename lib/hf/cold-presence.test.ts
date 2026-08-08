import {test, expect} from 'bun:test';
import {coldStoredPaths} from '@/lib/hf/cold-presence';
import type {Model} from '@/lib/models/model-types';

// A cold-storage scan holding one sharded quant, at the sizes HF reports.
const coldModel = (name: string, files: Array<[string, number]>): Model =>
  ({
    name,
    files: files.map(([path, size]) => ({isSplit: false, path, size})),
  }) as unknown as Model;

const hf = (path: string, size: number) => ({path, size});

test('marks a file whose cold copy is complete', () => {
  const cold = [
    coldModel('unsloth/DeepSeek-V4-Flash-0731-GGUF', [
      [
        'unsloth/DeepSeek-V4-Flash-0731-GGUF/UD-IQ3_S/DeepSeek-V4-Flash-0731-UD-IQ3_S-00001-of-00004.gguf',
        100,
      ],
    ]),
  ];
  const present = coldStoredPaths(cold, 'unsloth/DeepSeek-V4-Flash-0731-GGUF', [
    hf('UD-IQ3_S/DeepSeek-V4-Flash-0731-UD-IQ3_S-00001-of-00004.gguf', 100),
    hf('UD-IQ3_S/DeepSeek-V4-Flash-0731-UD-IQ3_S-00002-of-00004.gguf', 200),
  ]);
  expect([...present]).toEqual([
    'UD-IQ3_S/DeepSeek-V4-Flash-0731-UD-IQ3_S-00001-of-00004.gguf',
  ]);
});

test('joins on basename, so a different on-disk layout still matches', () => {
  // The cold copy sits at a bare path; HF reports it under a quant folder.
  const cold = [coldModel('DeepSeek-V4-Flash-0731', [['big-Q4_K_M.gguf', 50]])];
  const present = coldStoredPaths(cold, 'org/repo', [
    hf('UD-Q4_K_XL/big-Q4_K_M.gguf', 50),
  ]);
  expect(present.has('UD-Q4_K_XL/big-Q4_K_M.gguf')).toBe(true);
});

test('an undersized cold copy is not counted as present', () => {
  // A transfer that stopped partway must stay re-fetchable, not read as done.
  const cold = [coldModel('org/repo', [['a-Q8_0.gguf', 40]])];
  expect(coldStoredPaths(cold, 'org/repo', [hf('a-Q8_0.gguf', 100)]).size).toBe(
    0,
  );
});

test('a larger cold copy still counts as present', () => {
  const cold = [coldModel('org/repo', [['a-Q8_0.gguf', 120]])];
  expect(coldStoredPaths(cold, 'org/repo', [hf('a-Q8_0.gguf', 100)]).size).toBe(
    1,
  );
});

test("another repo's mmproj does not count as this one's", () => {
  // mmproj basenames are generic, so they join qualified by model name.
  const cold = [coldModel('other/repo', [['mmproj-model-f16.gguf', 500]])];
  expect(
    coldStoredPaths(cold, 'org/repo', [hf('mmproj-model-f16.gguf', 500)]).size,
  ).toBe(0);
});

test("this repo's own mmproj does count", () => {
  const cold = [coldModel('org/repo', [['mmproj-model-f16.gguf', 500]])];
  expect(
    coldStoredPaths(cold, 'org/repo', [hf('mmproj-model-f16.gguf', 500)]).size,
  ).toBe(1);
});

test('empty cold storage marks nothing', () => {
  expect(coldStoredPaths([], 'org/repo', [hf('a-Q8_0.gguf', 1)]).size).toBe(0);
});
