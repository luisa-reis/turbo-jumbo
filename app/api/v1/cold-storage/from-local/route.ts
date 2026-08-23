import {coldStorageDir, localModelsDir} from '@/lib/config';
import {propagateFileMeta} from '@/lib/storage/copy-meta';
import {fileSize} from '@/lib/storage/entries';
import type {Site} from '@/lib/storage/site';
import {storage} from '@/lib/storage/storage-instance';
import {logger} from '@/lib/util/logger';
import {hasStringFiles, readJsonBody} from '@/lib/util/request';

const EMIT_INTERVAL = 8 * 1024 * 1024; // 8 MB

/** A root-relative path that stays inside its root. The storage refuses the
 *  rest as well; this answers 400 for it rather than 500. */
function isWithinRoot(file: string): boolean {
  return (
    file !== '' &&
    !file.startsWith('/') &&
    !file.split('/').some((seg) => seg === '..')
  );
}

const cold: Site = {storage, root: 'cold'};
const local: Site = {storage, root: 'models'};

/**
 * Copy this host's local-storage files into the cold-storage mount, streaming
 * NDJSON progress. The mirror of `to-local`: the copy route forwards a
 * peer→cold request here so the bytes are read and written entirely on the peer
 * (local disk → the shared cold-storage mount) instead of being proxied through
 * the requesting host — a `cp`-style local copy, not a multi-GB network stream
 * that could outrun a slower sink and exhaust memory. Per-file errors are
 * collected, not fatal; `succeeded` lists the files that reached cold storage so
 * the caller can gate a delete-after-copy on it.
 */
export async function POST(req: Request) {
  if (!coldStorageDir || !localModelsDir)
    return new Response('No local storage configured', {status: 400});

  const body = await readJsonBody<{files: string[]}>(req, hasStringFiles);
  if (body instanceof Response) return body;
  const {files} = body;

  for (const file of files) {
    if (!isWithinRoot(file)) return new Response('Invalid path', {status: 400});
  }

  // Sizes come from the local copy (the source of this transfer). A file
  // missing locally is reported as an error during the copy loop.
  const fileSizeMap: Record<string, number> = {};
  for (const file of files) {
    const size = await fileSize(storage, 'models', file);
    if (size !== null) fileSizeMap[file] = size;
  }

  let filesTotal = 0;
  let bytesTotal = 0;
  for (const file of files) {
    if (fileSizeMap[file] != null) {
      filesTotal++;
      bytesTotal += fileSizeMap[file];
    }
  }

  const enc = new TextEncoder();
  const abortController = new AbortController();
  req.signal.addEventListener('abort', () => abortController.abort(), {
    once: true,
  });

  const stream = new ReadableStream({
    async start(controller) {
      const {signal} = abortController;
      let closed = false;
      const safeEnqueue = (data: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(data);
        } catch {
          closed = true;
          abortController.abort();
        }
      };
      const safeClose = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };

      let filesDone = 0;
      let bytesDone = 0;
      let fileDone = 0;
      let fileTotal = 0;
      const succeeded: string[] = [];
      const errors: string[] = [];

      const emit = () =>
        safeEnqueue(
          enc.encode(
            JSON.stringify({
              filesDone,
              filesTotal,
              fileDone,
              fileTotal,
              bytesDone,
              bytesTotal,
              succeeded,
              errors,
            }) + '\n',
          ),
        );

      emit();
      logger.info(`[local→cold] start: ${files.length} file(s)`);

      try {
        for (const file of files) {
          if (fileSizeMap[file] == null) {
            errors.push(`${file}: not found in local storage`);
            emit();
            continue;
          }
          signal.throwIfAborted();

          fileTotal = fileSizeMap[file];
          fileDone = 0;
          emit();

          try {
            // One copy job per file, resuming a partial cold copy from its
            // verified prefix; the bytes kept count as done.
            const job = await storage.start({
              kind: 'copy',
              from: {root: 'models', path: file},
              to: {root: 'cold', path: file},
            });
            const cancel = () => void job.cancel();
            signal.addEventListener('abort', cancel, {once: true});
            let nextEmitAt = EMIT_INTERVAL;
            try {
              for await (const event of job.events()) {
                if (event.kind === 'progress') {
                  bytesDone += event.done - fileDone;
                  fileDone = event.done;
                  if (fileDone >= nextEmitAt) {
                    nextEmitAt = fileDone + EMIT_INTERVAL;
                    emit();
                  }
                } else if (event.kind === 'error') {
                  throw new Error(event.message);
                }
              }
            } finally {
              signal.removeEventListener('abort', cancel);
            }
            filesDone++;
            fileDone = fileTotal;
            succeeded.push(file);
            // Bytes are down; carry the file's provenance so the cold copy
            // names and audits without a re-hash. Best effort: a meta failure
            // is reported but the copy stands.
            try {
              await propagateFileMeta(local, cold, file);
            } catch (err) {
              errors.push(
                `${file}: meta: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            emit();
          } catch (err) {
            if (signal.aborted) throw err;
            errors.push(
              `${file}: ${err instanceof Error ? err.message : String(err)}`,
            );
            emit();
          }
        }

        logger.info(
          `[local→cold] done: ${succeeded.length}/${files.length} file(s)` +
            (errors.length ? `, ${errors.length} error(s)` : ''),
        );
        safeClose();
      } catch (err) {
        if (signal.aborted) logger.info('[local→cold] cancelled');
        else logger.error('[local→cold] error:', err);
        safeClose();
      }
    },
    cancel() {
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {'Content-Type': 'application/x-ndjson'},
  });
}
