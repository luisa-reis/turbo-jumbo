import type {
  AuditProgressEvent,
  AuditResult,
  AuditStatus,
  UpdateResult,
} from '@/lib/audit/audit';
import {shardSetPaths} from '@/lib/hf/hf-download';

// Ordering for aggregating a row's verdicts: the row shows its worst one.
const AUDIT_SEVERITY: Record<AuditStatus, number> = {
  error: 6,
  'checksum-mismatch': 5,
  incomplete: 4,
  duplicate: 3,
  misplaced: 2,
  unverifiable: 1,
  pass: 0,
};

export type RowAudit =
  | {kind: 'pending'; percent?: number; queued?: boolean}
  | {kind: 'result'; status: AuditStatus; message?: string; cached: boolean}
  | null;

/**
 * The audit state a table row displays for its paths: null when none were
 * audited, the worst verdict when all results are in, otherwise pending — with
 * the row's SHA256 hashing percent when any of its files reported progress
 * (summed across in-flight paths, so multi-shard rows show one number).
 * During a live run, in-flight signals (progress, the started-set the server
 * streams) override *cached* verdicts — the run pre-seeds rows with their
 * sidecar state, which must give way as each file's turn comes — but never a
 * fresh verdict. While the run serializes files (cold storage audits one at a
 * time), a row none of whose files has started and with no verdict at all is
 * `queued`; a row with a cached verdict keeps showing it until it starts.
 */
export function rowAudit(
  paths: string[],
  auditedPaths: Set<string>,
  auditResults: Map<string, AuditResult>,
  auditing: boolean,
  auditProgress?: Map<string, AuditProgressEvent>,
  auditStarted?: Set<string>,
): RowAudit {
  const relevant = paths.filter((p) => auditedPaths.has(p));
  if (relevant.length === 0) return null;
  const results = relevant
    .map((p) => auditResults.get(p))
    .filter((r): r is AuditResult => r != null);

  if (auditing) {
    // Paths with no fresh verdict yet — a cached one doesn't finish a path.
    const unfinished = relevant.filter((p) => {
      const r = auditResults.get(p);
      return r == null || r.cached === true;
    });
    let hashed = 0;
    let total = 0;
    for (const p of unfinished) {
      const prog = auditProgress?.get(p);
      if (prog) {
        hashed += prog.hashedBytes;
        total += prog.totalBytes;
      }
    }
    if (total > 0) {
      return {kind: 'pending', percent: Math.floor((hashed / total) * 100)};
    }
    if (unfinished.some((p) => auditStarted?.has(p))) {
      return {kind: 'pending'};
    }
  }

  if (results.length === 0 || (results.length < relevant.length && auditing)) {
    // Queued only makes sense while the run is live; a run that ended without
    // this row's verdict (e.g. aborted) falls back to plain pending.
    const queued =
      auditing &&
      auditStarted != null &&
      results.length === 0 &&
      relevant.every((p) => !auditStarted.has(p));
    return queued ? {kind: 'pending', queued: true} : {kind: 'pending'};
  }
  const worst = results.reduce((a, b) =>
    AUDIT_SEVERITY[b.status] > AUDIT_SEVERITY[a.status] ? b : a,
  );
  return {
    kind: 'result',
    status: worst.status,
    message: worst.message,
    cached: !!worst.cached,
  };
}

/**
 * The verdicts a row should display for files that belong to it but aren't on
 * disk — the synthetic `incomplete` results the audit streams for a missing
 * projector, an un-downloaded expected file, or a gap in a shard set. They key
 * at the path the file belongs at, so nothing in the row's own `paths` claims
 * them:
 *
 *  - a model row (depth 0) takes everything keyed under its repo directory;
 *  - a split quant row takes the absent members of its own shard set, so the
 *    hovercard's download action survives expanding the model.
 *
 * `resultPaths` are the keys of the current audit results.
 */
export function companionPaths(
  row: {depth: number; key: string; paths: string[]; missingIndices: number[]},
  resultPaths: Iterable<string>,
): string[] {
  const keys = [...resultPaths];
  if (row.depth === 0) {
    return keys.filter(
      (p) => p.startsWith(row.key + '/') && !row.paths.includes(p),
    );
  }
  if (row.missingIndices.length === 0 || row.paths.length === 0) return [];
  const shard = row.paths[0].split('/').pop() ?? '';
  return shardSetPaths(
    keys.map((path) => ({path})),
    shard,
  ).filter((p) => !row.paths.includes(p));
}

/**
 * The failures in a row's hovercard that a re-download can recover: files that
 * are absent or only partly transferred. A file flagged only because its split
 * set has a gap (`shardGap`) is not one of them — the file itself is intact,
 * and it's the *missing* shards, listed alongside it, that need fetching.
 */
export function redownloadableFailures(failures: AuditResult[]): AuditResult[] {
  return failures.filter((f) => f.status === 'incomplete' && !f.shardGap);
}

/**
 * The order a row's hovercard lists its failures in: files flagged only for a
 * gap in their shard set go last. They carry no action of their own, while the
 * absent shard that fixes them does — and the list scrolls, so with a few
 * intact shards ahead of it, its download button sat below the fold, unseen.
 * Otherwise the order is kept.
 */
export function hovercardOrder(failures: AuditResult[]): AuditResult[] {
  return [
    ...failures.filter((f) => !f.shardGap),
    ...failures.filter((f) => f.shardGap),
  ];
}

/**
 * The "update available" results for a table row: the entries among the row's
 * paths whose update check came back `update`. Empty when no check has run or
 * none are behind. Mirrors `rowAudit`'s per-row aggregation so the table can
 * show one marker for a multi-shard row.
 */
export function rowUpdates(
  paths: string[],
  updateResults?: Map<string, UpdateResult>,
): UpdateResult[] {
  if (!updateResults) return [];
  return paths
    .map((p) => updateResults.get(p))
    .filter((r): r is UpdateResult => r?.status === 'update');
}
