import {test, expect} from 'bun:test';
import {
  isFormatFlag,
  renderTable,
  resolveFormat,
  toCsv,
  type Column,
} from '@/lib/cli/format';

test('the default is a table, never JSON when piped', () => {
  // Switching to JSON off-TTY would silently break `tj ls | grep`.
  expect(resolveFormat(undefined, false).format).toBe('table');
  expect(resolveFormat(undefined, true).format).toBe('table');
});

test('an explicit format is honoured regardless of the TTY', () => {
  expect(resolveFormat('json', true).format).toBe('json');
  expect(resolveFormat('lines', true).format).toBe('lines');
});

test('colour is only for a table on a terminal', () => {
  expect(resolveFormat(undefined, true).color).toBe(true);
  expect(resolveFormat(undefined, false).color).toBe(false);
  // Machine formats are parsed; escape codes would corrupt every one of them.
  expect(resolveFormat('json', true).color).toBe(false);
  expect(resolveFormat('csv', true).color).toBe(false);
  expect(resolveFormat('toon', true).color).toBe(false);
});

test('isFormatFlag accepts only the documented values', () => {
  expect(isFormatFlag('json')).toBe(true);
  expect(isFormatFlag('csv')).toBe(true);
  expect(isFormatFlag('toon')).toBe(true);
  // Gone on purpose: it only ever meant "table".
  expect(isFormatFlag('auto')).toBe(false);
  expect(isFormatFlag('yaml')).toBe(false);
});

test('CSV takes its columns from the union of every record', () => {
  // A field only some rows carry still gets a column, or reading the file
  // would depend on which row happened to come first.
  expect(toCsv([{a: 1}, {a: 2, b: 3}])).toBe('a,b\n1,\n2,3');
});

test('CSV quotes what RFC 4180 requires, and flattens lists', () => {
  expect(
    toCsv([{name: 'a,b', quote: 'say "hi"', where: ['local', 'cold']}]),
  ).toBe('name,quote,where\n"a,b","say ""hi""",local; cold');
});

test('a single record is a one-row CSV, not a failure', () => {
  expect(toCsv({version: '0.1.0', dev: true})).toBe('version,dev\n0.1.0,true');
});

test('CSV refuses what has no table in it', () => {
  // Better to say so than to invent a shape; the caller is told which
  // formats do fit.
  expect(toCsv(['a', 'b'])).toBeNull();
  expect(toCsv('nope')).toBeNull();
});

interface Row {
  name: string;
  size: string;
}
const columns: Column<Row>[] = [
  {header: 'MODEL', value: (r) => r.name},
  {header: 'SIZE', value: (r) => r.size, align: 'right'},
];

test('columns are padded to their widest cell, headers included', () => {
  const out = renderTable(columns, [
    {name: 'a-very-long-model-name', size: '1.2 GiB'},
    {name: 'short', size: '10 MiB'},
  ]);
  expect(out.split('\n')).toEqual([
    'MODEL                      SIZE',
    'a-very-long-model-name  1.2 GiB',
    'short                    10 MiB',
  ]);
});

test('a table carries no trailing whitespace', () => {
  const out = renderTable(columns, [{name: 'x', size: '1 B'}]);
  for (const l of out.split('\n')) expect(l).toBe(l.trimEnd());
});

test('an empty table still names its columns', () => {
  expect(renderTable(columns, [])).toBe('MODEL  SIZE');
});

test('colour wraps only the header, leaving data clean', () => {
  const out = renderTable(columns, [{name: 'x', size: '1 B'}], true);
  const [header, row] = out.split('\n');
  expect(header).toContain('\x1b[2m');
  expect(row).not.toContain('\x1b[');
});
