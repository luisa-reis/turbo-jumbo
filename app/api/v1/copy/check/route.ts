import {config, localPeer} from '@/lib/config';
import {fileSize} from '@/lib/storage/entries';
import {siteForName} from '@/lib/storage/peer-storage';
import {recordedSha256} from '@/lib/storage/recorded-digest';
import {siteStorage} from '@/lib/storage/site';
import {
  resolveSupportFiles,
  supportFileSources,
} from '@/lib/storage/support-files';
import {logger} from '@/lib/util/logger';
import {isObject, isStringArray, readJsonBody} from '@/lib/util/request';

type SourceFile = {path: string; from: string; size: number};

/** A root-relative path that stays inside its root. The storage refuses the
 *  rest as well; this answers 400 for it rather than 500. */
function isWithinRoot(file: string): boolean {
  return (
    file !== '' &&
    !file.startsWith('/') &&
    !file.split('/').some((seg) => seg === '..')
  );
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
// Every side is a storage site now — this host's own tiers, or a peer's
// storage over the wire — so sizes come from one inventory entry, recorded
// digests from the sidecars wherever they sit, and a computed digest from the
// hash verb of whichever machine holds the file. A copy still matching its
// sidecar's recorded size and predating it answers from `tjmodel.json` and
// reads nothing; only a side with no trustworthy record is hashed, and only
// when `hashFallback` allows it (`tj copy` turns it off — a pair it can't
// settle for free is copied instead of read to find out it needn't be).
export async function POST(req: Request) {
  const body = await readJsonBody<{
    files: SourceFile[];
    toColdStorage: boolean;
    toPeers: string[];
    hashFallback?: boolean;
  }>(req, isObject);
  if (body instanceof Response) return body;

  const {files, toColdStorage, toPeers} = body;
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

  // Same up-front validation as /api/v1/copy, and for the same reason: every
  // host this talks to arrives in the request body and gets spoken to as an
  // agent. Checking a file can also read it — a SHA256 of a side with no
  // trustworthy recorded digest — so the paths are confined to their roots
  // too, and a tier this host hasn't configured refuses rather than
  // resolving against nothing.
  const knownPeers = new Set(config.peers.map((p) => p.address));
  if (toPeers.some((p) => !knownPeers.has(p))) {
    return new Response('Unknown peer', {status: 400});
  }
  if (files.some((f) => f.from !== 'cold-storage' && !knownPeers.has(f.from))) {
    return new Response('Unknown source', {status: 400});
  }
  for (const f of files) {
    if (!isWithinRoot(f.path))
      return new Response('Invalid path', {status: 400});
    if (
      (f.from === 'cold-storage' || f.from === localPeerAddr) &&
      !siteForName(f.from)
    ) {
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
        localPeerAddr,
        siteFor: siteForName,
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
        const srcSite = siteForName(from);

        // Both of the source's digests, resolved lazily and cached per file:
        // the recorded one costs sidecar reads (local or over the wire), the
        // computed one costs a full read of the file on its own machine.
        let sourceRecordedCache: string | null | undefined = undefined;
        const getSourceRecorded = async (): Promise<string | null> => {
          if (sourceRecordedCache !== undefined) return sourceRecordedCache;
          sourceRecordedCache = srcSite
            ? await recordedSha256(srcSite, file)
            : null;
          return sourceRecordedCache;
        };

        let sourceComputedCache: string | null | undefined = undefined;
        const getSourceComputed = async (): Promise<string | null> => {
          if (sourceComputedCache !== undefined) return sourceComputedCache;
          if (!srcSite) {
            sourceComputedCache = null;
            return null;
          }
          const {storage, root} = siteStorage(srcSite);
          try {
            sourceComputedCache = await storage.hash(
              {root, path: file},
              {signal: req.signal},
            );
          } catch {
            sourceComputedCache = null; // unreadable, or the client gave up
          }
          return sourceComputedCache;
        };

        for (const destination of destinations) {
          if (destination === from) continue;
          if (req.signal.aborted) break;

          const destSite = siteForName(destination);
          if (!destSite) continue; // a tier this host has not configured
          const {storage: destStorage, root: destRoot} = siteStorage(destSite);

          let destSize: number | null;
          try {
            destSize = await fileSize(destStorage, destRoot, file);
          } catch {
            continue; // the machine holding that side is unreachable
          }
          if (destSize === null) continue; // nothing at the destination

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
              recordedSha256(destSite, file),
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
                destDigest ??
                  destStorage
                    .hash({root: destRoot, path: file}, {signal: req.signal})
                    .catch(() => null),
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
            destSize,
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
