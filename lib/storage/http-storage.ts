/**
 * `Storage` over the agent protocol: the same verbs and jobs, spoken to a
 * machine that answers them with agent-handlers.ts — a thin agent, or a peer
 * running the full app, which serve identical protocols on purpose. Callers
 * hold a `Storage` and never learn which they got; that is the interface's
 * whole promise, kept here for the remote case.
 *
 * Refs stay root-relative on this side too: an `HttpStorage` never learns the
 * far machine's directory layout, and the far side confines every path to its
 * own roots.
 */

import {
  REF_PATH_HEADER,
  REF_ROOT_HEADER,
  type HashFrame,
} from '@/lib/storage/agent-protocol';
import {JobChannel, jobHandle} from '@/lib/storage/job-channel';
import {
  MAX_SMALL_FILE,
  type FileEntry,
  type JobEvent,
  type LinkOutcome,
  type Ref,
  type Storage,
  type Usage,
} from '@/lib/storage/storage';
import {readNdjson} from '@/lib/util/ndjson';

/** Where an agent answers, and how to reach it. */
export interface AgentTarget {
  /** The protocol root, e.g. `http://host:3000/api/v1/storage`. */
  url: string;
  /** Sent as a bearer token when the target requires one (the standalone
   *  agent does; the full app answers like the rest of its peer API). */
  token?: string;
  /** Test seam: speak the protocol to an in-process handler instead of a
   *  socket. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export function createHttpStorage(target: AgentTarget): Storage {
  const fetchImpl = target.fetchImpl ?? fetch;
  const base = target.url.replace(/\/+$/, '');

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...(target.token ? {authorization: `Bearer ${target.token}`} : {}),
      ...extra,
    };
  }

  async function call(op: string, init: RequestInit): Promise<Response> {
    const res = await fetchImpl(`${base}/${op}`, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `${op}: HTTP ${res.status}`);
    }
    return res;
  }

  async function callJson<T>(op: string, body: unknown): Promise<T> {
    const res = await call(op, {
      method: 'POST',
      headers: headers({'Content-Type': 'application/json'}),
      body: JSON.stringify(body),
    });
    return (await res.json()) as T;
  }

  return {
    async list(root, opts = {}) {
      const {entries} = await callJson<{entries: FileEntry[]}>('list', {
        root,
        ...opts,
      });
      return entries;
    },

    async read(ref: Ref) {
      const res = await call('read', {
        method: 'POST',
        headers: headers({'Content-Type': 'application/json'}),
        body: JSON.stringify(ref),
      });
      return new Uint8Array(await res.arrayBuffer());
    },

    async write(ref: Ref, bytes: Uint8Array) {
      // The same refusal the far side would give, before the bytes travel.
      if (bytes.byteLength > MAX_SMALL_FILE) {
        throw new Error(
          `${ref.path} is ${bytes.byteLength} bytes; write is for small files only`,
        );
      }
      await call('write', {
        method: 'POST',
        headers: headers({
          'Content-Type': 'application/octet-stream',
          [REF_ROOT_HEADER]: ref.root,
          [REF_PATH_HEADER]: encodeURIComponent(ref.path),
        }),
        body: bytes as Uint8Array<ArrayBuffer>,
      });
    },

    async mkdir(ref: Ref) {
      await callJson('mkdir', ref);
    },

    async remove(refs, opts = {}) {
      await callJson('remove', {refs, ...opts});
    },

    async move(from, to) {
      await callJson('move', {from, to});
    },

    async copy(from, to) {
      await callJson('copy', {from, to});
    },

    async link(links, opts = {}) {
      const {outcomes} = await callJson<{outcomes: LinkOutcome[]}>('link', {
        links,
        ...opts,
      });
      return outcomes;
    },

    usage(root) {
      return callJson<Usage>('usage', {root});
    },

    async hash(ref: Ref, opts = {}) {
      const res = await call('hash', {
        method: 'POST',
        headers: headers({'Content-Type': 'application/json'}),
        body: JSON.stringify(ref),
        ...(opts.signal ? {signal: opts.signal} : {}),
      });
      // The wire carries cumulative counts (self-contained frames); the
      // interface promises per-chunk deltas, so convert back here.
      let reported = 0;
      let sha: string | null = null;
      let failed: string | null = null;
      await readNdjson<HashFrame>(res, (frame) => {
        if ('bytes' in frame) {
          if (opts.onBytes && frame.bytes > reported) {
            opts.onBytes(frame.bytes - reported);
          }
          reported = Math.max(reported, frame.bytes);
        } else if ('sha256' in frame) {
          sha = frame.sha256;
        } else {
          failed = frame.error;
        }
      });
      if (failed !== null) throw new Error(failed);
      if (sha === null) throw new Error('hash stream ended without a digest');
      return sha;
    },

    async start(spec) {
      const ctl = new AbortController();
      const res = await call('job', {
        method: 'POST',
        headers: headers({'Content-Type': 'application/json'}),
        body: JSON.stringify(spec),
        signal: ctl.signal,
      });
      const channel = new JobChannel();
      void (async () => {
        try {
          await readNdjson<JobEvent>(res, (event) => channel.push(event));
          // Lands only when the stream ended without done/error — a push
          // after a terminal event is dropped by the channel.
          channel.push({
            kind: 'error',
            message: 'job stream ended without a result',
          });
        } catch (e) {
          channel.push({
            kind: 'error',
            message: ctl.signal.aborted
              ? 'cancelled'
              : e instanceof Error
                ? e.message
                : String(e),
          });
        }
      })();
      return jobHandle(channel, () => ctl.abort());
    },
  };
}
