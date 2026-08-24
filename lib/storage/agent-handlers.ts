/**
 * The agent's side of the storage protocol: every `Storage` verb and the job
 * kinds, served as plain `Request` → `Response` handlers with no framework in
 * them — so the full app (`app/api/v1/storage/[op]`) and the thin standalone
 * agent serve exactly the same thing, and an `HttpStorage` caller cannot tell
 * which it reached. That sameness is what lets the fleet mix full apps and
 * agents while the migration runs. Wire shapes live in agent-protocol.ts.
 *
 * Validation here is shape only. Confinement — the part that matters — is the
 * storage's own: every path resolves through `resolveRef`, which refuses to
 * name anything outside a root.
 */

import {
  ERROR_CODE_HEADER,
  HASH_EMIT_BYTES,
  OFFSET_HEADER,
  REF_PATH_HEADER,
  REF_ROOT_HEADER,
  type HashFrame,
} from '@/lib/storage/agent-protocol';
import type {Roots} from '@/lib/storage/local-storage';
import {receiveChunk} from '@/lib/storage/receive';
import {resolveRef} from '@/lib/storage/resolve-ref';
import {
  MAX_SMALL_FILE,
  type JobHandle,
  type JobSpec,
  type Ref,
  type Root,
  type Storage,
} from '@/lib/storage/storage';
import {isObject} from '@/lib/util/request';

export interface AgentContext {
  storage: Storage;
  /** The directories behind the storage's roots, for the byte endpoints the
   *  interface's small-file cap keeps out of `read`/`write` (the receiving
   *  half of a `send` job lands here needing them). */
  roots: Roots;
}

const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson',
  'Cache-Control': 'no-store',
};

const ROOT_NAMES = ['models', 'cold', 'lemonade'] as const;

function isRoot(v: unknown): v is Root {
  return typeof v === 'string' && (ROOT_NAMES as readonly string[]).includes(v);
}

function isRef(v: unknown): v is Ref {
  return isObject(v) && isRoot(v.root) && typeof v.path === 'string';
}

/** A `Ref` rebuilt from a wire value, extra properties left behind. */
function ref(v: Ref): Ref {
  return {root: v.root, path: v.path};
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const bad = (what: string) => new Response(`Invalid ${what}`, {status: 400});

async function readJson(req: Request): Promise<unknown | Response> {
  try {
    return await req.json();
  } catch {
    return new Response('Invalid JSON', {status: 400});
  }
}

/** Collect a request body, refusing past `cap`: the cap is the interface's
 *  promise, so it holds before the bytes pile up in memory, not after. */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function isJobSpec(v: unknown): v is JobSpec {
  if (!isObject(v)) return false;
  if (v.kind === 'download') {
    return (
      typeof v.repoId === 'string' &&
      (v.revision === undefined || typeof v.revision === 'string') &&
      Array.isArray(v.files) &&
      v.files.every((f) => typeof f === 'string') &&
      isRef(v.into)
    );
  }
  if (v.kind === 'copy') {
    return (
      isRef(v.from) &&
      isRef(v.to) &&
      (v.move === undefined || typeof v.move === 'boolean')
    );
  }
  if (v.kind === 'send') {
    return (
      isRef(v.from) &&
      isObject(v.to) &&
      typeof v.to.agent === 'string' &&
      (v.to.token === undefined || typeof v.to.token === 'string') &&
      isRef(v.to.ref)
    );
  }
  return false;
}

/** A `JobSpec` rebuilt from a validated wire value. */
function jobSpec(v: JobSpec): JobSpec {
  if (v.kind === 'download') {
    return {
      kind: 'download',
      repoId: v.repoId,
      ...(v.revision !== undefined ? {revision: v.revision} : {}),
      files: [...v.files],
      into: ref(v.into),
    };
  }
  if (v.kind === 'copy') {
    return {
      kind: 'copy',
      from: ref(v.from),
      to: ref(v.to),
      ...(v.move !== undefined ? {move: v.move} : {}),
    };
  }
  return {
    kind: 'send',
    from: ref(v.from),
    to: {
      agent: v.to.agent,
      ...(v.to.token !== undefined ? {token: v.to.token} : {}),
      ref: ref(v.to.ref),
    },
  };
}

export async function handleAgentRequest(
  ctx: AgentContext,
  op: string,
  req: Request,
): Promise<Response> {
  try {
    switch (op) {
      case 'list': {
        const body = await readJson(req);
        if (body instanceof Response) return body;
        if (!isObject(body) || !isRoot(body.root)) return bad('root');
        const {root, under, dtype, strict} = body;
        if (under !== undefined && typeof under !== 'string')
          return bad('under');
        const entries = await ctx.storage.list(root, {
          ...(under !== undefined ? {under} : {}),
          ...(dtype ? {dtype: true} : {}),
          ...(strict ? {strict: true} : {}),
        });
        return Response.json({entries});
      }

      case 'read': {
        const body = await readJson(req);
        if (body instanceof Response) return body;
        if (!isRef(body)) return bad('ref');
        const bytes = await ctx.storage.read(ref(body));
        return new Response(bytes as Uint8Array<ArrayBuffer>, {
          headers: {'Content-Type': 'application/octet-stream'},
        });
      }

      case 'write': {
        const root = req.headers.get(REF_ROOT_HEADER);
        const rawPath = req.headers.get(REF_PATH_HEADER);
        if (!isRoot(root) || rawPath === null) return bad('ref headers');
        let path: string;
        try {
          path = decodeURIComponent(rawPath);
        } catch {
          return bad('ref headers');
        }
        const bytes = await readCapped(req.body, MAX_SMALL_FILE);
        if (bytes === null) {
          return new Response(
            `${path} is over ${MAX_SMALL_FILE} bytes; write is for small files only`,
            {status: 413},
          );
        }
        await ctx.storage.write({root, path}, bytes);
        return Response.json({ok: true});
      }

      case 'mkdir': {
        const body = await readJson(req);
        if (body instanceof Response) return body;
        if (!isRef(body)) return bad('ref');
        await ctx.storage.mkdir(ref(body));
        return Response.json({ok: true});
      }

      case 'remove': {
        const body = await readJson(req);
        if (body instanceof Response) return body;
        if (!isObject(body) || !Array.isArray(body.refs)) return bad('refs');
        const refs = body.refs;
        if (!refs.every(isRef)) return bad('refs');
        await ctx.storage.remove(
          refs.map(ref),
          body.pruneEmptyDirs ? {pruneEmptyDirs: true} : {},
        );
        return Response.json({ok: true});
      }

      case 'move':
      case 'copy': {
        const body = await readJson(req);
        if (body instanceof Response) return body;
        if (!isObject(body) || !isRef(body.from) || !isRef(body.to))
          return bad('refs');
        if (op === 'move') await ctx.storage.move(ref(body.from), ref(body.to));
        else await ctx.storage.copy(ref(body.from), ref(body.to));
        return Response.json({ok: true});
      }

      case 'link': {
        const body = await readJson(req);
        if (body instanceof Response) return body;
        if (!isObject(body) || !Array.isArray(body.links)) return bad('links');
        const links = body.links;
        if (
          !links.every(
            (l): l is {target: Ref; at: Ref} =>
              isObject(l) && isRef(l.target) && isRef(l.at),
          )
        ) {
          return bad('links');
        }
        const outcomes = await ctx.storage.link(
          links.map((l) => ({target: ref(l.target), at: ref(l.at)})),
          body.dryRun ? {dryRun: true} : {},
        );
        return Response.json({outcomes});
      }

      case 'usage': {
        const body = await readJson(req);
        if (body instanceof Response) return body;
        if (!isObject(body) || !isRoot(body.root)) return bad('root');
        return Response.json(await ctx.storage.usage(body.root));
      }

      case 'hash': {
        const body = await readJson(req);
        if (body instanceof Response) return body;
        if (!isRef(body)) return bad('ref');
        const target = ref(body);
        const ctl = new AbortController();
        req.signal.addEventListener('abort', () => ctl.abort(), {once: true});
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            const send = (frame: HashFrame) => {
              try {
                controller.enqueue(enc.encode(JSON.stringify(frame) + '\n'));
              } catch {
                ctl.abort();
              }
            };
            let bytes = 0;
            let sent = 0;
            try {
              const sha256 = await ctx.storage.hash(target, {
                signal: ctl.signal,
                onBytes: (n) => {
                  bytes += n;
                  if (bytes - sent >= HASH_EMIT_BYTES) {
                    sent = bytes;
                    send({bytes});
                  }
                },
              });
              // Close the count before the digest, so a caller's progress
              // total reaches the file's size however small the file.
              if (bytes > sent) send({bytes});
              send({sha256});
            } catch (e) {
              send({error: message(e)});
            }
            try {
              controller.close();
            } catch {
              /* client gone */
            }
          },
          cancel() {
            ctl.abort();
          },
        });
        return new Response(stream, {headers: NDJSON_HEADERS});
      }

      case 'job': {
        const body = await readJson(req);
        if (body instanceof Response) return body;
        if (!isJobSpec(body)) return bad('job spec');
        const job: JobHandle = await ctx.storage.start(jobSpec(body));
        req.signal.addEventListener('abort', () => void job.cancel(), {
          once: true,
        });
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            let closed = false;
            for await (const event of job.events()) {
              if (closed) continue;
              try {
                controller.enqueue(enc.encode(JSON.stringify(event) + '\n'));
              } catch {
                closed = true;
                void job.cancel();
              }
            }
            if (!closed) {
              try {
                controller.close();
              } catch {
                /* client gone */
              }
            }
          },
          cancel() {
            void job.cancel();
          },
        });
        return new Response(stream, {headers: NDJSON_HEADERS});
      }

      case 'receive': {
        const root = req.headers.get(REF_ROOT_HEADER);
        const rawPath = req.headers.get(REF_PATH_HEADER);
        if (!isRoot(root) || rawPath === null) return bad('ref headers');
        let path: string;
        try {
          path = decodeURIComponent(rawPath);
        } catch {
          return bad('ref headers');
        }
        const offset = parseInt(req.headers.get(OFFSET_HEADER) ?? '0', 10);
        if (!Number.isInteger(offset) || offset < 0) return bad('offset');
        // The one byte endpoint: an append past the small-file cap, so it
        // goes to the filesystem beside the storage rather than through the
        // interface — confined by the same resolveRef either way.
        const dir = ctx.roots[root];
        if (!dir) {
          return new Response(`No ${root} directory is configured`, {
            status: 400,
          });
        }
        let full: string;
        try {
          full = resolveRef(dir, path);
        } catch (e) {
          return new Response(message(e), {status: 400});
        }
        const outcome = await receiveChunk(full, offset, req.body);
        if (!outcome.ok) {
          return new Response(
            `Offset ${offset} does not match the ${outcome.heldBytes ?? 'missing'} byte(s) already here`,
            {status: 409},
          );
        }
        return Response.json({ok: true});
      }

      default:
        return new Response(`Unknown op: ${op}`, {status: 404});
    }
  } catch (e) {
    // Carry the fs error code when there is one: a remote ENOENT must stay
    // an ENOENT to the tolerance checks in the policy modules.
    const code = (e as NodeJS.ErrnoException).code;
    return new Response(message(e), {
      status: 500,
      ...(typeof code === 'string'
        ? {headers: {[ERROR_CODE_HEADER]: code}}
        : {}),
    });
  }
}
