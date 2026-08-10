import {test, expect} from 'bun:test';
import {quantGroups} from '@/lib/hf/quant-groups';

const file = (path: string, size = 1) => ({path, size});

// The motivating repo: unsloth/DeepSeek-V4-Flash-0731-GGUF keeps each
// quantization in its own directory, plus one weight at the root and one under
// dspark/. Shard counts are the real ones.
const NESTED_QUANTS: Array<[string, number]> = [
  ['UD-IQ1_S', 3],
  ['UD-IQ1_M', 3],
  ['UD-IQ2_XXS', 3],
  ['UD-IQ2_M', 3],
  ['UD-Q2_K_XL', 3],
  ['UD-IQ3_XXS', 4],
  ['UD-IQ3_S', 4],
  ['UD-Q3_K_M', 4],
  ['UD-Q3_K_XL', 4],
  ['UD-IQ4_NL', 4],
  ['UD-IQ4_XS', 4],
  ['UD-Q4_K_XL', 5],
  ['UD-Q8_K_XL', 5],
];

const deepseekFiles = [
  file('dspark-DeepSeek-V4-Flash-0731-Q8_0.gguf'),
  file('dspark/dspark-DeepSeek-V4-Flash-0731-BF16.gguf'),
  ...NESTED_QUANTS.flatMap(([quant, shards]) =>
    Array.from({length: shards}, (_, i) =>
      file(
        `${quant}/DeepSeek-V4-Flash-0731-${quant}-` +
          `${String(i + 1).padStart(5, '0')}-of-${String(shards).padStart(5, '0')}.gguf`,
      ),
    ),
  ),
];

test('collapses a nested-quant repo to one group per quantization', () => {
  expect(deepseekFiles).toHaveLength(51);
  const groups = quantGroups(deepseekFiles);
  expect(groups).toHaveLength(15);

  const iq3s = groups.find((g) => g.label === 'UD-IQ3_S')!;
  expect(iq3s.folder).toBe('UD-IQ3_S');
  expect(iq3s.fileCount).toBe(4);
  expect(iq3s.paths).toEqual([
    'UD-IQ3_S/DeepSeek-V4-Flash-0731-UD-IQ3_S-00001-of-00004.gguf',
    'UD-IQ3_S/DeepSeek-V4-Flash-0731-UD-IQ3_S-00002-of-00004.gguf',
    'UD-IQ3_S/DeepSeek-V4-Flash-0731-UD-IQ3_S-00003-of-00004.gguf',
    'UD-IQ3_S/DeepSeek-V4-Flash-0731-UD-IQ3_S-00004-of-00004.gguf',
  ]);
});

test('groups weights outside a quant folder too', () => {
  const groups = quantGroups(deepseekFiles);
  const q8 = groups.find((g) => g.label === 'Q8_0')!;
  expect(q8.folder).toBeNull();
  expect(q8.fileCount).toBe(1);

  const bf16 = groups.find((g) => g.label === 'BF16')!;
  expect(bf16.folder).toBe('dspark');
});

test('groups a flat GGUF repo by its filename quants', () => {
  const groups = quantGroups([
    file('big-Q4_K_M-00001-of-00002.gguf'),
    file('big-Q4_K_M-00002-of-00002.gguf'),
    file('big-Q8_0.gguf'),
  ]);
  expect(groups.map((g) => g.label).sort()).toEqual(['Q4_K_M', 'Q8_0']);
  expect(groups.every((g) => g.folder === null)).toBe(true);
});

test('keeps the same quant in different folders apart', () => {
  const groups = quantGroups([
    file('a/model-Q8_0.gguf'),
    file('b/model-Q8_0.gguf'),
  ]);
  expect(groups).toHaveLength(2);
  expect(groups.map((g) => g.folder).sort()).toEqual(['a', 'b']);
});

test('sums sizes and orders groups smallest first', () => {
  const groups = quantGroups([
    file('m-Q8_0.gguf', 900),
    file('m-Q4_K_M-00001-of-00002.gguf', 100),
    file('m-Q4_K_M-00002-of-00002.gguf', 200),
  ]);
  expect(groups.map((g) => [g.label, g.size])).toEqual([
    ['Q4_K_M', 300],
    ['Q8_0', 900],
  ]);
});

test('labels a weight carrying no quant token by its filename', () => {
  const groups = quantGroups([file('sub/model.gguf')]);
  expect(groups[0].label).toBe('model');
});

test('labels a ggml .bin by its model variant', () => {
  const groups = quantGroups([
    file('ggml-tiny.bin'),
    file('ggml-large-v3.bin'),
  ]);
  expect(groups.map((g) => g.label).sort()).toEqual(['large-v3', 'tiny']);
});

test('labels an mmproj projector as such, not as a quantization', () => {
  // ggml-org/gemma-3-4b-it-GGUF ships an F16 projector beside an F16 weight.
  // Labelling both "F16" would leave two indistinguishable rows.
  const groups = quantGroups([
    file('gemma-3-4b-it-Q4_K_M.gguf'),
    file('gemma-3-4b-it-f16.gguf'),
    file('mmproj-model-f16.gguf'),
  ]);
  expect(groups.map((g) => g.label).sort()).toEqual([
    'F16',
    'Q4_K_M',
    'mmproj (F16)',
  ]);
});

test('gives each group a distinct key', () => {
  const groups = quantGroups(deepseekFiles);
  expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length);
});

test('labels an MTP head as a companion, not as an F32 quantization', () => {
  // antirez/deepseek-v4-gguf: the head's name ends in a dtype, so the quant
  // parser read "F32" and listed 3.5 GiB as a peer of the 153 GiB weight it
  // belongs to. Nothing said the two went together.
  const groups = quantGroups([
    file('DeepSeek-V4-Flash-MTP-Q4K-Q8_0-F32.gguf', 3_807_602_400),
    file(
      'DeepSeek-V4-Flash-Q4KExperts-F16HC-F16Compressor-F16Indexer-Q8Attn-Q8Shared-Q8Out-chat-v2-imatrix.gguf',
      164_600_000_000,
    ),
  ]);
  expect(groups.map((g) => g.label)).toEqual([
    'mtp (F32)',
    'DeepSeek-V4-Flash-Q4KExperts-F16HC-F16Compressor-F16Indexer-Q8Attn-Q8Shared-Q8Out-chat-v2-imatrix',
  ]);
  expect(groups.map((g) => g.companion)).toEqual(['mtp', null]);
});

test('an ordinary weight is not a companion', () => {
  const [group] = quantGroups([file('Qwen3-8B-Q4_K_M.gguf')]);
  expect(group.label).toBe('Q4_K_M');
  expect(group.companion).toBeNull();
});
