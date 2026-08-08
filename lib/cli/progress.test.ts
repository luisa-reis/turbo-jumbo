import {test, expect} from 'bun:test';
import {
  createJsonProgressReader,
  createLineSplitter,
  createMilestoneEmitter,
  createTextProgressReader,
  formatDuration,
  parseCopyFrame,
  renderBar,
} from '@/lib/cli/progress';

test('a line split across chunks is reassembled, not lost', () => {
  const s = createLineSplitter();
  expect(s.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
  expect(s.push('2}\n')).toEqual(['{"b":2}']);
  expect(s.flush()).toEqual([]);
});

test('a stream ending without a newline still yields its last line', () => {
  const s = createLineSplitter();
  expect(s.push('tail')).toEqual([]);
  expect(s.flush()).toEqual(['tail']);
});

test('a copy frame becomes progress', () => {
  const p = parseCopyFrame(
    JSON.stringify({
      filesDone: 2,
      filesTotal: 4,
      bytesDone: 100,
      bytesTotal: 400,
      phase: 'copying',
      errors: [],
    }),
  );
  expect(p).toMatchObject({filesDone: 2, bytesDone: 100, phase: 'copying'});
});

test('non-frame lines on the copy stream are ignored', () => {
  expect(parseCopyFrame('')).toBeNull();
  expect(parseCopyFrame('not json')).toBeNull();
  // A truncated frame must not throw.
  expect(parseCopyFrame('{"filesDone":')).toBeNull();
});

test('copy errors are carried through, since failures are named', () => {
  const p = parseCopyFrame(
    JSON.stringify({filesDone: 1, errors: ['a.gguf: connection reset']}),
  );
  expect(p!.errors).toEqual(['a.gguf: connection reset']);
});

test('the json reader keeps the most recent frame across chunks', () => {
  const r = createJsonProgressReader();
  r.push('{"filesDone":1,"bytesDone":10}\n{"filesDone":2,');
  expect(r.latest()!.filesDone).toBe(1);
  r.push('"bytesDone":20}\n');
  expect(r.latest()).toMatchObject({filesDone: 2, bytesDone: 20});
});

test('the text reader parses the download stream, redraws included', () => {
  const r = createTextProgressReader();
  // The server redraws with \r, so segments are not newline-delimited.
  const p = r.push(
    '\rDownloading: 50% 5.0GiB/10.0GiB [00:10<00:10, 500.0MiB/s]  (2/4 files)\r',
  );
  expect(p).toMatchObject({filesDone: 2, filesTotal: 4});
  expect(p!.bytesDone).toBeGreaterThan(5e9);
  expect(p!.speed).toBeGreaterThan(5e8 * 0.9);
});

test('a milestone is emitted when the file count advances', () => {
  const m = createMilestoneEmitter();
  const at = (filesDone: number, bytesDone: number) => ({
    filesDone,
    filesTotal: 4,
    bytesDone,
    bytesTotal: 40,
    errors: [],
  });
  expect(m(at(0, 0))).toBeNull(); // nothing has happened yet
  expect(m(at(1, 10))).toContain('1/4 files');
  expect(m(at(1, 10))).toBeNull(); // no new file, no new decile: silent
  expect(m(at(2, 20))).toContain('2/4 files');
});

test('a single-file transfer still reports, by decile', () => {
  // The download server omits the file count entirely for one file, so
  // count-driven milestones alone would leave a long transfer silent.
  const m = createMilestoneEmitter();
  const at = (bytesDone: number) => ({
    filesDone: 0,
    filesTotal: 0,
    bytesDone,
    bytesTotal: 1000,
    errors: [],
  });
  expect(m(at(0))).toBeNull();
  expect(m(at(120))).toContain('12%');
  expect(m(at(150))).toBeNull(); // same decile
  expect(m(at(230))).toContain('23%');
  // With one file there is no "n/m files" prefix to show.
  expect(m(at(990))).not.toContain('files');
});

test('the same line is never printed twice in a row', () => {
  // Finishing the last file trips both rules at once: the closing decile and
  // the file count.
  const m = createMilestoneEmitter();
  const at = (filesDone: number) => ({
    filesDone,
    filesTotal: 1,
    bytesDone: 100,
    bytesTotal: 100,
    errors: [],
  });
  expect(m(at(0))).toContain('100%');
  expect(m(at(1))).toBeNull();
});

test('the bar reports percentage, bytes and rate', () => {
  const out = renderBar(
    {
      filesDone: 1,
      filesTotal: 4,
      bytesDone: 5 * 1024 ** 3,
      bytesTotal: 10 * 1024 ** 3,
      speed: 40 * 1024 ** 2,
      errors: [],
    },
    62_000,
  );
  expect(out).toContain('50%');
  expect(out).toContain('5.0 GiB / 10.0 GiB');
  expect(out).toContain('1/4 files');
  expect(out).toContain('/s');
  expect(out).toContain('1m2s');
});

test('a zero-total transfer renders without dividing by zero', () => {
  const out = renderBar(
    {filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, errors: []},
    0,
  );
  expect(out).toContain('0%');
});

test('durations read in the largest useful unit', () => {
  expect(formatDuration(5_000)).toBe('5s');
  expect(formatDuration(62_000)).toBe('1m2s');
  expect(formatDuration(3_723_000)).toBe('1h2m3s');
});
