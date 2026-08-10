import {test, expect} from 'bun:test';
import {stripFrontmatter} from '@/lib/hf/repo-card';

test('frontmatter goes, the prose stays', () => {
  // Licence and tags are for the Hub's indexing; they would push the part
  // that answers "which file do I want" off the first screen.
  const card = `---
license: mit
tags:
  - gguf
---

# DeepSeek V4 Flash — GGUF

MTP / speculative-decoding support (optional, not standalone).`;
  expect(stripFrontmatter(card)).toBe(
    '# DeepSeek V4 Flash — GGUF\n\nMTP / speculative-decoding support (optional, not standalone).',
  );
});

test('a card without frontmatter is left alone', () => {
  expect(stripFrontmatter('# Just a heading\n\nBody.')).toBe(
    '# Just a heading\n\nBody.',
  );
});

test('a horizontal rule in the body is not mistaken for frontmatter', () => {
  // The opening --- has to be the very first thing, or a card that separates
  // sections with rules loses its first section.
  const card = '# Heading\n\n---\n\nAfter the rule.';
  expect(stripFrontmatter(card)).toBe(card);
});

test('CRLF frontmatter is recognised too', () => {
  expect(stripFrontmatter('---\r\nlicense: mit\r\n---\r\n# Title')).toBe(
    '# Title',
  );
});
