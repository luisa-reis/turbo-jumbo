import {test, expect} from 'bun:test';
import {stripFrontmatter, stripHtml} from '@/lib/hf/repo-card';

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

test('an HTML banner becomes the words it was wrapping', () => {
  // unsloth's cards open with a div of links and images. Astryx's Markdown
  // won't render raw HTML — rightly, it is third-party content — so left
  // alone the panel opens on a screenful of tags and buries the prose.
  const card =
    '<div class="flex"><p><strong>See <a href="https://hf.co/c">our collection</a></strong>' +
    ' for all versions.</p><img src="logo.png" width="133"></div>\n\n# Qwen3';
  expect(stripHtml(card)).toBe(
    '**See [our collection](https://hf.co/c)** for all versions.\n\n# Qwen3',
  );
});

test('markdown of its own is untouched', () => {
  const card = '# Files\n\n| File | Size |\n|---|---|\n| a.gguf | 3 GiB |';
  expect(stripHtml(card)).toBe(card);
});

test('HTML inside a fenced code block is left exactly as written', () => {
  // It is the example, not the packaging.
  const card = 'Use:\n\n```html\n<div class="x">hi</div>\n```\n\nDone.';
  expect(stripHtml(card)).toBe(card);
});

test('entities come back as characters', () => {
  expect(stripHtml('<p>accuracy &amp; speed &lt;3</p>')).toBe(
    'accuracy & speed <3',
  );
});

test('a badge link leaves nothing behind', () => {
  // An image wrapped in a link: strip the image and the anchor has no label,
  // which as markdown is `[](url)` — literal brackets, not a link.
  expect(
    stripHtml('<a href="https://discord.gg/x"><img src="badge.png"></a>'),
  ).toBe('');
  // One with words survives as a real link.
  expect(stripHtml('<a href="https://hf.co">the Hub</a>')).toBe(
    '[the Hub](https://hf.co)',
  );
});
