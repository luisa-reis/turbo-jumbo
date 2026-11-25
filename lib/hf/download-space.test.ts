import {test, expect} from 'bun:test';
import {bytesNeeded} from '@/lib/hf/download-space';

const sizes = new Map([
  ['a.gguf', 100],
  ['b.gguf', 50],
  ['c.gguf', 30],
]);

test('a file already at its Hugging Face size needs nothing', () => {
  const onDisk = new Map<string, number | null>([['a.gguf', 100]]);
  expect(bytesNeeded(['a.gguf'], sizes, onDisk)).toBe(0);
});

test('a missing, stale or partial file counts in full', () => {
  const onDisk = new Map<string, number | null>([
    ['a.gguf', null], // missing
    ['b.gguf', 51], // stale: a different size
    ['c.gguf', 10], // partial
  ]);
  expect(bytesNeeded(['a.gguf', 'b.gguf', 'c.gguf'], sizes, onDisk)).toBe(180);
});

test('a file Hugging Face gave no size for is left out', () => {
  expect(bytesNeeded(['unknown.bin', 'b.gguf'], sizes, new Map())).toBe(50);
});
