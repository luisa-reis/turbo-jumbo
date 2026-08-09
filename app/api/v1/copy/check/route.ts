import {config, localModelsDir, coldStorageDir, localPeer} from '@/lib/config';
import {
  resolveSupportFiles,
  supportFileSources,
} from '@/lib/storage/support-files';
import {recordedSha256} from '@/lib/storage/recorded-digest';
import {localSha256} from '@/lib/storage/file-transfer';
import {logger} from '@/lib/util/logger';
import {isObject, isStringArray, readJsonBody} from '@/lib/util/request';
import nodePath from 'path';
import {promises as fsp} from 'fs';

type SourceFile = {path: string; from: string; size: number};

/**
 * A peer's SHA256 for one of its files. With `recorded` the peer answers from
 * the file's sidecar and reads no bytes, returning null when it holds no
 * trustworthy record; without it the peer hashes the file then and there.
 *
 * It is the same digest of the same bytes either way, so a recorded answer
 * from one side compares directly against a computed one from the other, and
 * only the side that lacks a record has to pay for a read.
 *
 * null also covers a peer too old to answer in SHA256 at all — an undecided
 * pair is copied rather than wrongly called identical.
 */
async function peerSha256(
  peerAddr: string,
  file: string,
  opts: {recorded: boolean},
): Promise<string | null> {
  const recorded = opts.recorded ? '&recorded=1' : '';
  try {
    const res = await fetch(
      `http://${peerAddr}/api/v1/local-models/checksum?file=${encodeURIComponent(file)}${recorded}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {sha256?: string | null};
    return data.sha256 ?? null;
  } catch {
    return null;
  }
}

// Compare each selected file against what already exists at each destination
// (cold storage and/or peers), reporting size and digest matches so the UI can
// let the user choose what to overwrite before any bytes move.
//
// Streams newline-delimited JSON: a `progress` frame per file/destination pair
// examined, then one `result` frame carrying the conflicts and the expanded
// file list. Hashing a large model reads every byte through the slowest disk
// involved, so the client needs to see (and be able to abandon) the wait.
//
// Every digest here is a SHA256 of the file's bytes, whether it was recorded
// at download time or computed on the spot, so the two are interchangeable.
// A copy still matching its sidecar's recorded size and predating it answers
// from `tjmodel.json` and reads nothing — the common "already there,
// unchanged" case costs no I/O at all — and only a side with no trustworthy
// record is hashed.
export async function POST(req: Request) {
  const body = await readJsonBody<{
    files: SourceFile[];
    toColdStorage: boolean;
    toPeers: string[];
    hashFallback?: boolean;
  }>(req, isObject);
  if (body instanceof Response) return body;

  const {files, toColdStorage, toPeers} = body;
  // Whether a side no sidecar can vouch for may be settled by hashing it. On
  // by default, for the Copy button: a person asked for the comparison and is
  // watching it run. `tj copy` turns it off — it reads a file only to copy it,
  // so a pair it can't settle for free is copied instead of read to find out
  // it needn't be.
  const hashFallback = body.hashFallback !== false;
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
  if (!isStringArray(toPeers)) {
    return new Response('Invalid toPeers', {status: 400});
  }
  const localPeerAddr = localPeer?.address ?? '';
  const localBase = localModelsDir ? nodePath.resolve(localModelsDir) : '';
  const coldBase = coldStorageDir ? nodePath.resolve(coldStorageDir) : '';

  // Same up-front validation as /api/v1/copy, and for the same reason: every
  // host this talks to arrives in the request body (`toPeers`, and each file's
  // `from`) and is fetched as `http://<host>/…`, so an unconfined caller could
  // aim the server at an arbitrary host. Checking a file also reads it — a
  // SHA256 of any side with no trustworthy recorded digest — so the paths are
  // confined to their base too, or a local source could be made to hash a file
  // outside the model tree and report the digest back.
  const knownPeers = new Set(config.peers.map((p) => p.address));
  if (toPeers.some((p) => !knownPeers.has(p))) {
    return new Response('Unknown peer', {status: 400});
  }
  if (files.some((f) => f.from !== 'cold-storage' && !knownPeers.has(f.from))) {
    return new Response('Unknown source', {status: 400});
  }
  for (const f of files) {
    const base =
      f.from === 'cold-storage'
        ? coldBase
        : f.from === localPeerAddr
          ? localBase
          : null;
    if (base === null) continue; // a remote source resolves the path itself
    // An unconfigured tier has no base to confine against, and `resolve('', p)`
    // would land wherever the process happens to be running.
    if (!base) return new Response('Invalid path', {status: 400});
    if (!nodePath.resolve(base, f.path).startsWith(base + nodePath.sep)) {
      return new Response('Invalid path', {status: 400});
    }
  }

  // Expand the selected weight files with the support files sitting in the
  // same model directories (config.json, tokenizer files, a safetensors
  // index): the weight scan — and so the selection — only tracks weight
  // files, and a whole-repo model copied without its support files can't be
  // loaded. Every tier is asked, not just the one each weight file resolved
  // to, since an archived model's cold copy routinely holds the weights alone
  // (see resolveSupportFiles). The expanded list is both conflict-checked
  // below and returned, so the client sends the same list to /api/v1/copy.
  const expandedFiles: SourceFile[] = [
    ...files,
    ...(await resolveSupportFiles(
      files.map((f) => f.path),
      supportFileSources({
        froms: files.map((f) => f.from),
        coldBase,
        localBase,
        localPeerAddr,
      }),
      {
        onError: (from, message) =>
          logger.warn(
            `[check] support-file expansion failed for ${from}: ${message}`,
          ),
      },
    )),
  ];

  const conflicts: Array<{
    file: string;
    destination: string;
    sourceSize: number;
    destSize: number;
    sizeMatch: boolean;
    digest: 'sha256' | null;
    digestMatch: boolean | null;
    sourceDigest: string | null;
    destDigest: string | null;
  }> = [];

  const destinations = [...(toColdStorage ? ['cold-storage'] : []), ...toPeers];
  // The progress denominator: a file is never compared against the place it is
  // being copied from, so those pairs don't count.
  const pairsTotal = expandedFiles.reduce(
    (n, f) => n + destinations.filter((d) => d !== f.from).length,
    0,
  );

  const enc = new TextEncoder();
  const {readable, writable} = new TransformStream();
  const writer = writable.getWriter();

  // Examine the pairs in the background; the response streams `readable`.
  (async () => {
    let closed = false;
    const write = async (frame: unknown) => {
      if (closed) return;
      try {
        await writer.ready;
        await writer.write(enc.encode(JSON.stringify(frame) + '\n'));
      } catch {
        closed = true;
      }
    };
    let pairsDone = 0;

    for (const f of expandedFiles) {
      // A client that navigated away or hit Cancel: stop before starting the
      // next file rather than hashing on for nobody.
      if (req.signal.aborted) break;
      try {
        const {path: file, from, size: sourceSize} = f;

        // Both of the source's digests, resolved lazily and cached per file:
        // the recorded one costs a sidecar read (or a peer request), the
        // computed one costs a full read of the file.
        let sourceRecordedCache: string | null | undefined = undefined;
        const getSourceRecorded = async (): Promise<string | null> => {
          if (sourceRecordedCache !== undefined) return sourceRecordedCache;
          let result: string | null;
          if (from === 'cold-storage') {
            result = coldBase ? await recordedSha256(coldBase, file) : null;
          } else if (from === localPeerAddr) {
            result = localBase ? await recordedSha256(localBase, file) : null;
          } else {
            result = await peerSha256(from, file, {recorded: true});
          }
          sourceRecordedCache = result;
          return result;
        };

        let sourceComputedCache: string | null | undefined = undefined;
        const getSourceComputed = async (): Promise<string | null> => {
          if (sourceComputedCache !== undefined) return sourceComputedCache;
          // null base = the source is another peer, which hashes its own copy.
          const base =
            from === 'cold-storage'
              ? coldBase
              : from === localPeerAddr
                ? localBase
                : null;
          let result: string | null;
          if (base === null) {
            result = await peerSha256(from, file, {recorded: false});
          } else if (!base) {
            result = null; // that tier isn't configured on this host
          } else {
            try {
              result = await localSha256(
                nodePath.resolve(base, file),
                req.signal,
              );
            } catch {
              result = null; // unreadable, or the client gave up mid-hash
            }
          }
          sourceComputedCache = result;
          return result;
        };

        for (const destination of destinations) {
          if (destination === from) continue;
          if (req.signal.aborted) break;

          let destSize: number | null = null;
          let destRecordedFn: () => Promise<string | null>;
          let destComputedFn: () => Promise<string | null>;

          if (destination === 'cold-storage') {
            const destPath = nodePath.resolve(coldBase, file);
            if (!destPath.startsWith(coldBase + nodePath.sep)) continue;
            try {
              destSize = (await fsp.stat(destPath)).size;
            } catch {
              continue;
            }
            destRecordedFn = () => recordedSha256(coldBase, file);
            destComputedFn = async () => {
              try {
                return await localSha256(destPath, req.signal);
              } catch {
                return null;
              }
            };
          } else if (destination === localPeerAddr) {
            const destPath = nodePath.resolve(localBase, file);
            if (!destPath.startsWith(localBase + nodePath.sep)) continue;
            try {
              destSize = (await fsp.stat(destPath)).size;
            } catch {
              continue;
            }
            destRecordedFn = () => recordedSha256(localBase, file);
            destComputedFn = async () => {
              try {
                return await localSha256(destPath, req.signal);
              } catch {
                return null;
              }
            };
          } else {
            try {
              const headRes = await fetch(
                `http://${destination}/api/v1/local-models/download?file=${encodeURIComponent(file)}`,
                {method: 'HEAD'},
              );
              if (!headRes.ok) continue;
              destSize = parseInt(
                headRes.headers.get('content-length') ?? '0',
                10,
              );
            } catch {
              continue;
            }
            destRecordedFn = () =>
              peerSha256(destination, file, {recorded: true});
            destComputedFn = () =>
              peerSha256(destination, file, {recorded: false});
          }

          const sizeMatch = sourceSize === destSize;
          let digest: 'sha256' | null = null;
          let digestMatch: boolean | null = null;
          let sourceDigest: string | null = null;
          let destDigest: string | null = null;

          if (sizeMatch) {
            // Differing sizes already answer the question, so only same-size
            // pairs need a digest. Ask each side's sidecar first — that reads
            // no bytes — and hash only the side that couldn't answer. Both are
            // SHA256 of the same bytes, so a recorded digest compares directly
            // against a computed one and a single missing record costs one
            // read rather than two.
            [sourceDigest, destDigest] = await Promise.all([
              getSourceRecorded(),
              destRecordedFn(),
            ]);
            if ((!sourceDigest || !destDigest) && hashFallback) {
              await write({
                type: 'progress',
                done: pairsDone,
                total: pairsTotal,
                file,
                hashing: true,
              });
              [sourceDigest, destDigest] = await Promise.all([
                sourceDigest ?? getSourceComputed(),
                destDigest ?? destComputedFn(),
              ]);
            }
            if (sourceDigest && destDigest) {
              digest = 'sha256';
              digestMatch = sourceDigest === destDigest;
            }
            // Otherwise the pair is left undecided (digest null), and an
            // undecided file is not identical — the caller copies it rather
            // than reading it to find out it needn't have.
          }

          conflicts.push({
            file,
            destination,
            sourceSize,
            destSize: destSize ?? 0,
            sizeMatch,
            digest,
            digestMatch,
            sourceDigest,
            destDigest,
          });
          pairsDone++;
          await write({
            type: 'progress',
            done: pairsDone,
            total: pairsTotal,
            file,
            hashing: false,
          });
        }
      } catch {
        logger.debug(`[check] skipping file ${f.path}: not present`);
      }
    }

    if (!req.signal.aborted) {
      await write({type: 'result', conflicts, files: expandedFiles});
    }
    if (!closed) {
      try {
        await writer.close();
      } catch {
        /* already closed */
      }
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-store',
    },
  });
}
