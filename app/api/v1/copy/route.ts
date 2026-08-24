import {config, localPeer, localModelsDir, coldStorageDir} from '@/lib/config';
import {propagateFileMeta} from '@/lib/storage/copy-meta';
import {
  cleanupWeightlessModelDirs,
  deleteFileWithMeta,
} from '@/lib/storage/delete-file';
import {
  agentTargetFor,
  siteForName,
  storageForPeer,
} from '@/lib/storage/peer-storage';
import type {Site} from '@/lib/storage/site';
import type {CopyResult, JobSpec} from '@/lib/storage/storage';
import {
  resolveSupportFiles,
  supportFileSources,
} from '@/lib/storage/support-files';
import {logger} from '@/lib/util/logger';
import {isObject, readJsonBody} from '@/lib/util/request';

type SourceFile = {
  path: string;
  from: string; // "cold-storage" | peer address (may be the local peer's own address)
  size: number;
};

type CopyRequest = {
  files: SourceFile[];
  toColdStorage: boolean;
  toPeers: string[]; // peer addresses (may include the local peer's address)
  deleteAfterCopy: boolean;
  skip?: Array<{file: string; destination: string}>;
};

/** A root-relative path that stays inside its root. The storage refuses the
 *  rest as well; this answers 400 for it rather than 500. */
function isWithinRoot(file: string): boolean {
  return (
    file !== '' &&
    !file.startsWith('/') &&
    !file.split('/').some((seg) => seg === '..')
  );
}

/**
 * One file → one destination, as a storage job on the machine that holds the
 * bytes — this host never carries them, whoever the ends are.
 *
 * Cold storage is a mount shared across the peers, so a cold end always
 * pairs onto the other end's machine as a local copy job there — the same
 * placement the old to-local/from-local forwarding produced. Two different
 * machines' models roots are a send: the source machine streams straight to
 * the destination's agent.
 */
function legFor(
  file: string,
  from: string,
  dest: string,
): {runOn: string; spec: JobSpec; srcSite: Site; dstSite: Site} {
  if (from === 'cold-storage') {
    const peerStorage = storageForPeer(dest);
    return {
      runOn: dest,
      spec: {
        kind: 'copy',
        from: {root: 'cold', path: file},
        to: {root: 'models', path: file},
      },
      srcSite: {storage: peerStorage, root: 'cold'},
      dstSite: {storage: peerStorage, root: 'models'},
    };
  }
  if (dest === 'cold-storage') {
    const peerStorage = storageForPeer(from);
    return {
      runOn: from,
      spec: {
        kind: 'copy',
        from: {root: 'models', path: file},
        to: {root: 'cold', path: file},
      },
      srcSite: {storage: peerStorage, root: 'models'},
      dstSite: {storage: peerStorage, root: 'cold'},
    };
  }
  const target = agentTargetFor(dest);
  return {
    runOn: from,
    spec: {
      kind: 'send',
      from: {root: 'models', path: file},
      to: {
        agent: target.url,
        ...(target.token !== undefined ? {token: target.token} : {}),
        ref: {root: 'models', path: file},
      },
    },
    srcSite: {storage: storageForPeer(from), root: 'models'},
    dstSite: {storage: storageForPeer(dest), root: 'models'},
  };
}

export async function POST(req: Request) {
  const parsed = await readJsonBody<CopyRequest>(req, isObject);
  if (parsed instanceof Response) return parsed;
  const body = parsed;
  const {files, toColdStorage, toPeers, deleteAfterCopy} = body;

  if (
    !Array.isArray(files) ||
    files.some(
      (f) =>
        typeof f?.path !== 'string' ||
        typeof f?.from !== 'string' ||
        typeof f?.size !== 'number',
    )
  ) {
    return new Response('Invalid files', {status: 400});
  }

  // file+destination pairs the user chose not to overwrite (see /api/v1/copy/check).
  const skipSet = new Set(
    (body.skip ?? []).map((s) => `${s.file}\0${s.destination}`),
  );
  const shouldSkip = (file: string, dest: string) =>
    skipSet.has(`${file}\0${dest}`);

  // The local peer is just another peer address; "from"/"toPeers" use it for
  // local source/destination instead of a special "local" token.
  const localPeerAddr = localPeer?.address ?? '';

  if (toColdStorage && !coldStorageDir)
    return new Response('No cold storage configured', {status: 400});

  // Every host this run will drive comes from the request body (`toPeers`,
  // and each file's `from`) and ends up spoken to as an agent — so confine
  // them to configured peers. Otherwise a caller could aim this server, or a
  // peer's send, at an arbitrary host.
  const knownPeers = new Set(config.peers.map((p) => p.address));
  if (
    !Array.isArray(toPeers) ||
    toPeers.some((p) => typeof p !== 'string' || !knownPeers.has(p))
  ) {
    return new Response('Unknown peer', {status: 400});
  }
  if (files.some((f) => f.from !== 'cold-storage' && !knownPeers.has(f.from))) {
    return new Response('Unknown source', {status: 400});
  }
  if (toPeers.includes(localPeerAddr) && !localModelsDir)
    return new Response('No local storage configured', {status: 400});
  // Tiers of this host that sources name must exist here: the cold archive
  // is read as this host's own mount, and the local peer's models are local.
  if (files.some((f) => f.from === 'cold-storage') && !coldStorageDir)
    return new Response('No cold storage configured', {status: 400});
  if (files.some((f) => f.from === localPeerAddr) && !localModelsDir)
    return new Response('No local storage configured', {status: 400});

  // A model's support files (config.json, tokenizer, safetensors index) ride
  // along with its weights, resolved here rather than by the caller: the
  // weight scan only tracks weights, so no caller's selection can name them.
  // Doing it in the copy itself covers every route in — the UI (whose
  // pre-check expanded the same list already, so this finds nothing new),
  // `tj copy`, which skips that check by design, and the cold-storage
  // resume. Sources are the ones already validated above plus this host's
  // own tiers, so this opens no new host to talk to.
  const support = await resolveSupportFiles(
    files.map((f) => f.path),
    supportFileSources({
      froms: files.map((f) => f.from),
      localPeerAddr,
      siteFor: siteForName,
    }),
    {
      onError: (from, message) =>
        logger.warn(
          `[copy] support-file expansion failed for ${from}: ${message}`,
        ),
    },
  );
  const allFiles: SourceFile[] =
    support.length > 0 ? [...files, ...support] : files;

  for (const f of allFiles) {
    if (!isWithinRoot(f.path))
      return new Response('Invalid path', {status: 400});
  }

  const destinations = [...(toColdStorage ? ['cold-storage'] : []), ...toPeers];

  let filesTotal = 0;
  let bytesTotal = 0;
  for (const f of allFiles) {
    for (const dest of destinations) {
      if (dest === f.from || shouldSkip(f.path, dest)) continue;
      filesTotal++;
      bytesTotal += f.size;
    }
  }

  const enc = new TextEncoder();
  const abortController = new AbortController();

  // Abort in-flight transfers when the client disconnects. req.signal fires on
  // disconnect in Next.js/Bun, aborting the background copy loop.
  req.signal.addEventListener('abort', () => abortController.abort(), {
    once: true,
  });

  // Stream newline-delimited progress so the browser can render a live bar.
  // A TransformStream lets us await each write (back-pressure aware), which
  // guarantees the initial event flushes to the client instead of buffering.
  const {readable, writable} = new TransformStream();
  const writer = writable.getWriter();

  // Run the copy work in the background; the response streams `readable`.
  (async () => {
    const {signal} = abortController;
    let closed = false;
    const safeWrite = async (data: Uint8Array) => {
      if (closed) return;
      try {
        await writer.ready;
        await writer.write(data);
      } catch {
        closed = true;
        abortController.abort();
      }
    };
    const safeClose = async () => {
      if (!closed) {
        closed = true;
        try {
          await writer.close();
        } catch {
          /* already closed */
        }
      }
    };

    let filesDone = 0;
    let bytesDone = 0;
    let fileDone = 0;
    let fileTotal = 0;
    // Pre-copy verification state for the current file: while a partial
    // destination is being hash-compared against the source, phase is
    // 'verifying' and verifyDone/verifyTotal track the hashing; afterwards
    // `resume` records the outcome ('resumed' = prefix matched, 'from-start' =
    // SHA256 mismatch, null = no partial was found). All of it read straight
    // off the job's events now — the jobs report the same phases wherever
    // they run.
    let phase: 'verifying' | 'copying' = 'copying';
    let verifyDone = 0;
    let verifyTotal = 0;
    let resume: 'resumed' | 'from-start' | null = null;
    const resetFilePhase = () => {
      phase = 'copying';
      verifyDone = 0;
      verifyTotal = 0;
      resume = null;
    };

    // Per-(file, destination) failures are collected rather than aborting the
    // whole run: one unreachable peer or unreadable file shouldn't cancel the
    // copies to other destinations. They ride along in every progress frame's
    // `errors`, and the client surfaces them once the stream ends. Only a
    // client disconnect (signal.aborted) tears the whole stream down.
    const errors: string[] = [];

    // Files that reached cold storage (copied this run, or already there and
    // skipped), so the post-copy delete only removes sources that are safe.
    const coldDone = new Set<string>();

    const emit = () =>
      safeWrite(
        enc.encode(
          JSON.stringify({
            filesDone,
            filesTotal,
            fileDone,
            fileTotal,
            bytesDone,
            bytesTotal,
            phase,
            verifyDone,
            verifyTotal,
            resume,
            errors,
          }) + '\n',
        ),
      );

    const fail = (where: string, message: string) => {
      logger.error(`[copy] ${where}: ${message}`);
      errors.push(`${where}: ${message}`);
      emit();
    };

    await emit(); // initial event — awaited so the client receives the opening frame

    logger.info(
      `[copy] start: ${allFiles.length} file(s) → ${destinations.join(', ') || '(no destinations)'}`,
    );

    try {
      for (const dest of destinations) {
        for (const f of allFiles) {
          if (f.from === dest || shouldSkip(f.path, dest)) continue;
          signal.throwIfAborted();

          const leg = legFor(f.path, f.from, dest);
          fileTotal = f.size;
          fileDone = 0;
          resetFilePhase();
          await emit();

          try {
            logger.info(
              `[copy] ${f.from} → ${dest} (on ${leg.runOn}): ${f.path}`,
            );
            const job = await storageForPeer(leg.runOn).start(leg.spec);
            const cancel = () => void job.cancel();
            signal.addEventListener('abort', cancel, {once: true});
            let sawVerify = false;
            let result: CopyResult | null = null;
            try {
              for await (const event of job.events()) {
                if (event.kind === 'verify') {
                  phase = 'verifying';
                  sawVerify = true;
                  verifyDone = event.done;
                  verifyTotal = event.total;
                  emit();
                } else if (event.kind === 'progress') {
                  if (phase === 'verifying' || (sawVerify && resume === null)) {
                    phase = 'copying';
                    resume = event.done > 0 ? 'resumed' : 'from-start';
                  }
                  bytesDone += event.done - fileDone;
                  fileDone = event.done;
                  emit();
                } else if (event.kind === 'done') {
                  result = event.result as CopyResult;
                } else if (event.kind === 'error') {
                  throw new Error(event.message);
                }
              }
            } finally {
              signal.removeEventListener('abort', cancel);
            }
            if (result === null) throw new Error('job ended without a result');
            if (result.resumedFrom > 0 && result.resumedFrom < fileTotal) {
              logger.info(
                `[copy] resumed ${f.path} at ${result.resumedFrom}/${fileTotal} bytes`,
              );
            }

            // Bytes are down; carry the file's provenance so the destination
            // names and audits it without a re-hash. Best effort: a meta
            // failure is reported but the copy stands.
            try {
              await propagateFileMeta(leg.srcSite, leg.dstSite, f.path);
            } catch (err) {
              if (signal.aborted) throw err;
              fail(
                `meta ${f.from} → ${dest}: ${f.path}`,
                err instanceof Error ? err.message : String(err),
              );
            }

            filesDone++;
            fileDone = f.size;
            if (dest === 'cold-storage') coldDone.add(f.path);
            emit();
          } catch (err) {
            if (signal.aborted) throw err;
            fail(
              `${f.from} → ${dest}: ${f.path}`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }

      // Delete sources after a successful cold-storage copy — but only files
      // that actually reached cold storage this run, so a failed copy never
      // takes its source with it. (Skipped files were already present at the
      // destination, hence excluded here.) The delete is the same
      // sidecar-and-husk cleanup the delete API runs, local or remote alike.
      if (deleteAfterCopy && toColdStorage) {
        const bySource = new Map<string, SourceFile[]>();
        for (const f of allFiles) {
          if (f.from === 'cold-storage') continue;
          if (shouldSkip(f.path, 'cold-storage')) continue;
          if (!coldDone.has(f.path)) continue;
          if (!bySource.has(f.from)) bySource.set(f.from, []);
          bySource.get(f.from)!.push(f);
        }
        for (const [source, srcFiles] of bySource) {
          try {
            logger.info(
              `[copy] delete ${srcFiles.length} file(s) from ${source}`,
            );
            const peerStorage = storageForPeer(source);
            const deleted: string[] = [];
            for (const f of srcFiles) {
              signal.throwIfAborted();
              await deleteFileWithMeta(peerStorage, 'models', f.path);
              deleted.push(f.path);
            }
            // A model dir stripped of its last weight takes its support
            // files (config/tokenizer/…) with it — they belong to the
            // deleted weights.
            await cleanupWeightlessModelDirs(peerStorage, 'models', deleted);
          } catch (err) {
            if (signal.aborted) throw err;
            fail(
              `delete from ${source}`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }

      logger.info(
        `[copy] done: ${allFiles.length} file(s)${
          errors.length ? `, ${errors.length} failure(s)` : ''
        }`,
      );
      await emit(); // terminal frame — carries the final counters and full error list
      await safeClose();
    } catch (err) {
      if (signal.aborted) {
        logger.info(`[copy] cancelled: ${allFiles.length} file(s)`);
      } else {
        logger.error(`[copy] error:`, err);
      }
      await safeClose();
    }
  })();

  return new Response(readable, {
    headers: {'Content-Type': 'application/x-ndjson'},
  });
}
