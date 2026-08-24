import {test, expect, afterEach} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import nodePath from 'path';
import {startAgent, type RunningAgent} from '@/agent/server';
import {createHttpStorage} from '@/lib/storage/http-storage';
import type {JobEvent, JobHandle, Storage} from '@/lib/storage/storage';

const made: string[] = [];
const running: RunningAgent[] = [];
afterEach(async () => {
  for (const agent of running.splice(0)) agent.stop();
  for (const dir of made.splice(0)) {
    await fsp.rm(dir, {recursive: true, force: true});
  }
});

/** A real agent on a real socket, roots on temp directories — the traffic
 *  here is the first to cross an actual HTTP boundary. */
async function socketAgent(token?: string): Promise<{
  url: string;
  remote: Storage;
  models: string;
}> {
  const base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'tj-agent-srv-'));
  made.push(base);
  const models = nodePath.join(base, 'models');
  const cold = nodePath.join(base, 'cold');
  for (const dir of [models, cold]) await fsp.mkdir(dir);
  const agent = startAgent({
    port: 0,
    ...(token !== undefined ? {token} : {}),
    roots: {models, cold},
  });
  running.push(agent);
  const url = `http://127.0.0.1:${agent.port}/api/v1/storage`;
  return {
    url,
    remote: createHttpStorage({url, ...(token !== undefined ? {token} : {})}),
    models,
  };
}

async function drain(handle: JobHandle): Promise<JobEvent[]> {
  const out = [];
  for await (const e of handle.events()) out.push(e);
  return out;
}

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

test('the agent answers the protocol over a real socket', async () => {
  const {remote} = await socketAgent('secret');
  const ref = {root: 'models', path: 'org/repo/tjmodel.json'} as const;
  await remote.write(ref, bytes('{"repoId":"org/repo"}'));
  expect(text(await remote.read(ref))).toBe('{"repoId":"org/repo"}');
  expect((await remote.list('models')).map((e) => e.path)).toEqual([
    'org',
    'org/repo',
    'org/repo/tjmodel.json',
  ]);
  const usage = await remote.usage('models');
  expect(usage.total).toBeGreaterThan(0);
});

test('a missing or wrong token is refused, wholesale', async () => {
  const {url} = await socketAgent('secret');
  const naked = createHttpStorage({url});
  await expect(naked.list('models')).rejects.toThrow(/Unauthorized/);
  const wrong = createHttpStorage({url, token: 'nope'});
  await expect(wrong.list('models')).rejects.toThrow(/Unauthorized/);
  // Liveness needs no token; the protocol does.
  const res = await fetch(url.replace('/api/v1/storage', '/'));
  expect(res.status).toBe(200);
});

test('a hash streams its digest across the socket', async () => {
  const {remote, models} = await socketAgent('secret');
  const payload = Buffer.alloc(1024 * 1024, 3);
  await fsp.writeFile(nodePath.join(models, 'w.gguf'), payload);
  let seen = 0;
  const digest = await remote.hash(
    {root: 'models', path: 'w.gguf'},
    {onBytes: (n) => (seen += n)},
  );
  const {createHash} = await import('crypto');
  expect(digest).toBe(createHash('sha256').update(payload).digest('hex'));
  expect(seen).toBe(payload.length);
});

test('a send travels agent to agent over real sockets', async () => {
  // The design's end state in miniature: two thin agents, a control host
  // driving A, and the file streaming A→B without touching the driver.
  const a = await socketAgent('token-a');
  const b = await socketAgent('token-b');
  const payload = Buffer.alloc(9 * 1024 * 1024 + 77, 5); // two chunks
  await fsp.mkdir(nodePath.join(a.models, 'org/repo'), {recursive: true});
  await fsp.writeFile(nodePath.join(a.models, 'org/repo/w.gguf'), payload);

  const events = await drain(
    await a.remote.start({
      kind: 'send',
      from: {root: 'models', path: 'org/repo/w.gguf'},
      to: {
        agent: b.url,
        token: 'token-b',
        ref: {root: 'models', path: 'org/repo/w.gguf'},
      },
    }),
  );
  expect(events.at(-1)).toEqual({
    kind: 'done',
    result: {resumedFrom: 0, size: payload.length},
  });
  expect(
    await fsp.readFile(nodePath.join(b.models, 'org/repo/w.gguf')),
  ).toEqual(payload);
});

test('a socket send still resumes from a verified prefix', async () => {
  const a = await socketAgent();
  const b = await socketAgent();
  const payload = Buffer.from('0123456789abcdef'.repeat(64 * 1024)); // 1 MiB
  await fsp.writeFile(nodePath.join(a.models, 'w.gguf'), payload);
  await fsp.writeFile(
    nodePath.join(b.models, 'w.gguf'),
    payload.subarray(0, 300_000),
  );

  const events = await drain(
    await a.remote.start({
      kind: 'send',
      from: {root: 'models', path: 'w.gguf'},
      to: {agent: b.url, ref: {root: 'models', path: 'w.gguf'}},
    }),
  );
  expect(events.at(-1)).toEqual({
    kind: 'done',
    result: {resumedFrom: 300_000, size: payload.length},
  });
  expect(events.some((e) => e.kind === 'verify')).toBe(true);
  expect(await fsp.readFile(nodePath.join(b.models, 'w.gguf'))).toEqual(
    payload,
  );
});
