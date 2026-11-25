import {test, expect} from 'bun:test';
import {
  companionPaths,
  updateDownload,
  hovercardOrder,
  redownloadableFailures,
  rowAudit,
  rowUpdates,
} from '@/lib/audit/row-audit';
import type {
  AuditProgressEvent,
  AuditResult,
  UpdateResult,
} from '@/lib/audit/audit';

const result = (file: string, status: AuditResult['status']): AuditResult => ({
  file,
  status,
});

test('null when none of the row paths were audited', () => {
  expect(rowAudit(['a.gguf'], new Set(), new Map(), false)).toBeNull();
});

test('aggregates results to the worst severity', () => {
  const audit = rowAudit(
    ['a.gguf', 'b.gguf'],
    new Set(['a.gguf', 'b.gguf']),
    new Map([
      ['a.gguf', result('a.gguf', 'pass')],
      ['b.gguf', result('b.gguf', 'checksum-mismatch')],
    ]),
    false,
  );
  expect(audit).toEqual({
    kind: 'result',
    status: 'checksum-mismatch',
    message: undefined,
    cached: false,
  });
});

test('pending without percent while no hashing progress is known', () => {
  expect(rowAudit(['a.gguf'], new Set(['a.gguf']), new Map(), true)).toEqual({
    kind: 'pending',
  });
});

test('pending carries the hashing percent when progress is known', () => {
  const progress = new Map<string, AuditProgressEvent>([
    ['a.gguf', {file: 'a.gguf', hashedBytes: 42, totalBytes: 100}],
  ]);
  expect(
    rowAudit(['a.gguf'], new Set(['a.gguf']), new Map(), true, progress),
  ).toEqual({kind: 'pending', percent: 42});
});

test('percent spans all in-flight paths of the row (multi-shard)', () => {
  // Two shards hashing: 50 of 100 and 25 of 100 → 75 of 200 → 37%.
  const progress = new Map<string, AuditProgressEvent>([
    ['s1.gguf', {file: 's1.gguf', hashedBytes: 50, totalBytes: 100}],
    ['s2.gguf', {file: 's2.gguf', hashedBytes: 25, totalBytes: 100}],
  ]);
  expect(
    rowAudit(
      ['s1.gguf', 's2.gguf'],
      new Set(['s1.gguf', 's2.gguf']),
      new Map(),
      true,
      progress,
    ),
  ).toEqual({kind: 'pending', percent: 37});
});

test('pending is queued while none of the row files has started', () => {
  expect(
    rowAudit(
      ['a.gguf'],
      new Set(['a.gguf']),
      new Map(),
      true,
      undefined,
      new Set(), // a started-set was provided, but a.gguf is not in it
    ),
  ).toEqual({kind: 'pending', queued: true});
});

test('a started file is pending without the queued marker', () => {
  expect(
    rowAudit(
      ['a.gguf'],
      new Set(['a.gguf']),
      new Map(),
      true,
      undefined,
      new Set(['a.gguf']),
    ),
  ).toEqual({kind: 'pending'});
});

test('hashing progress wins over the queued marker', () => {
  const progress = new Map<string, AuditProgressEvent>([
    ['a.gguf', {file: 'a.gguf', hashedBytes: 42, totalBytes: 100}],
  ]);
  expect(
    rowAudit(
      ['a.gguf'],
      new Set(['a.gguf']),
      new Map(),
      true,
      progress,
      new Set(),
    ),
  ).toEqual({kind: 'pending', percent: 42});
});

test('a multi-shard row leaves queued once any shard starts', () => {
  expect(
    rowAudit(
      ['s1.gguf', 's2.gguf'],
      new Set(['s1.gguf', 's2.gguf']),
      new Map(),
      true,
      undefined,
      new Set(['s1.gguf']),
    ),
  ).toEqual({kind: 'pending'});
});

test('queued never shows after the run has ended (aborted run)', () => {
  expect(
    rowAudit(
      ['a.gguf'],
      new Set(['a.gguf']),
      new Map(),
      false, // not auditing — the run ended without this file's verdict
      undefined,
      new Set(),
    ),
  ).toEqual({kind: 'pending'});
});

test('without a started-set the queued marker never appears', () => {
  expect(rowAudit(['a.gguf'], new Set(['a.gguf']), new Map(), true)).toEqual({
    kind: 'pending',
  });
});

const cachedPass = (file: string): AuditResult => ({
  file,
  status: 'pass',
  cached: true,
});

test('hashing progress overrides a cached verdict during a run', () => {
  const progress = new Map<string, AuditProgressEvent>([
    ['a.gguf', {file: 'a.gguf', hashedBytes: 42, totalBytes: 100}],
  ]);
  expect(
    rowAudit(
      ['a.gguf'],
      new Set(['a.gguf']),
      new Map([['a.gguf', cachedPass('a.gguf')]]),
      true,
      progress,
      new Set(['a.gguf']),
    ),
  ).toEqual({kind: 'pending', percent: 42});
});

test('a started file shows pending over its cached verdict', () => {
  expect(
    rowAudit(
      ['a.gguf'],
      new Set(['a.gguf']),
      new Map([['a.gguf', cachedPass('a.gguf')]]),
      true,
      undefined,
      new Set(['a.gguf']),
    ),
  ).toEqual({kind: 'pending'});
});

test('a cached verdict shows until the file starts (no queued marker)', () => {
  expect(
    rowAudit(
      ['a.gguf'],
      new Set(['a.gguf']),
      new Map([['a.gguf', cachedPass('a.gguf')]]),
      true,
      undefined,
      new Set(), // run live, file not started — its cached verdict still shows
    ),
  ).toEqual({kind: 'result', status: 'pass', message: undefined, cached: true});
});

test('a fresh verdict is never overridden by leftover run signals', () => {
  expect(
    rowAudit(
      ['a.gguf'],
      new Set(['a.gguf']),
      new Map([['a.gguf', {file: 'a.gguf', status: 'pass'}]]),
      true,
      undefined,
      new Set(['a.gguf']), // started, and since then freshly verdicted
    ),
  ).toEqual({
    kind: 'result',
    status: 'pass',
    message: undefined,
    cached: false,
  });
});

test('cached verdicts stay put when no run is active', () => {
  expect(
    rowAudit(
      ['a.gguf'],
      new Set(['a.gguf']),
      new Map([['a.gguf', cachedPass('a.gguf')]]),
      false,
    ),
  ).toEqual({kind: 'result', status: 'pass', message: undefined, cached: true});
});

test('ignores progress of paths that do not belong to the row', () => {
  const progress = new Map<string, AuditProgressEvent>([
    ['other.gguf', {file: 'other.gguf', hashedBytes: 99, totalBytes: 100}],
  ]);
  expect(
    rowAudit(['a.gguf'], new Set(['a.gguf']), new Map(), true, progress),
  ).toEqual({kind: 'pending'});
});

const upd = (file: string, status: UpdateResult['status']): UpdateResult => ({
  file,
  status,
});

test('rowUpdates returns only the update-status results for the row paths', () => {
  const map = new Map<string, UpdateResult>([
    ['a.gguf', upd('a.gguf', 'update')],
    ['b.gguf', upd('b.gguf', 'current')],
    ['c.gguf', upd('c.gguf', 'unknown')],
  ]);
  const result = rowUpdates(['a.gguf', 'b.gguf', 'c.gguf'], map);
  expect(result).toEqual([upd('a.gguf', 'update')]);
});

test('rowUpdates ignores paths not in the row and is empty without a map', () => {
  const map = new Map<string, UpdateResult>([
    ['a.gguf', upd('a.gguf', 'update')],
  ]);
  expect(rowUpdates(['b.gguf'], map)).toEqual([]);
  expect(rowUpdates(['a.gguf'], undefined)).toEqual([]);
});

const REPO = 'unsloth/Split-Test-GGUF';
const shardPath = (i: number) =>
  `${REPO}/UD-IQ3_S/Split-Test-UD-IQ3_S-0000${i}-of-00004.gguf`;

test('companionPaths gives a model row the verdicts of files it lacks', () => {
  const row = {depth: 0, key: REPO, paths: [shardPath(1)], missingIndices: []};
  const keys = [shardPath(1), shardPath(2), `${REPO}/mmproj-F16.gguf`];
  expect(companionPaths(row, keys)).toEqual([
    shardPath(2),
    `${REPO}/mmproj-F16.gguf`,
  ]);
});

test('companionPaths gives a split quant row its missing shards', () => {
  const row = {
    depth: 1,
    key: `${REPO}::UD-IQ3_S`,
    paths: [shardPath(1)],
    missingIndices: [2, 3, 4],
  };
  const keys = [shardPath(1), shardPath(2), shardPath(3), shardPath(4)];
  expect(companionPaths(row, keys)).toEqual([
    shardPath(2),
    shardPath(3),
    shardPath(4),
  ]);
});

test('companionPaths keeps another file of the model off a quant row', () => {
  // The projector belongs to the model, not to this quantization's shard set.
  const row = {
    depth: 1,
    key: `${REPO}::UD-IQ3_S`,
    paths: [shardPath(1)],
    missingIndices: [2],
  };
  expect(
    companionPaths(row, [shardPath(1), `${REPO}/mmproj-F16.gguf`]),
  ).toEqual([]);
});

test('companionPaths gives a complete quant row nothing', () => {
  const row = {
    depth: 1,
    key: `${REPO}::UD-IQ3_S`,
    paths: [shardPath(1), shardPath(2)],
    missingIndices: [],
  };
  expect(companionPaths(row, [shardPath(1), shardPath(2)])).toEqual([]);
});

const incomplete = (file: string, shardGap?: true): AuditResult => ({
  file,
  status: 'incomplete',
  ...(shardGap ? {shardGap} : {}),
});

test('redownloadableFailures skips a file whose set, not itself, is incomplete', () => {
  const failures = [
    incomplete(shardPath(1), true),
    incomplete(shardPath(2)),
    incomplete(shardPath(3)),
  ];
  expect(redownloadableFailures(failures).map((f) => f.file)).toEqual([
    shardPath(2),
    shardPath(3),
  ]);
});

test('redownloadableFailures keeps a partially-downloaded file and drops other verdicts', () => {
  const failures = [
    incomplete('a.gguf'),
    result('b.gguf', 'checksum-mismatch'),
    result('c.gguf', 'misplaced'),
  ];
  expect(redownloadableFailures(failures).map((f) => f.file)).toEqual([
    'a.gguf',
  ]);
});

test('hovercardOrder lists the absent shard ahead of the intact ones its gap flags', () => {
  const failures = [
    incomplete(shardPath(4), true),
    incomplete(shardPath(1), true),
    incomplete(shardPath(3), true),
    incomplete(shardPath(2)),
  ];
  expect(hovercardOrder(failures).map((f) => f.file)).toEqual([
    shardPath(2),
    shardPath(4),
    shardPath(1),
    shardPath(3),
  ]);
});

test('updateDownload fetches every out-of-date file of the row from its repo', () => {
  const update = (repoPath: string): UpdateResult => ({
    file: `org/repo/${repoPath}`,
    status: 'update',
    repoId: 'org/repo',
    repoPath,
    branch: 'main',
  });
  expect(
    updateDownload([update('Q4/m-00001-of-00002.gguf'), update('mmproj.gguf')]),
  ).toEqual({
    repoId: 'org/repo',
    branch: 'main',
    repoPaths: ['Q4/m-00001-of-00002.gguf', 'mmproj.gguf'],
  });
});

test('updateDownload has nothing to fetch when no update names its source', () => {
  expect(updateDownload([{file: 'org/repo/a.gguf', status: 'update'}])).toBe(
    null,
  );
});
