/**
 * The jobs a `LocalStorage` runs: `hf` for a download, a resumable stream for
 * a copy. Each hands back a `JobHandle` whose events arrive on a channel the
 * job pushes into — the shape an agent would serialize as NDJSON, produced
 * here in-process.
 */

import {spawn} from 'child_process';
import {createReadStream, promises as fsp} from 'fs';
import nodePath from 'path';
import {Readable} from 'stream';
import {
  isValidFilePath,
  isValidRepoId,
  isValidRevision,
} from '@/lib/hf/download-request';
import {fileSize} from '@/lib/storage/entries';
import {streamCopyResumable} from '@/lib/storage/file-transfer';
import {
  createHttpStorage,
  postReceiveChunk,
  type AgentTarget,
} from '@/lib/storage/http-storage';
import {JobChannel, jobHandle} from '@/lib/storage/job-channel';
import {peerResumeOffset} from '@/lib/storage/peer-resume';
import {pruneEmptyDirs} from '@/lib/storage/prune';
import type {
  CopyResult,
  DownloadResult,
  JobHandle,
  JobSpec,
  Ref,
  Root,
  SendResult,
} from '@/lib/storage/storage';

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
    return jobHandle(channel, () => {});
  }
  let dir: string;
  try {
    dir = resolve(spec.into);
  } catch (e) {
    channel.push({kind: 'error', message: (e as Error).message});
    return jobHandle(channel, () => {});
  }

  const args = ['download', spec.repoId];
  for (const f of spec.files) args.push('--include', f);
  args.push('--local-dir', dir, '--revision', revision, '--json');

  // The spawn inherits the server's environment: transfer acceleration
  // (HF_XET_HIGH_PERFORMANCE) and HF_TOKEN come from there (.envrc in dev,
  // ENV in the Containerfile) rather than app code.
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
  return jobHandle(channel, () => {
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
 * when the two share a filesystem, which finishes at once — and prune the
 * directories the source leaves empty, so a moved-out model leaves no husk.
 */
export function startCopyJob(
  spec: Extract<JobSpec, {kind: 'copy'}>,
  resolve: Resolve,
  rootDir: (root: Root) => string,
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
          await pruneEmptyDirs(src, rootDir(spec.from.root));
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
      let lastVerify = 0;
      const resumedFrom = await streamCopyResumable(src, dst, {
        signal: ctl.signal,
        // Hash-comparing a partial destination is the slow, silent stretch of
        // a resume; report it so a caller can label the wait honestly.
        onVerify: (done, total) => {
          const now = Date.now();
          if (now - lastVerify < PROGRESS_INTERVAL_MS && done < total) return;
          lastVerify = now;
          channel.push({kind: 'verify', done, total});
        },
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
      if (spec.move) {
        await fsp.rm(src, {force: true});
        await pruneEmptyDirs(src, rootDir(spec.from.root));
      }
      const result: CopyResult = {resumedFrom, size};
      channel.push({kind: 'done', result});
    } catch (e) {
      channel.push({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  })();
  return jobHandle(channel, () => {
    ctl.abort();
  });
}

// A send travels in bounded chunks, one request each: an interrupted transfer
// loses at most a chunk, and the receiver's offset check guards every seam.
const SEND_CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * Stream a file to another agent's `receive` endpoint — the cross-machine
 * copy, run by the machine that holds the file so the bytes never traverse
 * whoever asked for the transfer.
 *
 * Resume is decided here, never asserted: the far side's partial counts only
 * when its own hash of those bytes (the `hash` verb, over the wire) matches
 * the source's same-length region — the peer-upload resume, aimed at an
 * agent. `verify` events cover that stretch; `progress` starts at the proven
 * offset and the skipped prefix counts as done, so the bar still sums to the
 * file's size.
 */
export function startSendJob(
  spec: Extract<JobSpec, {kind: 'send'}>,
  resolve: Resolve,
  agentFetch?: typeof fetch,
): JobHandle {
  const channel = new JobChannel();
  const ctl = new AbortController();
  void (async () => {
    try {
      const src = resolve(spec.from);
      const target: AgentTarget = {
        url: spec.to.agent,
        ...(spec.to.token !== undefined ? {token: spec.to.token} : {}),
        ...(agentFetch ? {fetchImpl: agentFetch} : {}),
      };
      const remote = createHttpStorage(target);
      const size = (await fsp.stat(src)).size;

      let lastVerify = 0;
      const offset = await peerResumeOffset({
        peer: spec.to.agent,
        file: spec.to.ref.path,
        srcFull: src,
        srcSize: size,
        signal: ctl.signal,
        onVerify: (done, total) => {
          const now = Date.now();
          if (now - lastVerify < PROGRESS_INTERVAL_MS && done < total) return;
          lastVerify = now;
          channel.push({kind: 'verify', done, total});
        },
        reader: {
          size: () => fileSize(remote, spec.to.ref.root, spec.to.ref.path),
          sha256: () => remote.hash(spec.to.ref),
        },
      });

      let done = offset;
      let lastAt = 0;
      const report = (force: boolean) => {
        const now = Date.now();
        if (!force && now - lastAt < PROGRESS_INTERVAL_MS) return;
        lastAt = now;
        channel.push({kind: 'progress', done, total: size});
      };
      report(true);

      if (size === 0) {
        // An empty file still has to exist at the far end.
        await postReceiveChunk(target, spec.to.ref, 0, null, ctl.signal);
      }
      for (let at = offset; at < size; at += SEND_CHUNK_SIZE) {
        ctl.signal.throwIfAborted();
        const chunkEnd = Math.min(at + SEND_CHUNK_SIZE, size);
        const rs = createReadStream(src, {start: at, end: chunkEnd - 1});
        await postReceiveChunk(
          target,
          spec.to.ref,
          at,
          Readable.toWeb(rs) as unknown as BodyInit,
          ctl.signal,
        );
        done = chunkEnd;
        report(false);
      }
      report(true);
      const result: SendResult = {resumedFrom: offset, size};
      channel.push({kind: 'done', result});
    } catch (e) {
      channel.push({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  })();
  return jobHandle(channel, () => {
    ctl.abort();
  });
}
