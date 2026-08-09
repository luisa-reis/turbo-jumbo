import {test, expect} from 'bun:test';
import {
  isFormatFlag,
  renderTable,
  resolveColor,
  resolveFormat,
  toCsv,
  type Column,
} from '@/lib/cli/format';

test('the default is a table, never JSON when piped', () => {
  // Switching to JSON off-TTY would silently break `tj ls | grep`.
  expect(resolveFormat(undefined)).toBe('table');
});

test('an explicit format is honoured regardless of the TTY', () => {
  expect(resolveFormat('json')).toBe('json');
  expect(resolveFormat('lines')).toBe('lines');
});

const colour = (o: Partial<Parameters<typeof resolveColor>[0]>) =>
  resolveColor({
    flag: undefined,
    format: 'table',
    isTty: true,
    noColor: false,
    ...o,
  });

test('colour is only for a table on a terminal', () => {
  expect(colour({})).toBe(true);
  expect(colour({isTty: false})).toBe(false);
  // Machine formats are parsed; escape codes would corrupt every one of them,
  // so no flag can turn colour on for them.
  for (const format of ['json', 'csv', 'toon', 'lines'] as const) {
    expect(colour({format})).toBe(false);
    expect(colour({format, flag: 'always'})).toBe(false);
  }
});

test('--color overrides the terminal, and NO_COLOR overrides the default', () => {
  expect(colour({flag: 'always', isTty: false})).toBe(true);
  expect(colour({flag: 'never'})).toBe(false);
  expect(colour({noColor: true})).toBe(false);
  // A flag typed on the spot outranks the environment it was typed in.
  expect(colour({flag: 'always', noColor: true})).toBe(true);
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
