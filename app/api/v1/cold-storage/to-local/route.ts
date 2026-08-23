import {coldStorageDir, localModelsDir} from '@/lib/config';
import {propagateFileMeta} from '@/lib/storage/copy-meta';
import {fileSize} from '@/lib/storage/entries';
import type {Site} from '@/lib/storage/site';
import type {CopyResult} from '@/lib/storage/storage';
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

// Copy files from this peer's own cold storage into its local models dir,
// streaming byte progress. Used so a remote peer can pull from its cold storage
// without routing the data through the orchestrating host.
export async function POST(req: Request) {
  if (!coldStorageDir || !localModelsDir)
    return new Response('No local storage configured', {status: 400});

  const body = await readJsonBody<{files: string[]}>(req, hasStringFiles);
  if (body instanceof Response) return body;
  const {files} = body;

  for (const file of files) {
    if (!isWithinRoot(file)) return new Response('Invalid path', {status: 400});
  }

  const fileSizeMap: Record<string, number> = {};
  for (const file of files) {
    // A source file that isn't there is skipped during the copy.
    const size = await fileSize(storage, 'cold', file);
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
              errors,
            }) + '\n',
          ),
        );

      emit();
      logger.info(`[cold→local] start: ${files.length} file(s)`);

      try {
        for (const file of files) {
          if (fileSizeMap[file] == null) {
            logger.debug(`[cold→local] skipping ${file}: not in cold storage`);
            continue;
          }

          signal.throwIfAborted();

          fileTotal = fileSizeMap[file];
          fileDone = 0;
          emit();

          // One copy job per file. It picks up an interrupted pull rather than
          // starting the file again: whatever is already here is kept when it
          // hash-matches the archive's same-length prefix, and only the tail
          // streams. The bytes kept count as done so the totals still add up.
          const job = await storage.start({
            kind: 'copy',
            from: {root: 'cold', path: file},
            to: {root: 'models', path: file},
          });
          const cancel = () => void job.cancel();
          signal.addEventListener('abort', cancel, {once: true});
          let nextEmitAt = EMIT_INTERVAL;
          let result: CopyResult | null = null;
          try {
            for await (const event of job.events()) {
              if (event.kind === 'progress') {
                bytesDone += event.done - fileDone;
                fileDone = event.done;
                if (fileDone >= nextEmitAt) {
                  nextEmitAt = fileDone + EMIT_INTERVAL;
                  emit();
                }
              } else if (event.kind === 'done') {
                result = event.result as CopyResult;
              } else if (event.kind === 'error') {
                throw new Error(event.message);
              }
            }
          } finally {
            signal.removeEventListener('abort', cancel);
          }
          if (
            result &&
            result.resumedFrom > 0 &&
            result.resumedFrom < fileTotal
          )
            logger.info(
              `[cold→local] resumed ${file} at ${result.resumedFrom}/${fileTotal} bytes`,
            );

          filesDone++;
          fileDone = fileTotal;
          // Bytes are down; carry the file's provenance so the local copy
          // names and audits without a re-hash. Best effort: a meta failure
          // is reported but the copy stands.
          try {
            await propagateFileMeta(cold, local, file);
          } catch (err) {
            errors.push(
              `${file}: meta: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          emit();
        }

        logger.info(`[cold→local] done: ${files.length} file(s)`);
        safeClose();
      } catch (err) {
        if (signal.aborted) logger.info('[cold→local] cancelled');
        else logger.error('[cold→local] error:', err);
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
