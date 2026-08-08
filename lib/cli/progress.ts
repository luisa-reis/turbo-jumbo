import {
  parseProgress,
  parseSize,
  type DownloadProgress,
} from '@/lib/hf/download-output';
import {formatSize} from '@/lib/format/bytes';

/**
 * One shape for both transfer streams. `/api/v1/hf-download` emits redrawing
 * terminal text and `/api/v1/copy` emits newline-delimited JSON, but a progress
 * bar doesn't care which — so each is normalised here and rendered once.
 */
export interface TransferProgress {
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /** Bytes per second, when the stream reports it. */
  speed?: number;
  /** `/api/v1/copy` distinguishes verifying from copying. */
  phase?: string;
  /** Files that failed, named. Only the copy stream reports these. */
  errors: string[];
}

/**
 * Split a byte stream into complete lines across chunk boundaries. A chunk can
 * end mid-line, so a naive `split('\n')` per chunk silently drops or corrupts
 * whatever straddles the boundary — and for the copy stream that means a
 * half-JSON frame.
 */
export function createLineSplitter(separator = /\n/) {
  let buffered = '';
  return {
    push(chunk: string): string[] {
      buffered += chunk;
      const parts = buffered.split(separator);
      // The tail may be an incomplete line; hold it until more arrives.
      buffered = parts.pop() ?? '';
      return parts;
    },
    /** Whatever is left when the stream ends, if it isn't empty. */
    flush(): string[] {
      const rest = buffered;
      buffered = '';
      return rest ? [rest] : [];
    },
  };
}

/** Normalise `parseProgress`'s human-readable sizes into bytes. */
export function fromDownloadProgress(p: DownloadProgress): TransferProgress {
  return {
    filesDone: p.filesDone,
    filesTotal: p.filesTotal,
    bytesDone: parseSize(p.downloaded),
    bytesTotal: parseSize(p.total),
    speed: p.speed ? parseSize(p.speed.replace(/\/s$/, '')) : undefined,
    errors: [],
  };
}

/** A `/api/v1/copy` progress frame, or null for anything else on the stream. */
export function parseCopyFrame(line: string): TransferProgress | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const num = (k: string) => (typeof frame[k] === 'number' ? frame[k] : 0);
  return {
    filesDone: num('filesDone'),
    filesTotal: num('filesTotal'),
    bytesDone: num('bytesDone'),
    bytesTotal: num('bytesTotal'),
    phase: typeof frame.phase === 'string' ? frame.phase : undefined,
    errors: Array.isArray(frame.errors) ? frame.errors.map(String) : [],
  };
}

/**
 * Reads the `hf` download stream. Progress is redrawn with carriage returns
 * rather than newlines, so segments are split on either and the most recent
 * parseable one wins.
 */
export function createTextProgressReader() {
  const splitter = createLineSplitter(/[\r\n]/);
  let latest: TransferProgress | null = null;
  return {
    push(chunk: string): TransferProgress | null {
      const segments = splitter.push(chunk);
      const p = parseProgress(segments);
      if (p) latest = fromDownloadProgress(p);
      return latest;
    },
    latest: () => latest,
  };
}

/** Reads the `/api/v1/copy` frame stream. */
export function createJsonProgressReader() {
  const splitter = createLineSplitter();
  let latest: TransferProgress | null = null;
  return {
    push(chunk: string): TransferProgress | null {
      for (const line of splitter.push(chunk)) {
        const p = parseCopyFrame(line);
        if (p) latest = p;
      }
      return latest;
    },
    latest: () => latest,
  };
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${m}m${s % 60}s` : m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}

/** A redrawing progress bar, for a terminal. */
export function renderBar(
  p: TransferProgress,
  elapsedMs: number,
  width = 24,
): string {
  const frac = p.bytesTotal > 0 ? Math.min(1, p.bytesDone / p.bytesTotal) : 0;
  const filled = Math.round(frac * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const parts = [
    `${bar} ${String(Math.round(frac * 100)).padStart(3)}%`,
    `${formatSize(p.bytesDone)} / ${formatSize(p.bytesTotal)}`,
  ];
  if (p.filesTotal > 1) parts.push(`${p.filesDone}/${p.filesTotal} files`);
  if (p.speed) parts.push(`${formatSize(p.speed)}/s`);
  parts.push(formatDuration(elapsedMs));
  if (p.phase && p.phase !== 'copying') parts.push(p.phase);
  return parts.join('  ');
}

/**
 * Emits an occasional line instead of a redrawing bar — the redirected form,
 * where a bar would be thousands of useless lines in a log.
 *
 * A line goes out when the completed-file count advances, and also when the
 * byte percentage crosses a new decile. The second rule matters more than it
 * looks: a single-file transfer never reports a file count at all (the download
 * server only appends `(done/total files)` when there is more than one), so
 * counts alone would leave a multi-hour single-file download completely silent.
 *
 * Counts, not filenames: neither stream says which file is in flight, and a
 * name inferred from send order would sometimes be wrong (`/api/v1/copy` groups
 * files by source and destination). A true count beats a plausible name.
 */
export function createMilestoneEmitter(decile = 10) {
  let lastDone = -1;
  let lastBucket = -1;
  let lastLine = '';
  return (p: TransferProgress): string | null => {
    const pct =
      p.bytesTotal > 0 ? Math.floor((p.bytesDone / p.bytesTotal) * 100) : 0;
    const bucket = Math.floor(pct / decile);
    const filesAdvanced = p.filesDone > 0 && p.filesDone !== lastDone;
    const bytesAdvanced = bucket > lastBucket && p.bytesDone > 0;
    if (!filesAdvanced && !bytesAdvanced) return null;
    lastDone = p.filesDone;
    lastBucket = bucket;

    const files =
      p.filesTotal > 1 ? `${p.filesDone}/${p.filesTotal} files  ` : '';
    const line =
      `${files}${String(pct).padStart(3)}%  ` +
      `${formatSize(p.bytesDone)} / ${formatSize(p.bytesTotal)}`;
    // The last file finishing trips both rules at once — the closing decile and
    // the file count — which would otherwise print the same line twice.
    if (line === lastLine) return null;
    lastLine = line;
    return line;
  };
}
