import {scanModels} from '@/lib/models/models';
import {auditFileUpdate, type UpdateResult} from '@/lib/audit/audit';
import {
  proxyAuditRequest,
  resolveAuditLocation,
} from '@/lib/audit/audit-location';
import {isObject, readJsonBody} from '@/lib/util/request';
import {clearHfCache} from '@/lib/hf/hf-infer';

// Concurrent head-commit checks. Network-bound and tree-cached per repo (quants
// of one model share a fetch), so this can be higher than the hashing audit's.
const CONCURRENCY = 8;

/**
 * Stream a per-file "is there a newer version on Hugging Face?" verdict for a
 * location, derived from each file's `.tjmeta.json` sidecar and HF's current
 * head commit — no local hashing. Files with no sidecar / no resolved source /
 * no recorded commit are skipped (they emit nothing). Mirrors the NDJSON
 * streaming and peer-proxying of `app/api/v1/audit/route.ts`.
 *
 * With `files`, only those (paths relative to the storage root) are checked —
 * the files an audit was run on; without it, every file at the location.
 */
export async function POST(req: Request) {
  const body = await readJsonBody<{location?: string; files?: string[]}>(
    req,
    isObject,
  );
  if (body instanceof Response) return body;

  const target = resolveAuditLocation(body.location);
  if (!target) {
    return new Response('Unsupported audit location', {status: 400});
  }
  if (target.kind === 'peer') {
    return proxyAuditRequest(
      target.peer,
      '/api/v1/audit/updates',
      body,
      req.signal,
    );
  }
  const basePath = target.site;

  // Fresh inference cache so head commits reflect HF now, not a tree cached by
  // an earlier audit in this process. Abort if the client disconnects.
  clearHfCache();
  const abortController = new AbortController();
  req.signal.addEventListener('abort', () => abortController.abort(), {
    once: true,
  });
  const {signal} = abortController;

  const only = Array.isArray(body.files) ? new Set(body.files) : null;
  const models = await scanModels(basePath);
  const relPaths: string[] = [];
  for (const model of models) {
    for (const file of model.files) {
      if (file.isSplit) {
        for (const shard of file.files)
          if (!only || only.has(shard.path)) relPaths.push(shard.path);
      } else if (!only || only.has(file.path)) {
        relPaths.push(file.path);
      }
    }
  }

  const enc = new TextEncoder();
  const {readable, writable} = new TransformStream();
  const writer = writable.getWriter();

  (async () => {
    const emit = async (event: UpdateResult) => {
      try {
        await writer.ready;
        await writer.write(enc.encode(JSON.stringify(event) + '\n'));
      } catch {
        /* client disconnected */
      }
    };

    let next = 0;
    const worker = async () => {
      while (!signal.aborted) {
        const i = next++;
        if (i >= relPaths.length) return;
        const result = await auditFileUpdate(basePath, relPaths[i]);
        if (signal.aborted) return;
        if (result) await emit(result);
      }
    };
    await Promise.all(
      Array.from({length: Math.min(CONCURRENCY, relPaths.length)}, worker),
    );

    try {
      await writer.close();
    } catch {
      /* already closed */
    }
  })();

  return new Response(readable, {
    headers: {'Content-Type': 'application/x-ndjson'},
  });
}
