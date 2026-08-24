import {expect, test} from 'bun:test';
import {
  resolveBaseSubdirs,
  selectModelPeers,
  withoutSecrets,
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
          agent_address: '192.0.2.5:3900',
          agent_token: 'secret-too',
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

test('withoutSecrets keeps the Lemonade API key off the Peer object', () => {
  // Peers are serialized into pages and API responses in several places;
  // rather than stripping the key at each exit, it never gets onto the object.
  const {peers, lemonadeKeys, agentTokens} = withoutSecrets([
    {
      ...validPeer,
      lemonade_url: 'http://192.0.2.10:13305/api/v1',
      lemonade_api_key: 'secret',
      agent_address: '192.0.2.5:3900',
      agent_token: 'secret-too',
    },
    {name: 'B', address: '192.0.2.2:3000'},
  ]);
  expect(peers.map((p) => 'lemonade_api_key' in p)).toEqual([false, false]);
  expect(lemonadeKeys.get(peers[0])).toBe('secret');
  expect(lemonadeKeys.get(peers[1])).toBeUndefined();
  // The agent token is a secret in the same way; the address is not.
  expect(peers.map((p) => 'agent_token' in p)).toEqual([false, false]);
  expect(agentTokens.get(peers[0])).toBe('secret-too');
  expect(peers[0].agent_address).toBe('192.0.2.5:3900');
});

test('accepts a local peer with neither base_path nor cold_storage_path', () => {
  // A viewer: it runs the UI against the peers it lists and holds nothing.
  expect(
    validateRawConfig({
      peers: [
        {name: 'viewer', address: '192.0.2.9:3000'},
        {name: 'box', address: '192.0.2.10:3000'},
      ],
    }),
  ).toBeNull();
});

const viewer: Peer = {name: 'viewer', address: '192.0.2.9:3000'};
const box: Peer = {name: 'box', address: '192.0.2.10:3000'};

test('selectModelPeers flags this machine and keeps config order', () => {
  const out = selectModelPeers([box, viewer], viewer, true);
  expect(out.map((p) => [p.name, p.isLocal])).toEqual([
    ['box', false],
    ['viewer', true],
  ]);
});

test('selectModelPeers drops this machine when it has no model storage', () => {
  expect(selectModelPeers([viewer, box], viewer, false)).toEqual([
    {...box, isLocal: false},
  ]);
});

test('selectModelPeers with no local peer lists everyone as remote', () => {
  expect(selectModelPeers([box], undefined, false)).toEqual([
    {...box, isLocal: false},
  ]);
});
