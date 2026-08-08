import {test, expect} from 'bun:test';
import {parseHfUrl} from '@/lib/hf/hf-url';

test('parses a bare org/repo', () => {
  expect(parseHfUrl('unsloth/GLM-4.7-GGUF')).toEqual({
    repoId: 'unsloth/GLM-4.7-GGUF',
    branch: 'main',
    folder: null,
    filename: null,
  });
});

test('parses a blob file URL with a folder', () => {
  expect(
    parseHfUrl('https://huggingface.co/org/repo/blob/main/sub/file.gguf'),
  ).toEqual({
    repoId: 'org/repo',
    branch: 'main',
    folder: 'sub',
    filename: 'file.gguf',
  });
});

test('parses a tree/branch URL', () => {
  expect(parseHfUrl('https://huggingface.co/org/repo/tree/main')).toEqual({
    repoId: 'org/repo',
    branch: 'main',
    folder: null,
    filename: null,
  });
});

test('parses a tree URL naming a folder', () => {
  expect(
    parseHfUrl(
      'https://huggingface.co/unsloth/DeepSeek-V4-Flash-0731-GGUF/tree/main/UD-IQ3_S',
    ),
  ).toEqual({
    repoId: 'unsloth/DeepSeek-V4-Flash-0731-GGUF',
    branch: 'main',
    folder: 'UD-IQ3_S',
    filename: null,
  });
});

test('a tree URL keeps a nested folder path whole', () => {
  expect(
    parseHfUrl('https://huggingface.co/org/repo/tree/main/split_files/vae'),
  ).toEqual({
    repoId: 'org/repo',
    branch: 'main',
    folder: 'split_files/vae',
    filename: null,
  });
});

test("a blob URL's folder is the whole directory path, not its first segment", () => {
  expect(
    parseHfUrl(
      'https://huggingface.co/org/repo/blob/main/split_files/vae/x.safetensors',
    ),
  ).toEqual({
    repoId: 'org/repo',
    branch: 'main',
    folder: 'split_files/vae',
    filename: 'x.safetensors',
  });
});

test('parses a repo URL with a trailing slash', () => {
  expect(
    parseHfUrl('https://huggingface.co/unsloth/DeepSeek-V4-Flash-0731-GGUF/'),
  ).toEqual({
    repoId: 'unsloth/DeepSeek-V4-Flash-0731-GGUF',
    branch: 'main',
    folder: null,
    filename: null,
  });
});

test('parses a resolve URL at the repo root', () => {
  expect(
    parseHfUrl('https://huggingface.co/org/repo/resolve/main/file.gguf'),
  ).toEqual({
    repoId: 'org/repo',
    branch: 'main',
    folder: null,
    filename: 'file.gguf',
  });
});

test('returns null for a non-HF string', () => {
  expect(parseHfUrl('not a url')).toBeNull();
});
