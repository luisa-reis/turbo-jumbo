import {test, expect, afterEach} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import nodePath from 'path';
import {
  handleAgentRequest,
  type AgentContext,
} from '@/lib/storage/agent-handlers';
import {createHttpStorage} from '@/lib/storage/http-storage';
import {createLocalStorage} from '@/lib/storage/local-storage';
import type {JobEvent, JobHandle, Storage} from '@/lib/storage/storage';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) {
    await fsp.rm(dir, {recursive: true, force: true});
  }
});

/** One in-process agent: local storage on temp roots, reachable at `host`
 *  through the shared fetch below. */
async function agent(host: string): Promise<{
  storage: Storage;
  ctx: AgentContext;
  models: string;
  url: string;
}> {
  const base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'tj-send-'));
  made.push(base);
  const models = nodePath.join(base, 'models');
  const cold = nodePath.join(base, 'cold');
  const lemonade = nodePath.join(base, 'lemonade');
  for (const dir of [models, cold, lemonade]) {
    await fsp.mkdir(dir, {recursive: true});
  }
  const roots = {models, cold, lemonade};
  // The A side needs agentFetch to reach B in-process; wired after both
  // agents exist, via the mutable registry the fetch closes over.
  const storage = createLocalStorage(roots, {agentFetch: fleetFetch});
  const ctx: AgentContext = {storage, roots};
  const url = `http://${host}/api/v1/storage`;
  fleet.set(host, ctx);
  return {storage, ctx, models, url};
}

/** Requests routed by host to whichever in-process agent owns it — the whole
 *  A-verifies-against-B-then-streams path minus the sockets. */
const fleet = new Map<string, AgentContext>();
const receives: Array<{host: string; offset: number}> = [];
const fleetFetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const url = new URL(input instanceof Request ? input.url : String(input));
  const ctx = fleet.get(url.host);
  if (!ctx) return new Response('no such agent', {status: 502});
  const op = url.pathname.split('/').pop() ?? '';
  if (op === 'receive') {
    receives.push({
      host: url.host,
      offset: parseInt(
        (init?.headers as Record<string, string>)?.['x-tj-offset'] ?? '0',
        10,
      ),
    });
  }
  const req = input instanceof Request ? input : new Request(url, init);
  return handleAgentRequest(ctx, op, req);
}) as typeof fetch;

afterEach(() => {
  fleet.clear();
  receives.length = 0;
});

async function drain(handle: JobHandle): Promise<JobEvent[]> {
  const out = [];
  for await (const e of handle.events()) out.push(e);
  return out;
}

test('a send job lands a file on another agent, byte for byte', async () => {
  const a = await agent('agent-a.test');
  const b = await agent('agent-b.test');
  const payload = Buffer.alloc(9 * 1024 * 1024 + 321, 5); // two chunks
  await fsp.mkdir(nodePath.join(a.models, 'org/repo'), {recursive: true});
  await fsp.writeFile(nodePath.join(a.models, 'org/repo/w.gguf'), payload);

  const events = await drain(
    await a.storage.start({
      kind: 'send',
      from: {root: 'models', path: 'org/repo/w.gguf'},
      to: {agent: b.url, ref: {root: 'models', path: 'org/repo/w.gguf'}},
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
  expect(
    await fsp.readFile(nodePath.join(b.models, 'org/repo/w.gguf')),
  ).toEqual(payload);
  // Two 8 MiB chunks: offsets 0 and 8 MiB.
  expect(receives.map((r) => r.offset)).toEqual([0, 8 * 1024 * 1024]);
});

test('a send resumes past a prefix the far side can prove', async () => {
  const a = await agent('agent-a.test');
  const b = await agent('agent-b.test');
  const payload = Buffer.from('0123456789abcdef'.repeat(64 * 1024)); // 1 MiB
  await fsp.mkdir(nodePath.join(a.models, 'org/repo'), {recursive: true});
  await fsp.writeFile(nodePath.join(a.models, 'org/repo/w.gguf'), payload);
  await fsp.mkdir(nodePath.join(b.models, 'org/repo'), {recursive: true});
  await fsp.writeFile(
    nodePath.join(b.models, 'org/repo/w.gguf'),
    payload.subarray(0, 300_000),
  );

  const events = await drain(
    await a.storage.start({
      kind: 'send',
      from: {root: 'models', path: 'org/repo/w.gguf'},
      to: {agent: b.url, ref: {root: 'models', path: 'org/repo/w.gguf'}},
    }),
  );
  expect(events.at(-1)).toEqual({
    kind: 'done',
    result: {resumedFrom: 300_000, size: payload.length},
  });
  // The prefix was actually hash-verified, and reported as such.
  const verify = events.filter((e) => e.kind === 'verify');
  expect(verify.length).toBeGreaterThan(0);
  expect(verify.at(-1)).toEqual({
    kind: 'verify',
    done: 300_000,
    total: 300_000,
  });
  // Only the tail travelled.
  expect(receives.map((r) => r.offset)).toEqual([300_000]);
  expect(
    await fsp.readFile(nodePath.join(b.models, 'org/repo/w.gguf')),
  ).toEqual(payload);
});

test('a mismatched partial is started over, not spliced onto', async () => {
  const a = await agent('agent-a.test');
  const b = await agent('agent-b.test');
  const payload = Buffer.alloc(200_000, 7);
  await fsp.writeFile(nodePath.join(a.models, 'w.gguf'), payload);
  const wrong = Buffer.alloc(100_000, 8);
  await fsp.writeFile(nodePath.join(b.models, 'w.gguf'), wrong);

  const events = await drain(
    await a.storage.start({
      kind: 'send',
      from: {root: 'models', path: 'w.gguf'},
      to: {agent: b.url, ref: {root: 'models', path: 'w.gguf'}},
    }),
  );
  expect(events.at(-1)).toEqual({
    kind: 'done',
    result: {resumedFrom: 0, size: payload.length},
  });
  expect(await fsp.readFile(nodePath.join(b.models, 'w.gguf'))).toEqual(
    payload,
  );
});

test('a destination already whole sends nothing at all', async () => {
  const a = await agent('agent-a.test');
  const b = await agent('agent-b.test');
  const payload = Buffer.alloc(150_000, 3);
  await fsp.writeFile(nodePath.join(a.models, 'w.gguf'), payload);
  await fsp.writeFile(nodePath.join(b.models, 'w.gguf'), payload);

  const events = await drain(
    await a.storage.start({
      kind: 'send',
      from: {root: 'models', path: 'w.gguf'},
      to: {agent: b.url, ref: {root: 'models', path: 'w.gguf'}},
    }),
  );
  expect(events.at(-1)).toEqual({
    kind: 'done',
    result: {resumedFrom: payload.length, size: payload.length},
  });
  expect(receives).toEqual([]);
});

test('an empty file still comes to exist at the far end', async () => {
  const a = await agent('agent-a.test');
  const b = await agent('agent-b.test');
  await fsp.writeFile(nodePath.join(a.models, 'empty.gguf'), '');

  const events = await drain(
    await a.storage.start({
      kind: 'send',
      from: {root: 'models', path: 'empty.gguf'},
      to: {agent: b.url, ref: {root: 'models', path: 'empty.gguf'}},
    }),
  );
  expect(events.at(-1)).toEqual({
    kind: 'done',
    result: {resumedFrom: 0, size: 0},
  });
  expect((await fsp.stat(nodePath.join(b.models, 'empty.gguf'))).size).toBe(0);
});

test('a send job of a missing source ends in error', async () => {
  const a = await agent('agent-a.test');
  const b = await agent('agent-b.test');
  const events = await drain(
    await a.storage.start({
      kind: 'send',
      from: {root: 'models', path: 'nope.gguf'},
      to: {agent: b.url, ref: {root: 'models', path: 'nope.gguf'}},
    }),
  );
  expect(events.at(-1)?.kind).toBe('error');
});

test('the control host can drive a send between two other agents', async () => {
  // The design's whole point: the host that asks holds none of the bytes.
  const a = await agent('agent-a.test');
  const b = await agent('agent-b.test');
  const payload = Buffer.alloc(123_456, 9);
  await fsp.writeFile(nodePath.join(a.models, 'w.gguf'), payload);

  // The control host's view of A is an HttpStorage; the send spec it posts
  // names B as the destination agent.
  const aFromAfar = createHttpStorage({url: a.url, fetchImpl: fleetFetch});
  const events = await drain(
    await aFromAfar.start({
      kind: 'send',
      from: {root: 'models', path: 'w.gguf'},
      to: {agent: b.url, ref: {root: 'models', path: 'w.gguf'}},
    }),
  );
  expect(events.at(-1)).toEqual({
    kind: 'done',
    result: {resumedFrom: 0, size: payload.length},
  });
  expect(await fsp.readFile(nodePath.join(b.models, 'w.gguf'))).toEqual(
    payload,
  );
});

test('the receiving end refuses an offset that is not where the file ends', async () => {
  const b = await agent('agent-b.test');
  await fsp.writeFile(nodePath.join(b.models, 'w.gguf'), Buffer.alloc(100));
  const res = await fleetFetch(`${b.url}/receive`, {
    method: 'POST',
    headers: {
      'x-tj-root': 'models',
      'x-tj-path': encodeURIComponent('w.gguf'),
      'x-tj-offset': '55',
    },
    body: new Uint8Array(10),
  });
  expect(res.status).toBe(409);
  expect(await res.text()).toContain('does not match the 100');
});
