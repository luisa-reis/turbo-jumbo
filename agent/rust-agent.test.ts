/**
 * Conformance: the Rust agent binary must answer exactly as the TS storage
 * does. These tests spawn the compiled binary (cargo build in agent/) on
 * real sockets and hold its wire behavior against `createLocalStorage`'s
 * answers on the same directories. Skipped wholesale when the binary has
 * not been built.
 */

import {test, expect, afterEach} from 'bun:test';
import {existsSync, promises as fsp} from 'fs';
import os from 'os';
import nodePath from 'path';
import {createHttpStorage} from '@/lib/storage/http-storage';
import {createLocalStorage} from '@/lib/storage/local-storage';
import {
  MAX_SMALL_FILE,
  type FileEntry,
  type Storage,
} from '@/lib/storage/storage';

const BIN = nodePath.join(import.meta.dir, 'target/debug/tj-agent');
const conf = existsSync(BIN) ? test : test.skip;

const made: string[] = [];
const procs: Array<ReturnType<typeof Bun.spawn>> = [];
afterEach(async () => {
  for (const p of procs.splice(0)) {
    p.kill();
    await p.exited;
  }
  for (const dir of made.splice(0)) {
    await fsp.rm(dir, {recursive: true, force: true});
  }
});

async function rustAgent(token?: string): Promise<{
  url: string;
  remote: Storage;
  local: Storage;
  models: string;
  cold: string;
}> {
  const base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'tj-rust-'));
  made.push(base);
  const models = nodePath.join(base, 'models');
  const cold = nodePath.join(base, 'cold');
  const lemonade = nodePath.join(base, 'lemonade');
  for (const dir of [models, cold, lemonade]) await fsp.mkdir(dir);
  const cfg = nodePath.join(base, 'agent.yaml');
  await fsp.writeFile(
    cfg,
    `port: 0\n${token !== undefined ? `token: ${token}\n` : ''}` +
      `roots:\n  models: ${models}\n  cold: ${cold}\n  lemonade: ${lemonade}\n`,
  );
  const proc = Bun.spawn([BIN], {
    env: {...process.env, TJ_AGENT_CONFIG: cfg},
    stdout: 'pipe',
    stderr: 'inherit',
  });
  procs.push(proc);
  // The startup line announces the picked port.
  const reader = proc.stdout.getReader();
  let buf = '';
  for (;;) {
    const {done, value} = await reader.read();
    if (done) throw new Error('agent exited before announcing its port');
    buf += new TextDecoder().decode(value);
    const m = buf.match(/listening on :(\d+)/);
    if (m) {
      reader.releaseLock();
      const url = `http://127.0.0.1:${m[1]}/api/v1/storage`;
      return {
        url,
        remote: createHttpStorage({
          url,
          ...(token !== undefined ? {token} : {}),
        }),
        local: createLocalStorage({models, cold, lemonade}),
        models,
        cold,
      };
    }
  }
}

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const byPath = (entries: FileEntry[]) =>
  [...entries].sort((a, b) => a.path.localeCompare(b.path));

/** Compare inventories across implementations: order is unspecified, and
 *  mtimes may differ in float detail — everything else must be identical. */
function expectSameInventory(rust: FileEntry[], ts: FileEntry[]): void {
  const strip = (entries: FileEntry[]) =>
    byPath(entries).map(({mtimeMs, ...rest}) => rest);
  expect(strip(rust)).toEqual(strip(ts));
  const sortedTs = byPath(ts);
  byPath(rust).forEach((entry, i) => {
    expect(Math.abs(entry.mtimeMs - sortedTs[i].mtimeMs)).toBeLessThan(2);
  });
}

/** A minimal safetensors file whose one tensor has the given dtype. */
function safetensors(dtype: string): Buffer {
  const header = Buffer.from(JSON.stringify({w: {dtype}}), 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([len, header]);
}

conf('write and read round-trip through the Rust agent', async () => {
  const {remote} = await rustAgent('secret');
  const ref = {root: 'models', path: 'org/repo/tjmodel.json'} as const;
  await remote.write(ref, bytes('{"repoId":"org/repo"}'));
  expect(text(await remote.read(ref))).toBe('{"repoId":"org/repo"}');
});

conf('the Rust walk answers what the TS walk answers', async () => {
  const {remote, local, models} = await rustAgent('secret');
  await fsp.mkdir(nodePath.join(models, 'org/repo'), {recursive: true});
  await fsp.writeFile(nodePath.join(models, 'org/repo/a.gguf'), 'xx');
  await fsp.writeFile(
    nodePath.join(models, 'org/repo/w.safetensors'),
    safetensors('bf16'), // lowercased on disk; both walks must uppercase
  );
  await fsp.symlink(
    nodePath.join(models, 'org/repo/a.gguf'),
    nodePath.join(models, 'link.gguf'),
  );
  await fsp.symlink(
    nodePath.join(models, 'gone.gguf'),
    nodePath.join(models, 'dangling.gguf'),
  );

  expectSameInventory(
    await remote.list('models', {dtype: true}),
    await local.list('models', {dtype: true}),
  );
  // Scoped to a subdirectory, paths still root-relative.
  expectSameInventory(
    await remote.list('models', {under: 'org/repo'}),
    await local.list('models', {under: 'org/repo'}),
  );
  // A missing subdirectory is an empty answer, strict or not.
  expect(await remote.list('models', {under: 'no/such', strict: true})).toEqual(
    [],
  );
});

conf('a strict Rust list refuses a truncated inventory', async () => {
  const {remote, models} = await rustAgent('secret');
  const locked = nodePath.join(models, 'org/locked');
  await fsp.mkdir(locked, {recursive: true});
  await fsp.chmod(locked, 0o000);
  try {
    await expect(
      remote.list('models', {strict: true}),
    ).rejects.toThrow();
    const tolerant = await remote.list('models');
    expect(tolerant.some((e) => e.path === 'org/locked')).toBe(true);
  } finally {
    await fsp.chmod(locked, 0o755);
  }
});

conf('confinement holds across the wire', async () => {
  const {remote} = await rustAgent('secret');
  await expect(
    remote.read({root: 'models', path: '../escape'}),
  ).rejects.toThrow(/climb out/);
  await expect(
    remote.read({root: 'models', path: '/etc/passwd'}),
  ).rejects.toThrow(/relative/);
});

conf('the small-file cap holds at both ends', async () => {
  const {remote, url, models} = await rustAgent('secret');
  await expect(
    remote.write(
      {root: 'models', path: 'big'},
      new Uint8Array(MAX_SMALL_FILE + 1),
    ),
  ).rejects.toThrow(/small files only/);
  await fsp.writeFile(
    nodePath.join(models, 'big.gguf'),
    Buffer.alloc(MAX_SMALL_FILE + 1),
  );
  await expect(
    remote.read({root: 'models', path: 'big.gguf'}),
  ).rejects.toThrow(/small files only/);
  // A hand-rolled over-cap write dies at the agent, mid-stream, with 413.
  const res = await fetch(`${url}/write`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer secret',
      'x-tj-root': 'models',
      'x-tj-path': 'big',
    },
    body: new Uint8Array(MAX_SMALL_FILE + 1),
  });
  expect(res.status).toBe(413);
});

conf('a missing file reads as ENOENT across the wire', async () => {
  const {remote} = await rustAgent('secret');
  try {
    await remote.read({root: 'models', path: 'nope.json'});
    expect.unreachable();
  } catch (e) {
    expect((e as NodeJS.ErrnoException).code).toBe('ENOENT');
  }
});

conf('usage answers with device identity across roots', async () => {
  const {remote} = await rustAgent('secret');
  const usage = await remote.usage('models');
  expect(usage.total).toBeGreaterThan(0);
  expect(usage.free).toBeGreaterThan(0);
  expect(usage.device).not.toBe('');
  expect((await remote.usage('cold')).device).toBe(usage.device);
});

conf('auth and dispatch statuses match the protocol', async () => {
  const {url} = await rustAgent('secret');
  const naked = createHttpStorage({url});
  await expect(naked.list('models')).rejects.toThrow(/Unauthorized/);
  const wrong = createHttpStorage({url, token: 'nope'});
  await expect(wrong.list('models')).rejects.toThrow(/Unauthorized/);
  const post = (op: string, body: string) =>
    fetch(`${url}/${op}`, {
      method: 'POST',
      headers: {authorization: 'Bearer secret'},
      body,
    });
  expect((await post('hash', '{}')).status).toBe(501); // pending, not absent
  expect((await post('nope', '{}')).status).toBe(404);
  expect((await post('list', 'not json')).status).toBe(400);
  expect((await post('list', '{"root":"attic"}')).status).toBe(400);
});
