import {test, expect, afterEach} from 'bun:test';
import {createHash} from 'crypto';
import {promises as fsp} from 'fs';
import os from 'os';
import nodePath from 'path';
import {
  handleAgentRequest,
  type AgentContext,
} from '@/lib/storage/agent-handlers';
import {createHttpStorage} from '@/lib/storage/http-storage';
import {createLocalStorage} from '@/lib/storage/local-storage';
import {
  MAX_SMALL_FILE,
  type JobEvent,
  type JobHandle,
  type Storage,
} from '@/lib/storage/storage';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) {
    await fsp.rm(dir, {recursive: true, force: true});
  }
});

/**
 * A remote storage speaking the wire protocol to the agent handlers over an
 * in-process fetch, with a local storage on temp directories behind them —
 * the whole client-to-filesystem path minus the socket.
 */
async function tmpAgent(): Promise<{
  remote: Storage;
  local: Storage;
  fetchImpl: typeof fetch;
  models: string;
  cold: string;
}> {
  const base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'tj-agent-'));
  made.push(base);
  const models = nodePath.join(base, 'models');
  const cold = nodePath.join(base, 'cold');
  const lemonade = nodePath.join(base, 'lemonade');
  for (const dir of [models, cold, lemonade]) {
    await fsp.mkdir(dir, {recursive: true});
  }
  const local = createLocalStorage({models, cold, lemonade});
  const ctx: AgentContext = {storage: local, roots: {models, cold, lemonade}};
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const url = new URL(input instanceof Request ? input.url : String(input));
    const op = url.pathname.split('/').pop() ?? '';
    const req = input instanceof Request ? input : new Request(url, init);
    return handleAgentRequest(ctx, op, req);
  }) as typeof fetch;
  const remote = createHttpStorage({
    url: 'http://agent.test/api/v1/storage',
    fetchImpl,
  });
  return {remote, local, fetchImpl, models, cold};
}

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** A minimal safetensors file whose one tensor has the given dtype. */
function safetensors(dtype: string): Buffer {
  const header = Buffer.from(JSON.stringify({w: {dtype}}), 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([len, header]);
}

async function drain(handle: JobHandle): Promise<JobEvent[]> {
  const out = [];
  for await (const e of handle.events()) out.push(e);
  return out;
}

test('write and read round-trip through the wire', async () => {
  const {remote} = await tmpAgent();
  const ref = {root: 'models', path: 'org/repo/tjmodel.json'} as const;
  await remote.write(ref, bytes('{"repoId":"org/repo"}'));
  expect(text(await remote.read(ref))).toBe('{"repoId":"org/repo"}');
});

test('a remote list answers exactly what the local walk sees', async () => {
  const {remote, local, models} = await tmpAgent();
  await fsp.mkdir(nodePath.join(models, 'org/repo'), {recursive: true});
  await fsp.writeFile(nodePath.join(models, 'org/repo/a.gguf'), 'x');
  await fsp.writeFile(
    nodePath.join(models, 'org/repo/w.safetensors'),
    safetensors('BF16'),
  );
  await fsp.symlink(
    nodePath.join(models, 'org/repo/a.gguf'),
    nodePath.join(models, 'link.gguf'),
  );
  await fsp.symlink(
    nodePath.join(models, 'gone.gguf'),
    nodePath.join(models, 'dangling.gguf'),
  );

  expect(await remote.list('models', {dtype: true})).toEqual(
    await local.list('models', {dtype: true}),
  );
  expect(await remote.list('models', {under: 'org/repo'})).toEqual(
    await local.list('models', {under: 'org/repo'}),
  );
});

test('the far side refuses a path that leaves its root', async () => {
  // Confinement is the storage's own; the wire adds no way around it.
  const {remote} = await tmpAgent();
  await expect(
    remote.read({root: 'models', path: '../escape'}),
  ).rejects.toThrow(/climb out/);
  await expect(
    remote.read({root: 'models', path: '/etc/passwd'}),
  ).rejects.toThrow(/relative/);
});

test('the small-file cap holds at both ends of the wire', async () => {
  const {remote, models} = await tmpAgent();
  // Client side: refused before any bytes travel.
  await expect(
    remote.write(
      {root: 'models', path: 'big'},
      new Uint8Array(MAX_SMALL_FILE + 1),
    ),
  ).rejects.toThrow(/small files only/);
  // Server side: a large file is refused by the read verb itself.
  await fsp.writeFile(
    nodePath.join(models, 'big.gguf'),
    Buffer.alloc(MAX_SMALL_FILE + 1),
  );
  await expect(remote.read({root: 'models', path: 'big.gguf'})).rejects.toThrow(
    /small files only/,
  );
});

test('the agent refuses an over-cap write on its own account', async () => {
  // HttpStorage checks before sending, but the agent is the trust boundary:
  // a hand-rolled request past the cap dies there, mid-stream.
  const {fetchImpl} = await tmpAgent();
  const res = await fetchImpl('http://agent.test/api/v1/storage/write', {
    method: 'POST',
    headers: {'x-tj-root': 'models', 'x-tj-path': 'big'},
    body: new Uint8Array(MAX_SMALL_FILE + 1),
  });
  expect(res.status).toBe(413);
});

test('link outcomes and dry runs pass through unchanged', async () => {
  const {remote} = await tmpAgent();
  await remote.write({root: 'models', path: 'a.gguf'}, bytes('a'));
  const at = {root: 'lemonade', path: 'extra/m/a.gguf'} as const;
  expect(
    await remote.link([{target: {root: 'models', path: 'a.gguf'}, at}], {
      dryRun: true,
    }),
  ).toEqual(['created']);
  await expect(remote.read(at)).rejects.toThrow(); // dry: nothing was created
  expect(
    await remote.link([{target: {root: 'models', path: 'a.gguf'}, at}]),
  ).toEqual(['created']);
  expect(text(await remote.read(at))).toBe('a');
});

test('move, copy and a pruning remove work the far filesystem', async () => {
  const {remote, local} = await tmpAgent();
  await remote.write({root: 'models', path: 'org/repo/a.gguf'}, bytes('w'));
  await remote.copy(
    {root: 'models', path: 'org/repo/a.gguf'},
    {root: 'cold', path: 'org/repo/a.gguf'},
  );
  expect(text(await remote.read({root: 'cold', path: 'org/repo/a.gguf'}))).toBe(
    'w',
  );
  await remote.move(
    {root: 'models', path: 'org/repo/a.gguf'},
    {root: 'models', path: 'org/repo/b.gguf'},
  );
  await remote.remove([{root: 'models', path: 'org/repo/b.gguf'}], {
    pruneEmptyDirs: true,
  });
  expect(await local.list('models')).toEqual([]);
});

test('usage crosses the wire with its device identity intact', async () => {
  const {remote} = await tmpAgent();
  const usage = await remote.usage('models');
  expect(usage.total).toBeGreaterThan(0);
  expect(usage.free).toBeGreaterThan(0);
  expect(usage.device).not.toBe('');
  // Same temp filesystem — the equality downloadDiskUsage depends on.
  expect((await remote.usage('cold')).device).toBe(usage.device);
});

test('a remote hash streams progress and lands on the right digest', async () => {
  const {remote, models} = await tmpAgent();
  const payload = Buffer.alloc(3 * 1024 * 1024, 7);
  await fsp.writeFile(nodePath.join(models, 'w.gguf'), payload);
  let seen = 0;
  const digest = await remote.hash(
    {root: 'models', path: 'w.gguf'},
    {onBytes: (n) => (seen += n)},
  );
  expect(digest).toBe(createHash('sha256').update(payload).digest('hex'));
  // The wire throttles frames but always closes the count.
  expect(seen).toBe(payload.length);
});

test('a remote hash of a missing file rejects with the failure', async () => {
  const {remote} = await tmpAgent();
  await expect(
    remote.hash({root: 'models', path: 'nope.gguf'}),
  ).rejects.toThrow();
});

test('an aborted remote hash rejects', async () => {
  const {remote, models} = await tmpAgent();
  await fsp.writeFile(nodePath.join(models, 'w.gguf'), Buffer.alloc(1024));
  const ctl = new AbortController();
  ctl.abort();
  await expect(
    remote.hash({root: 'models', path: 'w.gguf'}, {signal: ctl.signal}),
  ).rejects.toThrow();
});

test('a copy job runs remotely, streaming progress to done', async () => {
  const {remote, models, cold} = await tmpAgent();
  const payload = Buffer.alloc(2 * 1024 * 1024 + 123, 9);
  await fsp.writeFile(nodePath.join(models, 'w.gguf'), payload);
  const events = await drain(
    await remote.start({
      kind: 'copy',
      from: {root: 'models', path: 'w.gguf'},
      to: {root: 'cold', path: 'org/repo/w.gguf'},
    }),
  );
  expect(events.at(-1)).toEqual({
    kind: 'done',
    result: {resumedFrom: 0, size: payload.length},
  });
  const progress = events.filter((e) => e.kind === 'progress');
  expect(progress.at(-1)).toEqual({
    kind: 'progress',
    done: payload.length,
    total: payload.length,
  });
  expect(await fsp.readFile(nodePath.join(cold, 'org/repo/w.gguf'))).toEqual(
    payload,
  );
});

test('a remote copy job still resumes a partial destination', async () => {
  const {remote, models, cold} = await tmpAgent();
  const payload = Buffer.from('0123456789abcdef'.repeat(4096));
  await fsp.writeFile(nodePath.join(models, 'w.gguf'), payload);
  await fsp.mkdir(nodePath.join(cold, 'x'), {recursive: true});
  await fsp.writeFile(
    nodePath.join(cold, 'x/w.gguf'),
    payload.subarray(0, 10000),
  );
  const events = await drain(
    await remote.start({
      kind: 'copy',
      from: {root: 'models', path: 'w.gguf'},
      to: {root: 'cold', path: 'x/w.gguf'},
    }),
  );
  expect(events.at(-1)).toEqual({
    kind: 'done',
    result: {resumedFrom: 10000, size: payload.length},
  });
  expect(await fsp.readFile(nodePath.join(cold, 'x/w.gguf'))).toEqual(payload);
});

test('a remote job that cannot run ends in an error event, not a hang', async () => {
  const {remote} = await tmpAgent();
  const missing = await drain(
    await remote.start({
      kind: 'copy',
      from: {root: 'models', path: 'nope.gguf'},
      to: {root: 'cold', path: 'nope.gguf'},
    }),
  );
  expect(missing.at(-1)?.kind).toBe('error');
  // The download job's own argument validation crosses the wire too.
  const invalid = await drain(
    await remote.start({
      kind: 'download',
      repoId: '../etc',
      files: ['x'],
      into: {root: 'models', path: 'org/repo'},
    }),
  );
  expect(invalid.map((e) => e.kind)).toEqual(['error']);
});

test('the dispatcher answers unknown ops and bad bodies with statuses', async () => {
  const {fetchImpl} = await tmpAgent();
  const unknown = await fetchImpl('http://agent.test/api/v1/storage/nope', {
    method: 'POST',
    body: '{}',
  });
  expect(unknown.status).toBe(404);
  const badJson = await fetchImpl('http://agent.test/api/v1/storage/list', {
    method: 'POST',
    body: 'not json',
  });
  expect(badJson.status).toBe(400);
  const badRoot = await fetchImpl('http://agent.test/api/v1/storage/list', {
    method: 'POST',
    body: '{"root":"attic"}',
  });
  expect(badRoot.status).toBe(400);
});
