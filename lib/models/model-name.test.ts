import {test, expect} from 'bun:test';
import {
  modelDisplayName,
  repoIdFromModelUrl,
  isMmprojFilename,
  companionKind,
} from '@/lib/models/model-name';

test('repoIdFromModelUrl extracts org/repo from a model URL', () => {
  expect(
    repoIdFromModelUrl(
      'https://huggingface.co/unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
    ),
  ).toBe('unsloth/Qwen3.6-35B-A3B-MTP-GGUF');
  // Trailing slash and whitespace are tolerated.
  expect(repoIdFromModelUrl('  https://huggingface.co/o/r/  ')).toBe('o/r');
});

test('repoIdFromModelUrl rejects non-model / non-HF URLs', () => {
  expect(repoIdFromModelUrl('https://huggingface.co/just-org')).toBeNull();
  expect(repoIdFromModelUrl('https://example.com/o/r')).toBeNull();
  expect(repoIdFromModelUrl('not a url')).toBeNull();
});

test('modelDisplayName shows the repo segment of an org/repo', () => {
  expect(modelDisplayName('unsloth/Qwen3.6-35B-A3B-MTP-GGUF')).toBe(
    'Qwen3.6-35B-A3B-MTP-GGUF',
  );
});

test('modelDisplayName leaves a filename-derived name unchanged', () => {
  expect(modelDisplayName('Qwen3.6-35B-A3B')).toBe('Qwen3.6-35B-A3B');
});

test('isMmprojFilename matches GGUF projector files', () => {
  expect(isMmprojFilename('mmproj-F16.gguf')).toBe(true);
  expect(isMmprojFilename('MMPROJ-BF16.GGUF')).toBe(true);
});

test('isMmprojFilename rejects non-projectors and non-gguf', () => {
  expect(isMmprojFilename('mmproj')).toBe(false);
  expect(isMmprojFilename('mmproj-readme.txt')).toBe(false);
  expect(isMmprojFilename('Qwen3-Q4_0.gguf')).toBe(false);
});

test('companionKind names the companions a weight is paired with', () => {
  // Not standalone models: each rides along with a quantization, so neither
  // the download list nor the models table should file them as one.
  expect(companionKind('mmproj-F16.gguf')).toBe('mmproj');
  expect(companionKind('DeepSeek-V4-Flash-MTP-Q4K-Q8_0-F32.gguf')).toBe('mtp');
  expect(companionKind('Qwen3-8B-draft-Q4_K_M.gguf')).toBe('draft');
});

test('companionKind ignores the token inside a word', () => {
  // "mtparser", "redraft" — a delimiter has to bound the token, or half the
  // Hub turns into companions.
  expect(companionKind('mtparser-Q4_K_M.gguf')).toBeNull();
  expect(companionKind('model-redraft-Q8_0.gguf')).toBeNull();
  expect(companionKind('Qwen3-8B-Q4_K_M.gguf')).toBeNull();
});

test('companionKind only speaks for weights it could pair with', () => {
  // The repo README mentioning MTP is not a file; only weight files qualify.
  expect(companionKind('README.md')).toBeNull();
  expect(companionKind('mtp-notes.txt')).toBeNull();
});
