import path from 'path';
import {localModelsDir, coldStorageDir} from '@/lib/config';
import {
  auditFile,
  metaPath,
  readMetaResolved,
  updateMetaResolved,
} from '@/lib/audit/audit';
import {describeExitCode} from '@/lib/hf/download-output';
import {
  isValidFilePath,
  isValidRepoId,
  isValidRevision,
} from '@/lib/hf/download-request';
import {repoFileSizes, resolveHfFileByPath} from '@/lib/hf/hf-infer';
import {repoIdFromModelUrl} from '@/lib/models/model-name';
import {
  clearMissingFlag,
  setModelRevision,
  modelDirForRepo,
  removeFileMeta,
} from '@/lib/models/model-sidecar';
import {fileSize} from '@/lib/storage/entries';
import {storage} from '@/lib/storage/storage-instance';
import type {Site} from '@/lib/storage/site';
import type {DownloadResult} from '@/lib/storage/storage';

// The two places a download touches, as sites of this server's storage.
const local: Site = {storage, root: 'models'};
const cold: Site = {storage, root: 'cold'};

/**
 * Record the HuggingFace source for each freshly-downloaded file: resolve its
 * size/checksum from the repo, then run the normal audit (which hashes the file
 * locally and writes the `.tjmeta.json` sidecar) so the model is verifiable —
 * and, being placed at <repoId>/<filePath>, passes — without a manual step.
 */
async function recordSources(
  repoId: string,
  branch: string,
  filePaths: string[],
  fileScope: string[] | undefined,
  signal: AbortSignal,
  enqueue: (s: string) => void,
): Promise<{failures: string[]}> {
  // Files that did not end up safely on disk (missing, or present but failing
  // verification). The caller uses this to refuse the cold-storage transfer.
  const failures: string[] = [];
  enqueue('\nRecording sources...\n');
  // Remember which branch/tag these files came from — and, for a deliberately
  // file-scoped download, which file set makes a complete copy — so every
  // later repo-tree comparison (repo file lists, incomplete/invalid checks,
  // audit resolution) judges the model against its own revision and scope
  // instead of main and the whole tree. Best-effort: a sidecar write failure
  // must not fail the download.
  try {
    await setModelRevision(local, repoId, repoId, branch, fileScope);
  } catch (e) {
    enqueue(
      `  could not record revision ${branch}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
  for (const fp of filePaths) {
    if (signal.aborted) return {failures};
    const relPath = `${repoId}/${fp}`;
    const hf = await resolveHfFileByPath(repoId, branch, fp);
    if (!hf) {
      // No HF source (a small non-LFS file): can't verify it, but if it's on
      // disk clear any `missing` flag a prior audit left so the model isn't
      // still reported incomplete. If it isn't on disk, the download failed.
      const size = await fileSize(storage, 'models', relPath);
      if (size === null) {
        failures.push(fp);
        enqueue(`  ${fp}: missing — not written to disk\n`);
        continue;
      }
      const cleared = await clearMissingFlag(local, repoId, fp, size);
      enqueue(
        `  ${fp}: ${cleared ? 'present — source unverifiable' : 'could not resolve source — left unverified'}\n`,
      );
      continue;
    }
    const result = await auditFile(
      local,
      relPath,
      '',
      path.basename(fp),
      signal,
      hf,
    );
    enqueue(`  ${fp}: ${result.status}\n`);
    // Only a verified-present file (or one we can't verify but is on disk) is
    // safe to carry onward; anything else means the download didn't land.
    if (result.status !== 'pass' && result.status !== 'unverifiable') {
      failures.push(fp);
    }
  }
  return {failures};
}

// Binary units (÷1024), no space — the compact form the progress line uses.
// parseSize (lib/hf/download-output) decodes these back for the progress bar.
function fmtBytes(b: number): string {
  if (b >= 1024 ** 4) return `${(b / 1024 ** 4).toFixed(1)}TiB`;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)}GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)}MiB`;
  return `${(b / 1024).toFixed(1)}KiB`;
}

function fmtTime(sec: number): string {
  const s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * How far a download has got, from the inventory of its directory: the bytes
 * on disk under it (hf's `.cache` staging included, since those are bytes
 * fetched), and how many of the expected files are already there at full
 * size — hf downloads to a temp path and moves a file into place only when it
 * finishes, so a file present at its final path at its expected size is done.
 * Files whose size is unknown can't be judged complete and are skipped. A
 * directory not there yet is zero of everything.
 */
async function downloadProgress(
  repoId: string,
  filePaths: string[],
  sizes: Map<string, number>,
): Promise<{bytes: number; filesDone: number}> {
  const entries = await storage.list('models', {under: repoId});
  let bytes = 0;
  const sizeAt = new Map<string, number>();
  for (const e of entries) {
    if (e.kind !== 'file') continue;
    bytes += e.size;
    sizeAt.set(e.path, e.size);
  }
  let filesDone = 0;
  for (const fp of filePaths) {
    const expected = sizes.get(fp);
    if (!expected || expected <= 0) continue;
    if ((sizeAt.get(`${repoId}/${fp}`) ?? 0) >= expected) filesDone++;
  }
  return {bytes, filesDone};
}

/** Whether an error is the filesystem saying "nothing there". */
const isMissing = (e: unknown) =>
  (e as NodeJS.ErrnoException | null)?.code === 'ENOENT';

async function moveToColdstorage(
  relPaths: string[],
  deleteAfterTransfer: boolean,
  enqueue: (s: string) => void,
): Promise<void> {
  const label = deleteAfterTransfer ? 'Moving' : 'Copying';
  enqueue(`\n${label} to cold storage...\n`);

  // Pre-compute sizes for the progress bar
  const sizes = new Map<string, number>();
  let total = 0;
  for (const rp of relPaths) {
    const size = await fileSize(storage, 'models', rp);
    if (size === null) throw new Error(`no file at ${rp}`);
    sizes.set(rp, size);
    total += size;
  }

  let done = 0;
  let lastPct = -1;
  const onBytes = (n: number) => {
    done += n;
    const pct = total > 0 ? Math.round((done / total) * 100) : 100;
    if (pct === lastPct) return;
    lastPct = pct;
    const filled = Math.round(pct / 5);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    enqueue(`\r[${bar}] ${pct}%  ${fmtBytes(done)} / ${fmtBytes(total)}`);
  };

  // Carry the file's provenance entry into the cold-storage model sidecar, and
  // drop it from the local one when the local copy is being removed.
  const transferMeta = async (rp: string, removeLocal: boolean) => {
    const meta = await readMetaResolved(local, rp);
    if (!meta) return;
    const repoId = repoIdFromModelUrl(meta.modelUrl);
    if (!repoId) return;
    await updateMetaResolved(cold, rp, repoId, meta);
    if (removeLocal) {
      const loc = modelDirForRepo(rp, repoId);
      if (loc) await removeFileMeta(local, loc.dir, loc.key);
    }
  };

  for (const rp of relPaths) {
    const from = {root: 'models' as const, path: rp};
    const to = {root: 'cold' as const, path: rp};
    // One job per file: a rename when the roots share a filesystem, else a
    // resumable stream with progress; with `move`, the source goes after.
    const job = await storage.start({
      kind: 'copy',
      from,
      to,
      move: deleteAfterTransfer,
    });
    let reported = 0;
    for await (const event of job.events()) {
      if (event.kind === 'progress') {
        onBytes(event.done - reported);
        reported = event.done;
      } else if (event.kind === 'error') {
        throw new Error(event.message);
      }
    }
    // The legacy `.tjmeta.json` sidecar travels alongside; absence is fine.
    const metaFrom = {root: 'models' as const, path: metaPath(rp)};
    const metaTo = {root: 'cold' as const, path: metaPath(rp)};
    try {
      if (deleteAfterTransfer) await storage.move(metaFrom, metaTo);
      else await storage.copy(metaFrom, metaTo);
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
    await transferMeta(rp, deleteAfterTransfer);
  }

  enqueue('\nDone.\n');
}

/**
 * Run an `hf download` on this machine and stream its terminal output. Shared by
 * the `/api/v1/hf-download` route and the peer download proxy's local branch.
 * Validates the request body (returning a 400 Response on bad input) before
 * starting the job — the storage validates again, on its own account. `signal`
 * cancels the job (SIGTERM to hf) when the client disconnects.
 */
export function streamHfDownload(body: unknown, signal: AbortSignal): Response {
  const {
    repoId,
    branch,
    filePaths,
    fileScope,
    sendToCold,
    deleteAfterTransfer,
  } = (body ?? {}) as {
    repoId?: unknown;
    branch?: unknown;
    filePaths?: unknown;
    fileScope?: unknown;
    sendToCold?: unknown;
    deleteAfterTransfer?: unknown;
  };

  if (!isValidRepoId(repoId))
    return new Response('Invalid repoId', {status: 400});
  if (!isValidRevision(branch))
    return new Response('Invalid branch', {status: 400});
  if (
    !Array.isArray(filePaths) ||
    filePaths.length === 0 ||
    !filePaths.every(isValidFilePath)
  )
    return new Response('Invalid filePaths', {status: 400});
  // Optional: the file set that makes a complete copy of this model (may be a
  // superset of filePaths when some files were already present). Same shape
  // rules as filePaths.
  if (
    fileScope !== undefined &&
    (!Array.isArray(fileScope) || !fileScope.every(isValidFilePath))
  )
    return new Response('Invalid fileScope', {status: 400});

  // A viewer has nowhere to put the files; its downloads run on the peers.
  if (!localModelsDir)
    return new Response('No local storage configured', {status: 400});

  // Download into <models>/<repoId> so files land at <repoId>/<filePath> — the
  // layout the audit expects — making them correctly placed and verifiable.
  // Storage-root-relative paths of the downloaded files, used for the sidecar
  // pass and the cold-storage transfer.
  const relPaths = filePaths.map((fp) => `${repoId}/${fp}`);
  const numFiles = filePaths.length;

  const encode = (s: string) => new TextEncoder().encode(s);

  const stream = new ReadableStream({
    start(controller) {
      const enqueue = (s: string) => controller.enqueue(encode(s));

      // hf --json prints no progress while downloading, so synthesize it: size
      // the bar from the repo's file sizes, then poll the inventory and emit a
      // `Downloading: NN% …` line (parsed by parseProgress) each tick — with a
      // `(done/total files)` suffix for a multi-file download, counting the files
      // already present at full size. Best-effort — if the repo can't be sized
      // (offline/rate-limited) we emit nothing and the client falls back to an
      // indeterminate bar.
      const t0 = Date.now();
      let totalBytes = 0;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      const stopPoll = () => {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
      };
      const filesSuffix = (done: number) =>
        numFiles > 1 ? `  (${done}/${numFiles} files)` : '';
      void (async () => {
        const sizes = await repoFileSizes(repoId, branch);
        if (!sizes || signal.aborted) return;
        totalBytes = filePaths.reduce(
          (sum, fp) => sum + (sizes.get(fp) ?? 0),
          0,
        );
        if (totalBytes <= 0) return;
        let lastDone = 0;
        let lastT = t0;
        pollTimer = setInterval(() => {
          void downloadProgress(repoId, filePaths, sizes).then(
            ({bytes, filesDone}) => {
              // The walk is async; if the run ended (stopPoll cleared the
              // timer) while it was in flight, the controller may be closed —
              // don't enqueue onto it.
              if (pollTimer === null) return;
              const done = Math.min(bytes, totalBytes);
              const now = Date.now();
              const dt = (now - lastT) / 1000;
              const speed = dt > 0 ? (done - lastDone) / dt : 0;
              lastDone = done;
              lastT = now;
              const pct = Math.min(99, Math.floor((done / totalBytes) * 100));
              const eta = speed > 0 ? (totalBytes - done) / speed : 0;
              enqueue(
                `\rDownloading: ${pct}% ${fmtBytes(done)}/${fmtBytes(totalBytes)}` +
                  ` [${fmtTime((now - t0) / 1000)}<${fmtTime(eta)}, ${fmtBytes(speed)}/s]` +
                  filesSuffix(filesDone),
              );
            },
          );
        }, 1000);
      })();

      void (async () => {
        let result: DownloadResult | null = null;
        try {
          const job = await storage.start({
            kind: 'download',
            repoId,
            revision: branch,
            files: filePaths,
            into: {root: 'models', path: repoId},
          });
          signal.addEventListener('abort', () => {
            stopPoll();
            void job.cancel();
          });
          // hf's stderr carries its errors/warnings, forwarded verbatim into
          // the log where parseNotices lifts them into the dialog's notices
          // panel; its stdout is the job's result, handled below.
          for await (const event of job.events()) {
            if (event.kind === 'log') enqueue(event.line);
            else if (event.kind === 'done')
              result = event.result as DownloadResult;
            else if (event.kind === 'error') throw new Error(event.message);
          }
        } catch (err) {
          stopPoll();
          enqueue(`\nError: ${(err as Error).message}\n`);
          controller.close();
          return;
        }
        stopPoll();
        const {exitCode: code, signal: sig, output} = result!;
        // hf's stdout should be exactly its `{"path": …}` result — the wrapper
        // already knows where files land, so it's consumed, not shown. Anything
        // else (unexpected non-JSON output) is surfaced so it isn't lost.
        const out = output.trim();
        if (out && !(out.startsWith('{') && out.endsWith('}')))
          enqueue(`\n${out}\n`);
        // Carry the bar to 100% — the poll caps at 99% and hf's silence means
        // nothing else would.
        if (code === 0 && totalBytes > 0) {
          const tb = fmtBytes(totalBytes);
          enqueue(
            `\rDownload complete: 100% ${tb}/${tb} [${fmtTime((Date.now() - t0) / 1000)}]${filesSuffix(numFiles)}\n`,
          );
        }
        enqueue(`\nProcess exited with code ${code}\n`);
        try {
          if (code !== 0) {
            const desc =
              code === null
                ? `hf was killed by ${sig ?? 'a signal'}`
                : `hf exited with code ${describeExitCode(code)}`;
            enqueue(`\nError: download failed (${desc}).\n`);
            return;
          }
          // Even on a 0 exit, verify the files actually landed and pass audit —
          // some failures (and the historical exit-code masking) can slip
          // through. A failed verification must not reach cold storage.
          const {failures} = await recordSources(
            repoId,
            branch,
            filePaths,
            fileScope as string[] | undefined,
            signal,
            enqueue,
          );
          if (failures.length > 0) {
            enqueue(
              `\nError: download failed — ${failures.length} file(s) did not download correctly: ${failures.join(', ')}.\n` +
                `Skipping cold storage.\n`,
            );
            return;
          }
          if (sendToCold && coldStorageDir) {
            await moveToColdstorage(relPaths, !!deleteAfterTransfer, enqueue);
          }
        } catch (err: unknown) {
          enqueue(`\nError: ${(err as Error).message}\n`);
        } finally {
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {'Content-Type': 'text/plain; charset=utf-8'},
  });
}
