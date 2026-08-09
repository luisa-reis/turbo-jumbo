import {test, expect} from 'bun:test';
import {createDiagnostics, resolveVerbosity, SILENT} from '@/lib/cli/verbosity';

const level = (verbose: number, silent = false) => {
  const r = resolveVerbosity({verbose, silent});
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

test('the dial runs from silent to three', () => {
  expect(level(0, true)).toBe(SILENT);
  expect(level(0)).toBe(0);
  expect(level(1)).toBe(1);
  expect(level(3)).toBe(3);
});

test('extra vs clamp rather than fail', () => {
  // Someone leaning on the key, not someone to be corrected. ssh does this.
  expect(level(5)).toBe(3);
  expect(level(50)).toBe(3);
});

test('silent and verbose together is refused, not guessed', () => {
  // Two points on one dial. In practice it means a wrapper and its caller are
  // each appending a flag with no idea the other exists; guessing hides that.
  const r = resolveVerbosity({verbose: 1, silent: true});
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain('same dial');
});

test('diagnostics carry the level that produced them', () => {
  const lines: string[] = [];
  const diag = createDiagnostics(2, (l) => lines.push(l));
  diag.write(1, 'server http://example.invalid');
  diag.write(2, 'GET /api/v1/models');
  diag.write(3, 'the whole body');
  expect(lines).toEqual([
    'debug1: server http://example.invalid\n',
    'debug2: GET /api/v1/models\n',
  ]);
});

test('every line of a multi-line diagnostic is tagged', () => {
  // Otherwise a pasted response body would look like output, not diagnostics.
  const lines: string[] = [];
  createDiagnostics(3, (l) => lines.push(l)).write(3, '{\n  "a": 1\n}');
  expect(lines).toEqual(['debug3: {\n', 'debug3:   "a": 1\n', 'debug3: }\n']);
});

test('silent prints no diagnostics at all', () => {
  const lines: string[] = [];
  const diag = createDiagnostics(SILENT, (l) => lines.push(l));
  diag.write(1, 'nope');
  expect(lines).toEqual([]);
  expect(diag.enabled(1)).toBe(false);
});
