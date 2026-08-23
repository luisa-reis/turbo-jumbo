/**
 * The jobs a `LocalStorage` runs: `hf` for a download, a resumable stream for
 * a copy. Each hands back a `JobHandle` whose events arrive on a channel the
 * job pushes into — the shape an agent would serialize as NDJSON, produced
 * here in-process.
 */

import {spawn} from 'child_process';
import {promises as fsp} from 'fs';
import nodePath from 'path';
import {
  isValidFilePath,
  isValidRepoId,
  isValidRevision,
} from '@/lib/hf/download-request';
import {streamCopyResumable} from '@/lib/storage/file-transfer';
import type {
  CopyResult,
  DownloadResult,
  JobEvent,
  JobHandle,
  JobSpec,
  Ref,
} from '@/lib/storage/storage';

/** Events pushed by the job, pulled by one consumer. Closes itself on a
 *  terminal event; anything pushed after is dropped. */
class JobChannel implements AsyncIterable<JobEvent> {
  private queue: JobEvent[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(event: JobEvent): void {
    if (this.closed) return;
    this.queue.push(event);
    if (event.kind === 'done' || event.kind === 'error') this.closed = true;
    this.wake?.();
    this.wake = null;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<JobEvent> {
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

function handle(
  channel: JobChannel,
  cancel: () => Promise<void> | void,
): JobHandle {
  return {
    id: crypto.randomUUID(),
    events: () => channel,
    cancel: async () => {
      await cancel();
    },
  };
}

const ANSI_RE = /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07]*\x07|[^[\]])/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

type Resolve = (ref: Ref) => string;

/**
 * Run `hf download`. The arguments are validated here, whatever the caller
 * checked: this is the one place the storage turns a request into a command
 * line, and an argv array with no shell is the whole of what it will run.
 * `hf --json` prints one `{"path": …}` record on stdout on success and its
 * errors on stderr, and no progress at all — a caller gauges that from the
 * inventory.
 */
export function startDownloadJob(
  spec: Extract<JobSpec, {kind: 'download'}>,
  resolve: Resolve,
): JobHandle {
  const channel = new JobChannel();
  const revision = spec.revision ?? 'main';
  const invalid = !isValidRepoId(spec.repoId)
    ? `invalid repoId: ${spec.repoId}`
    : !isValidRevision(revision)
      ? `invalid revision: ${revision}`
      : spec.files.find((f) => !isValidFilePath(f)) !== undefined
        ? `invalid file path: ${spec.files.find((f) => !isValidFilePath(f))}`
        : null;
  if (invalid) {
    channel.push({kind: 'error', message: invalid});
    return handle(channel, () => {});
  }
  let dir: string;
  try {
    dir = resolve(spec.into);
  } catch (e) {
    channel.push({kind: 'error', message: (e as Error).message});
    return handle(channel, () => {});
  }

  const args = ['download', spec.repoId];
  for (const f of spec.files) args.push('--include', f);
  args.push('--local-dir', dir, '--revision', revision, '--json');

  // The spawn inherits the server's environment: transfer acceleration
  // (HF_XET_HIGH_PERFORMANCE) and HF_TOKEN come from there (.envrc in dev,
  // ENV in the Dockerfile) rather than app code.
  const proc = spawn('hf', args);
  let output = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  proc.stderr.on('data', (chunk: Buffer) => {
    const text = stripAnsi(chunk.toString());
    if (text) channel.push({kind: 'log', line: text});
  });
  proc.on('error', (err) => {
    channel.push({kind: 'error', message: err.message});
  });
  proc.on('close', (code, signal) => {
    const result: DownloadResult = {exitCode: code, signal, output};
    channel.push({kind: 'done', result});
  });
  return handle(channel, () => {
    proc.kill('SIGTERM');
  });
}

// Progress is reported at most this often, plus once at the end: a copy
// streams in 64 KiB chunks, and an event per chunk would be the slowest part
// of sending it anywhere.
const PROGRESS_INTERVAL_MS = 250;

/**
 * Copy a file between refs, resuming a partial destination (see
 * `streamCopyResumable`); with `move`, remove the source after — by rename
 * when the two share a filesystem, which finishes at once.
 */
export function startCopyJob(
  spec: Extract<JobSpec, {kind: 'copy'}>,
  resolve: Resolve,
): JobHandle {
  const channel = new JobChannel();
  const ctl = new AbortController();
  void (async () => {
    try {
      const src = resolve(spec.from);
      const dst = resolve(spec.to);
      await fsp.mkdir(nodePath.dirname(dst), {recursive: true});
      if (spec.move) {
        try {
          await fsp.rename(src, dst);
          const size = (await fsp.stat(dst)).size;
          channel.push({kind: 'progress', done: size, total: size});
          const result: CopyResult = {resumedFrom: size, size};
          channel.push({kind: 'done', result});
          return;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
        }
      }
      const size = (await fsp.stat(src)).size;
      let done = 0;
      let lastAt = 0;
      const report = (force: boolean) => {
        const now = Date.now();
        if (!force && now - lastAt < PROGRESS_INTERVAL_MS) return;
        lastAt = now;
        channel.push({kind: 'progress', done, total: size});
      };
      const resumedFrom = await streamCopyResumable(src, dst, {
        signal: ctl.signal,
        onResume: (offset) => {
          done = offset;
          report(true);
        },
        onChunk: (n) => {
          done += n;
          report(false);
        },
      });
      report(true);
      if (spec.move) await fsp.rm(src, {force: true});
      const result: CopyResult = {resumedFrom, size};
      channel.push({kind: 'done', result});
    } catch (e) {
      channel.push({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  })();
  return handle(channel, () => {
    ctl.abort();
  });
}
