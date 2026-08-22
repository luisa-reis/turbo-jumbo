import {test, expect} from 'bun:test';
import {
  lemonadeHeaders,
  lemonadeStatusMessage,
  parseFlmModels,
} from '@/lib/lemonade/flm';

const payload = {
  object: 'list',
  data: [
    {
      id: 'qwen3.6-moe-35b-a3b-FLM',
      recipe: 'flm',
      checkpoint: 'qwen3.6-moe:35b-a3b',
      checkpoints: {main: 'qwen3.6-moe:35b-a3b'},
      downloaded: false,
      size: 24.3,
      labels: ['reasoning', 'hot'],
      suggested: true,
    },
    {
      id: 'Qwen3.6-35B-A3B-GGUF',
      recipe: 'llamacpp',
      checkpoint: 'unsloth/Qwen3.6-35B-A3B-GGUF:x.gguf',
      downloaded: true,
      size: 23.3,
    },
    {
      id: 'gpt-oss-20b-FLM',
      recipe: 'flm',
      checkpoint: 'gpt-oss:20b',
      downloaded: true,
      size: 12.1,
      labels: 'not-an-array',
    },
    {id: 42, recipe: 'flm'}, // malformed: skipped
  ],
};

test('keeps only well-formed flm-recipe entries', () => {
  const models = parseFlmModels(payload);
  expect(models.map((m) => m.name)).toEqual([
    'qwen3.6-moe-35b-a3b-FLM',
    'gpt-oss-20b-FLM',
  ]);
  expect(models[0]).toEqual({
    name: 'qwen3.6-moe-35b-a3b-FLM',
    checkpoint: 'qwen3.6-moe:35b-a3b',
    sizeGb: 24.3,
    downloaded: false,
    labels: ['reasoning', 'hot'],
  });
  // Non-array labels degrade to none; downloaded stays truthful.
  expect(models[1].labels).toEqual([]);
  expect(models[1].downloaded).toBe(true);
});

test('tolerates junk payloads', () => {
  expect(parseFlmModels(null)).toEqual([]);
  expect(parseFlmModels('nope')).toEqual([]);
  expect(parseFlmModels({data: 'nope'})).toEqual([]);
});

test('lemonadeHeaders carries the API key as a Bearer token', () => {
  // A Lemonade server started with LEMONADE_API_KEY answers 401 to anything
  // without this header — listing and pulling alike.
  expect(lemonadeHeaders({lemonade_api_key: 'secret'})).toEqual({
    Authorization: 'Bearer secret',
  });
});

test('lemonadeHeaders sends nothing for a server without a key', () => {
  expect(lemonadeHeaders({})).toEqual({});
});

test('a 401 from the Lemonade server is explained as a missing API key', () => {
  // Surfaced in the browser as-is; "HTTP 401" alone sent one user hunting.
  expect(lemonadeStatusMessage(401)).toBe(
    'Lemonade server requires an API key — set lemonade_api_key for this peer in config.yaml',
  );
});

test('other Lemonade server failures keep the bare status', () => {
  expect(lemonadeStatusMessage(503)).toBe('Lemonade server: HTTP 503');
});
