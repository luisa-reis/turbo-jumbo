import {test, expect} from 'bun:test';
import {downloadTarget} from '@/lib/hf/download-target';
import type {Peer} from '@/lib/config';

const local: Peer = {
  name: 'box-a',
  address: '192.0.2.1:3000',
  base_path: '/mnt/a',
  isLocal: true,
};
const remote: Peer = {
  name: 'box-b',
  address: '192.0.2.2:3000',
  base_path: '/mnt/b',
};
const remoteNoBase: Peer = {name: 'box-c', address: '192.0.2.3:3000'};
const peers = [local, remote, remoteNoBase];

test('All tab targets the local download endpoint', () => {
  expect(downloadTarget('all', peers)).toEqual({
    url: '/api/v1/hf-download',
    diskUsageUrl: '/api/v1/disk-usage',
    coldStorageUrl: '/api/v1/cold-storage',
  });
});

test('local peer targets the local download endpoint', () => {
  // No cliUrl: `tj get` already downloads onto the server it points at.
  expect(downloadTarget('192.0.2.1:3000', peers)).toEqual({
    url: '/api/v1/hf-download',
    diskUsageUrl: '/api/v1/disk-usage',
    coldStorageUrl: '/api/v1/cold-storage',
  });
});

test('remote peer targets its proxy and names itself for the CLI', () => {
  expect(downloadTarget('192.0.2.2:3000', peers)).toEqual({
    url: '/api/v1/peers/box-b/hf-download',
    cliUrl: '192.0.2.2:3000',
    diskUsageUrl: '/api/v1/peers/box-b/disk-usage',
    coldStorageUrl: '/api/v1/peers/box-b/cold-storage',
  });
});

test('remote peer without base_path is still addressable', () => {
  expect(downloadTarget('192.0.2.3:3000', peers)).toEqual({
    url: '/api/v1/peers/box-c/hf-download',
    cliUrl: '192.0.2.3:3000',
    diskUsageUrl: '/api/v1/peers/box-c/disk-usage',
    coldStorageUrl: '/api/v1/peers/box-c/cold-storage',
  });
});

test('a peer with a Unicode name targets its proxy by slug', () => {
  const unicode: Peer = {
    name: 'Zürich',
    address: '192.0.2.4:3000',
    slug: 'zurich',
    base_path: '/mnt/g',
  };
  expect(downloadTarget('192.0.2.4:3000', [unicode])).toEqual({
    url: '/api/v1/peers/zurich/hf-download',
    cliUrl: '192.0.2.4:3000',
    diskUsageUrl: '/api/v1/peers/zurich/disk-usage',
    coldStorageUrl: '/api/v1/peers/zurich/cold-storage',
  });
});
