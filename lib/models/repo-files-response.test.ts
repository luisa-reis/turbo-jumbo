import {expect, test} from 'bun:test';
import {repoFilesResponse} from '@/lib/models/repo-files-response';
import {dirSite} from '@/lib/storage/site';

const req = (repoId: string) =>
  new Request(`http://x/api?repoId=${encodeURIComponent(repoId)}`);

test('a machine without that store says which one', async () => {
  const res = await repoFilesResponse(
    req('org/repo'),
    undefined,
    'cold storage',
  );
  expect(res.status).toBe(400);
  expect(await res.text()).toBe('No cold storage');
});

test('rejects a repo id that is not org/repo', async () => {
  const res = await repoFilesResponse(
    req('not-a-repo-id'),
    dirSite('/nonexistent'),
    'cold storage',
  );
  expect(res.status).toBe(400);
  expect(await res.text()).toBe('Invalid repoId');
});
