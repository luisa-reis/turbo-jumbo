import type {Model} from '@/lib/models/model-types';
import type {AuditResult, AuditStatus} from '@/lib/audit/audit';

/** A file the audit will read, and how big it is. */
export interface AuditTarget {
  path: string;
  size: number;
  model: string;
}

/**
 * Every file of the models matching `pattern`, as storage-root-relative paths.
 *
 * The paths must come from the location being audited, not from the combined
 * models table: the same file sits at different paths on different hosts, and
 * `/api/v1/audit` resolves what it is given against its own storage root.
 */
export function auditTargets(models: Model[], pattern?: string): AuditTarget[] {
  const needle = pattern?.trim().toLowerCase();
  const out: AuditTarget[] = [];
  for (const m of models) {
    if (needle && !m.name.toLowerCase().includes(needle)) continue;
    for (const f of m.files) {
      if (f.isSplit) {
        for (const s of f.files)
          out.push({path: s.path, size: s.size, model: m.name});
      } else {
        out.push({path: f.path, size: f.size, model: m.name});
      }
    }
  }
  return out;
}

/**
 * Aggregate the audit's NDJSON events into overall progress.
 *
 * The stream interleaves three kinds of line and reports hashing per file, with
 * several files in flight at once (the server audits at a concurrency). Overall
 * progress is therefore the bytes of finished files plus however far each
 * in-flight file has got — which is why the total has to come from the caller's
 * own file list rather than from the stream.
 */
export function createAuditAggregator(targets: AuditTarget[]) {
  const sizeOf = new Map(targets.map((t) => [t.path, t.size]));
  const totalBytes = targets.reduce((s, t) => s + t.size, 0);
  const totalFiles = targets.length;
  const inFlight = new Map<string, number>();
  const doneBytes = new Map<string, number>();
  const results: AuditResult[] = [];

  return {
    /** Feed one parsed NDJSON line. Returns true if it was a final result. */
    push(event: Record<string, unknown>): boolean {
      const file = typeof event.file === 'string' ? event.file : '';
      if (typeof event.status === 'string') {
        results.push(event as unknown as AuditResult);
        // A finished file counts whole, whatever the last progress event said.
        // Its own size is the fallback: a verdict that needed no hashing —
        // `unverifiable`, `duplicate` — carries no computedSize, and counting
        // those as zero would leave the bar stuck short of 100%.
        const size =
          typeof event.computedSize === 'number'
            ? event.computedSize
            : (sizeOf.get(file) ?? inFlight.get(file) ?? 0);
        doneBytes.set(file, size);
        inFlight.delete(file);
        return true;
      }
      if (typeof event.hashedBytes === 'number') {
        inFlight.set(file, event.hashedBytes);
      }
      return false;
    },
    progress() {
      let bytes = 0;
      for (const v of doneBytes.values()) bytes += v;
      for (const v of inFlight.values()) bytes += v;
      return {
        filesDone: doneBytes.size,
        filesTotal: totalFiles,
        bytesDone: Math.min(bytes, totalBytes),
        bytesTotal: totalBytes,
        errors: [] as string[],
      };
    },
    results: () => results,
  };
}

/** Statuses that are not findings. Everything else needs a human to know. */
const CLEAN: ReadonlySet<AuditStatus> = new Set<AuditStatus>(['pass']);

export function findings(results: AuditResult[]): AuditResult[] {
  return results.filter((r) => !CLEAN.has(r.status));
}

/**
 * Whether the audit checked successfully and still found something.
 *
 * A predicate rather than an exit code: the entry point owns every code, so
 * this module doesn't need to know which number the outcome is spelled as.
 */
export function hasUnresolvedFindings(results: AuditResult[]): boolean {
  return findings(results).length > 0;
}

/** Fix outcomes that leave the file correct; anything else is still a problem. */
const REPAIRED: ReadonlySet<string> = new Set(['moved', 'deleted', 'kept']);

/**
 * The findings still standing once repairs have run.
 *
 * This, not the raw finding list, is what the exit code is built from: a run
 * that fixed everything it found leaves a correct machine, and
 * `tj audit --fix || alert` should not page anyone about a problem that no
 * longer exists.
 */
export function unresolvedFindings(
  found: AuditResult[],
  fixes: Array<{file: string; status: string}>,
): AuditResult[] {
  const byFile = new Map(fixes.map((f) => [f.file, f.status]));
  return found.filter((r) => !REPAIRED.has(byFile.get(r.file) ?? ''));
}

/** The findings `--fix` can relocate, and those needing `--allow-delete`. */
export function fixable(results: AuditResult[]) {
  return {
    misplaced: results
      .filter((r) => r.status === 'misplaced')
      .map((r) => r.file),
    duplicate: results
      .filter((r) => r.status === 'duplicate')
      .map((r) => r.file),
    // No automatic repair exists: a source has to be chosen for these.
    unfixable: results.filter(
      (r) =>
        r.status !== 'pass' &&
        r.status !== 'misplaced' &&
        r.status !== 'duplicate',
    ),
  };
}
