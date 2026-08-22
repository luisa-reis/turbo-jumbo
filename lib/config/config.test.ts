import {expect, test} from 'bun:test';
import {
  publicPeer,
  resolveBaseSubdirs,
  validateRawConfig,
  type Peer,
} from '@/lib/config';

const validPeer = {
  name: 'this-machine',
  address: '192.168.1.10:3000',
  base_path: '/mnt/models',
  cold_storage_path: '/mnt/cold-storage',
};

test('accepts a minimal valid config', () => {
  expect(validateRawConfig({peers: [validPeer]})).toBeNull();
});

test('accepts an optional log_level', () => {
  expect(
    validateRawConfig({log_level: 'debug', peers: [validPeer]}),
  ).toBeNull();
});

test('rejects a missing peers array', () => {
  expect(validateRawConfig({})).toContain('peers');
});

test('rejects an empty peers array', () => {
  expect(validateRawConfig({peers: []})).not.toBeNull();
});

test('rejects an unknown top-level property', () => {
  expect(validateRawConfig({peers: [validPeer], nope: 1})).toContain(
    'unknown property "nope"',
  );
});

test('rejects a peer missing its address', () => {
  expect(validateRawConfig({peers: [{name: 'x'}]})).toContain('address');
});

test('rejects an address without a port', () => {
  expect(
    validateRawConfig({peers: [{name: 'x', address: '192.0.2.1'}]}),
  ).not.toBeNull();
});

test('rejects an invalid log_level', () => {
  expect(
    validateRawConfig({log_level: 'loud', peers: [validPeer]}),
  ).not.toBeNull();
});

test('accepts all documented options', () => {
  expect(
    validateRawConfig({
      log_level: 'debug',
      peer_check_interval: 30,
      peers: [
        {
          name: 'A',
          address: '[2001:db8::1]:3000',
          base_path: '/mnt/models',
          cold_storage_path: '/mnt/cold-storage',
          turbo_jumbo_subdir: 'tj',
          lemonade_subdir: 'lmnd',
          lemonade_url: 'http://192.0.2.10:13305/api/v1',
          lemonade_api_key: 'secret',
        },
      ],
    }),
  ).toBeNull();
});

test('rejects an unknown peer key (e.g. the old local_path)', () => {
  const err = validateRawConfig({
    peers: [{name: 'A', address: '192.0.2.1:3000', local_path: '/mnt/models'}],
  });
  expect(err).toContain('local_path');
});

test('accepts a peer slug', () => {
  expect(
    validateRawConfig({
      peers: [{...validPeer, name: 'Zürich', slug: 'zurich'}],
    }),
  ).toBeNull();
});

test('rejects a slug that is not lowercase-hyphenated', () => {
  for (const slug of ['Zürich', 'Box', 'box_1', '-box', 'box-', 'a--b', '']) {
    expect(
      validateRawConfig({peers: [{...validPeer, slug}]}),
      `slug ${JSON.stringify(slug)} should be rejected`,
    ).not.toBeNull();
  }
});

test('rejects peers whose slugs collide', () => {
  const err = validateRawConfig({
    peers: [
      {...validPeer, name: 'Zürich', slug: 'zurich'},
      {name: 'zurich', address: '192.0.2.2:3000'},
    ],
  });
  expect(err).toContain('zurich');
});

test('rejects a peer whose name derives no slug', () => {
  expect(
    validateRawConfig({peers: [{...validPeer, name: '東京'}]}),
  ).not.toBeNull();
});

test('rejects a non-numeric peer_check_interval', () => {
  expect(
    validateRawConfig({
      peer_check_interval: 'soon',
      peers: [{name: 'A', address: '192.0.2.1:3000'}],
    }),
  ).not.toBeNull();
});

const peer = (overrides: Partial<Peer>): Peer => ({
  name: 'Test',
  address: '192.0.2.1:3000',
  base_path: '/mnt/models',
  cold_storage_path: '/mnt/cold-storage',
  ...overrides,
});

test('resolveBaseSubdirs derives turbo-jumbo and lemonade from the base path', () => {
  expect(resolveBaseSubdirs(peer({}))).toEqual({
    localModels: '/mnt/models/turbo-jumbo',
    lemonade: '/mnt/models/lemonade',
  });
});

test('resolveBaseSubdirs honors subdir name overrides', () => {
  expect(
    resolveBaseSubdirs(
      peer({turbo_jumbo_subdir: 'tj', lemonade_subdir: 'lmnd'}),
    ),
  ).toEqual({
    localModels: '/mnt/models/tj',
    lemonade: '/mnt/models/lmnd',
  });
});

test('accepts a lemonade_api_key alongside lemonade_url', () => {
  // A Lemonade server started with LEMONADE_API_KEY rejects every request
  // without the matching Bearer token, so the key lives next to the URL.
  expect(
    validateRawConfig({
      peers: [
        {
          ...validPeer,
          lemonade_url: 'http://192.0.2.10:13305/api/v1',
          lemonade_api_key: 'secret',
        },
      ],
    }),
  ).toBeNull();
});

test('publicPeer strips the Lemonade API key and keeps everything else', () => {
  // Peers are serialized into the page and served by /api/v1/peers; the key
  // must stay on the server.
  const p = peer({
    lemonade_url: 'http://192.0.2.10:13305/api/v1',
    lemonade_api_key: 'secret',
  });
  const pub = publicPeer(p);
  expect('lemonade_api_key' in pub).toBe(false);
  expect(pub).toEqual({
    name: p.name,
    address: p.address,
    base_path: p.base_path,
    cold_storage_path: p.cold_storage_path,
    lemonade_url: p.lemonade_url,
  });
});
