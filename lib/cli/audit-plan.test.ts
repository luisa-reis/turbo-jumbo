import {test, expect} from 'bun:test';
import {
  hasUnresolvedFindings,
  auditTargets,
  createAuditAggregator,
  findings,
  fixable,
  unresolvedFindings,
} from '@/lib/cli/audit-plan';
import type {AuditResult} from '@/lib/audit/audit';
import type {Model} from '@/lib/models/model-types';

const model = (name: string, files: Array<[string, number]>): Model =>
  ({
    name,
    files: files.map(([path, size]) => ({isSplit: false, path, size})),
  }) as unknown as Model;

const splitModel = (name: string, paths: Array<[string, number]>): Model =>
  ({
    name,
    files: [
      {isSplit: true, files: paths.map(([path, size]) => ({path, size}))},
    ],
  }) as unknown as Model;

const result = (file: string, status: string): AuditResult =>
  ({file, status}) as AuditResult;

test('targets cover every file of a matching model', () => {
  const t = auditTargets([
    model('org/repo', [
      ['a.gguf', 10],
      ['b.gguf', 20],
    ]),
  ]);
  expect(t.map((x) => x.path)).toEqual(['a.gguf', 'b.gguf']);
});

test('shards are audited individually', () => {
  const t = auditTargets([
    splitModel('org/repo', [
      ['x-00001-of-00002.gguf', 5],
      ['x-00002-of-00002.gguf', 7],
    ]),
  ]);
  expect(t).toHaveLength(2);
  expect(t[1].size).toBe(7);
});

test('the pattern filters by model name, case-insensitively', () => {
  const models = [
    model('Qwen/Qwen3', [['q.gguf', 1]]),
    model('unsloth/DeepSeek', [['d.gguf', 1]]),
  ];
  expect(auditTargets(models, 'qwen').map((t) => t.path)).toEqual(['q.gguf']);
});

test('progress counts finished files whole and in-flight ones partly', () => {
  const agg = createAuditAggregator([
    {path: 'a', size: 50, model: 'm'},
    {path: 'b', size: 50, model: 'm'},
  ]);
  agg.push({file: 'a', hashedBytes: 30, totalBytes: 50});
  expect(agg.progress().bytesDone).toBe(30);

  // A second file starts hashing while the first is still going.
  agg.push({file: 'b', hashedBytes: 10, totalBytes: 50});
  expect(agg.progress().bytesDone).toBe(40);

  agg.push({file: 'a', status: 'pass', computedSize: 50});
  expect(agg.progress()).toMatchObject({filesDone: 1, bytesDone: 60});
});

test('progress never exceeds the total, whatever the stream says', () => {
  const agg = createAuditAggregator([{path: 'a', size: 10, model: 'm'}]);
  agg.push({file: 'a', hashedBytes: 999, totalBytes: 10});
  expect(agg.progress().bytesDone).toBe(10);
});

test('a result line is reported as final, a progress line is not', () => {
  const agg = createAuditAggregator([{path: 'a', size: 10, model: 'm'}]);
  expect(agg.push({file: 'a', hashedBytes: 1, totalBytes: 10})).toBe(false);
  expect(agg.push({file: 'a', status: 'pass'})).toBe(true);
  expect(agg.results()).toHaveLength(1);
});

test('only passing files are clean', () => {
  const rs = [
    result('a', 'pass'),
    result('b', 'checksum-mismatch'),
    result('c', 'unverifiable'),
  ];
  expect(findings(rs).map((r) => r.file)).toEqual(['b', 'c']);
});

test('findings are reported apart from the command failing', () => {
  // The entry point spells this as exit 3, leaving 1 for the command failing
  // and 2 for bad usage, so a script can tell "could not check" from
  // "checked, and it is bad".
  expect(hasUnresolvedFindings([result('a', 'pass')])).toBe(false);
  expect(hasUnresolvedFindings([result('a', 'misplaced')])).toBe(true);
  expect(hasUnresolvedFindings([])).toBe(false);
});

test('a finding that was repaired no longer counts', () => {
  // `tj audit --fix || alert` must not page about a problem that was fixed.
  const found = [result('a', 'misplaced'), result('b', 'duplicate')];
  const left = unresolvedFindings(found, [
    {file: 'a', status: 'moved'},
    {file: 'b', status: 'deleted'},
  ]);
  expect(left).toHaveLength(0);
  expect(hasUnresolvedFindings(left)).toBe(false);
});

test('a failed or skipped repair leaves the finding standing', () => {
  const found = [result('a', 'misplaced'), result('b', 'misplaced')];
  const left = unresolvedFindings(found, [
    {file: 'a', status: 'error'},
    {file: 'b', status: 'skipped'},
  ]);
  expect(left.map((r) => r.file)).toEqual(['a', 'b']);
  expect(hasUnresolvedFindings(left)).toBe(true);
});

test('without --fix there are no repairs, so everything stands', () => {
  const found = [result('a', 'checksum-mismatch')];
  expect(unresolvedFindings(found, [])).toHaveLength(1);
});

test('fixable splits findings by what can be repaired', () => {
  const f = fixable([
    result('a', 'pass'),
    result('b', 'misplaced'),
    result('c', 'duplicate'),
    result('d', 'checksum-mismatch'),
  ]);
  expect(f.misplaced).toEqual(['b']);
  expect(f.duplicate).toEqual(['c']);
  expect(f.unfixable.map((r) => r.file)).toEqual(['d']);
});
