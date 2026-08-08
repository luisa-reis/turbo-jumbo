import {CliError, type Client} from '@/cli/client';
import {hasDownloadFailure, parseNotices} from '@/lib/hf/download-output';
import {
  createJsonProgressReader,
  createMilestoneEmitter,
  createTextProgressReader,
  formatDuration,
  renderBar,
  type TransferProgress,
} from '@/lib/cli/progress';
import {formatSize} from '@/lib/format/bytes';

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
      write(`\r${renderBar(p, Date.now() - started)}`);
      barDrawn = true;
    } else {
      const line = milestone(p);
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
  return `${verb} ${files} files · ${bytes} · ${formatDuration(result.elapsedMs)}`;
}
