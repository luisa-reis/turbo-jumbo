import {CliError, type Client} from '@/cli/client';
import {hasDownloadFailure, parseNotices} from '@/lib/hf/download-output';
import {
  checkStatusLabel,
  readCheckStream,
  skipListFor,
  type ConflictItem,
} from '@/lib/storage/check-progress';
import type {SourceFile} from '@/lib/copy/source-files';
import {
  averageRate,
  createJsonProgressReader,
  createMilestoneEmitter,
  createTextProgressReader,
  formatDuration,
  renderBar,
  type TransferProgress,
} from '@/lib/cli/progress';
import {formatSize, formatSpeed} from '@/lib/format/bytes';

export interface TransferResult {
  progress: TransferProgress | null;
  /** Named failures, from the copy stream's errors or the download log. */
  errors: string[];
  elapsedMs: number;
  /** How many files the request asked for; the streams don't always say. */
  expectedFiles: number;
}

export interface TransferOptions {
  client: Client;
  path: string;
  body: unknown;
  /** Which stream this endpoint speaks. */
  format: 'text' | 'json';
  /** Live rendering: a bar on a terminal, milestone lines when redirected. */
  showProgress: boolean;
  isTty: boolean;
  write: (s: string) => void;
  /** File count from the request, for the summary when the stream omits it. */
  expectedFiles: number;
}

/**
 * POST a transfer request and consume its progress stream to the end.
 *
 * The two transfer endpoints speak different streams (see `lib/cli/progress`),
 * so the reader differs but everything downstream — rendering, failure
 * detection, the summary — is shared.
 */
export async function runTransfer(
  opts: TransferOptions,
): Promise<TransferResult> {
  const {
    client,
    path,
    body,
    format,
    showProgress,
    isTty,
    write,
    expectedFiles,
  } = opts;
  const started = Date.now();

  let res: Response;
  try {
    res = await fetch(`${client.baseUrl}${path}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new CliError(
      `Cannot reach the Turbo Jumbo server at ${client.baseUrl} ` +
        `(${e instanceof Error ? e.message : String(e)}).`,
    );
  }
  if (!res.ok || !res.body) {
    const text = (await res.text().catch(() => '')).trim();
    throw new CliError(
      `${path} returned ${res.status} ${res.statusText}${text ? `: ${text}` : ''}`,
    );
  }

  const reader =
    format === 'text' ? createTextProgressReader() : createJsonProgressReader();
  const milestone = createMilestoneEmitter();
  const decoder = new TextDecoder();
  const stream = res.body.getReader();
  // The download stream's failures and warnings are in its text, not a field.
  let raw = '';
  let barDrawn = false;

  for (;;) {
    const {done, value} = await stream.read();
    if (done) break;
    const chunk = decoder.decode(value, {stream: true});
    if (format === 'text') raw += chunk;

    const p = reader.push(chunk);
    if (!p || !showProgress) continue;

    if (isTty) {
      write(
        `\r${renderBar(p, Date.now() - started, {
          columns: process.stdout.columns,
        })}`,
      );
      barDrawn = true;
    } else {
      const line = milestone(p, Date.now() - started);
      if (line) write(`${line}\n`);
    }
  }

  // Leave the cursor on a clean line so the summary doesn't land on the bar.
  if (barDrawn) write('\n');

  const progress = reader.latest();
  const errors =
    format === 'json'
      ? (progress?.errors ?? [])
      : hasDownloadFailure(raw.split(/[\r\n]/))
        ? parseNotices(raw.split(/[\r\n]/))
            .filter((n) => n.severity === 'error')
            .map((n) => n.text)
        : [];

  return {progress, errors, elapsedMs: Date.now() - started, expectedFiles};
}

export interface ConflictCheck {
  /** The copy's file list, expanded by the server with the model's support files. */
  files: SourceFile[];
  /** (file, destination) pairs already byte-identical at the destination. */
  skip: Array<{file: string; destination: string}>;
}

/**
 * Ask `/api/v1/copy/check` what is already at the destination, and turn its
 * answer into the copy's skip list.
 *
 * This is the same call and the same default the Copy button uses: anything
 * byte-identical is left alone, anything that differs is copied over. The
 * button can offer that as a choice and a command cannot, but the default is
 * the interesting part — without it a copy re-sends files that are already
 * there, and only a copy within one machine can resume its way out of that
 * (a peer upload always starts at byte zero).
 *
 * It runs with `hashFallback: false`, so it only ever answers from the SHA256s
 * the sidecars already record and never reads a file to compare it. Skipping
 * exists to save a transfer; a check that read both copies of every file to
 * decide would cost more than the transfer it saves, and would make `tj copy`
 * slower than not skipping at all. A pair it cannot settle for free is simply
 * copied.
 */
export async function runConflictCheck(opts: {
  client: Client;
  body: {files: SourceFile[]; toColdStorage: boolean; toPeers: string[]};
  showProgress: boolean;
  isTty: boolean;
  write: (s: string) => void;
}): Promise<ConflictCheck> {
  const {client, body, showProgress, isTty, write} = opts;
  const path = '/api/v1/copy/check';

  let res: Response;
  try {
    res = await fetch(`${client.baseUrl}${path}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({...body, hashFallback: false}),
    });
  } catch (e) {
    throw new CliError(
      `Cannot reach the Turbo Jumbo server at ${client.baseUrl} ` +
        `(${e instanceof Error ? e.message : String(e)}).`,
    );
  }
  if (!res.ok || !res.body) {
    const text = (await res.text().catch(() => '')).trim();
    throw new CliError(
      `${path} returned ${res.status} ${res.statusText}${text ? `: ${text}` : ''}`,
    );
  }

  let drew = false;
  const result = await readCheckStream<ConflictItem, SourceFile>(res, (p) => {
    if (!showProgress || !isTty) return;
    write(`\r${checkStatusLabel(p)}`);
    drew = true;
  });
  // Wipe the status line so the copy's own bar starts on clean ground.
  if (drew) write('\r\x1b[K');

  // No result frame means the stream ended early. The Copy button treats that
  // as "don't copy", and so does this: a copy that silently forgot its skip
  // list would re-send everything.
  if (!result) {
    throw new CliError(
      'The pre-copy check ended without a result; nothing was copied.',
    );
  }

  return {files: result.files, skip: skipListFor(result.conflicts)};
}

/**
 * The closing line: what moved, how much, how long.
 *
 * The file count comes from the request rather than the stream, because a
 * single-file transfer reports no count at all — the summary would otherwise
 * read "? files" for the commonest case there is.
 */
export function summarise(verb: string, result: TransferResult): string {
  const p = result.progress;
  const done = p && p.filesDone > 0 ? p.filesDone : result.expectedFiles;
  const files = `${done}/${result.expectedFiles}`;
  const bytes = p ? formatSize(p.bytesDone) : '0 B';
  // What the whole run averaged, the figure worth carrying to the next one.
  const avg = averageRate(p?.bytesDone ?? 0, result.elapsedMs);
  return (
    `${verb} ${files} files · ${bytes} · ${formatDuration(result.elapsedMs)}` +
    (avg === null ? '' : ` · ${formatSpeed(avg)} avg`)
  );
}
