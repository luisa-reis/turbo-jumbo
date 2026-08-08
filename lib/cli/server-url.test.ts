import {test, expect} from 'bun:test';
import {resolveServerUrl} from '@/lib/cli/server-url';

test('falls back to localhost when nothing is configured', () => {
  expect(resolveServerUrl({})).toBe('http://localhost:3000');
});

test('the flag beats every other source', () => {
  expect(
    resolveServerUrl({
      flag: 'http://192.0.2.9:3000',
      env: 'http://192.0.2.8:3000',
      localPeerAddress: '192.0.2.7:3000',
    }),
  ).toBe('http://192.0.2.9:3000');
});

test('the environment beats the config', () => {
  expect(
    resolveServerUrl({
      env: 'http://192.0.2.8:3000',
      localPeerAddress: '192.0.2.7:3000',
    }),
  ).toBe('http://192.0.2.8:3000');
});

test("the local peer's own address is used when it is all there is", () => {
  // config.yaml records a bare host:port, which needs a scheme to be fetched.
  expect(resolveServerUrl({localPeerAddress: '192.0.2.7:3000'})).toBe(
    'http://192.0.2.7:3000',
  );
});

test('an https URL keeps its scheme', () => {
  expect(resolveServerUrl({flag: 'https://tj.example:8443'})).toBe(
    'https://tj.example:8443',
  );
});

test('a trailing slash is dropped so paths concatenate cleanly', () => {
  expect(resolveServerUrl({flag: 'http://192.0.2.7:3000/'})).toBe(
    'http://192.0.2.7:3000',
  );
});

test('an empty or whitespace source is skipped, not treated as set', () => {
  // An exported-but-empty TJ_URL must not shadow the config.
  expect(
    resolveServerUrl({env: '  ', localPeerAddress: '192.0.2.7:3000'}),
  ).toBe('http://192.0.2.7:3000');
});
