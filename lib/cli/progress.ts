import {
  parseProgress,
  parseSize,
  type DownloadProgress,
} from '@/lib/hf/download-output';
import {formatSize, formatSpeed} from '@/lib/format/bytes';

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

/**
 * Bytes per second averaged over the whole run so far: what the transfer has
 * actually sustained end to end, rather than what it is managing this instant.
 *
 * It deliberately counts the stretches that moved no bytes — verifying a
 * partial destination, waiting on a slow peer, the gaps between files — which
 * is what makes it the number to judge "how long will the rest of this take"
 * by. A spot reading taken during a fast patch answers a question nobody asked.
 *
 * Null until there is something to divide.
 */
export function averageRate(
  bytesDone: number,
  elapsedMs: number,
): number | null {
  if (elapsedMs <= 0 || bytesDone <= 0) return null;
  return (bytesDone * 1000) / elapsedMs;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${m}m${s % 60}s` : m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}

/** Below this the bar stops being a bar; it would rather be narrow than gone. */
const MIN_BAR_WIDTH = 6;

/**
 * A redrawing progress bar, for a terminal.
 *
 * Pass `columns` when the terminal's width is known and the bar will shrink to
 * keep the whole line on one row. The readings are what the line is *for*, so
 * the bar is what gives way: a line that wraps is worse than a short bar,
 * because the carriage return that redraws it only reaches the last screen row
 * and strands every row above it.
 */
export function renderBar(
  p: TransferProgress,
  elapsedMs: number,
  opts: {width?: number; columns?: number} = {},
): string {
  const {width = 24, columns} = opts;
  const frac = p.bytesTotal > 0 ? Math.min(1, p.bytesDone / p.bytesTotal) : 0;

  const readings = [`${formatSize(p.bytesDone)} / ${formatSize(p.bytesTotal)}`];
  if (p.filesTotal > 1) readings.push(`${p.filesDone}/${p.filesTotal} files`);
  // Two different readings when the stream offers both: what it is doing now,
  // then what it has averaged since the start. The copy stream reports no
  // instantaneous speed at all, so the average is its only rate.
  if (p.speed) readings.push(formatSpeed(p.speed));
  const avg = averageRate(p.bytesDone, elapsedMs);
  if (avg !== null) readings.push(`${formatSpeed(avg)} avg`);
  readings.push(formatDuration(elapsedMs));
  if (p.phase && p.phase !== 'copying') readings.push(p.phase);

  const pct = `${String(Math.round(frac * 100)).padStart(3)}%`;
  const tail = readings.join('  ');
  // Everything the bar has to share the row with: ` ${pct}  ${tail}`.
  const fixed = 1 + pct.length + 2 + tail.length;
  const barWidth =
    columns && columns > 0
      ? Math.max(MIN_BAR_WIDTH, Math.min(width, columns - fixed))
      : width;

  const filled = Math.round(frac * barWidth);
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  return `${bar} ${pct}  ${tail}`;
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
  /** `elapsedMs` is optional: with a clock the line also carries the average
   *  rate, which is the number a log of a long transfer is read for. */
  return (p: TransferProgress, elapsedMs?: number): string | null => {
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
    // the file count — which would otherwise print the same line twice. The
    // rate is left out of that comparison: it moves every tick, so including it
    // would make every duplicate look new.
    if (line === lastLine) return null;
    lastLine = line;
    const avg =
      elapsedMs === undefined ? null : averageRate(p.bytesDone, elapsedMs);
    return avg === null ? line : `${line}  ${formatSpeed(avg)} avg`;
  };
}
