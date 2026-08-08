import {test, expect} from 'bun:test';
import {
  isFormatFlag,
  renderTable,
  resolveFormat,
  type Column,
} from '@/lib/cli/format';

test('auto resolves to a table, never to JSON when piped', () => {
  // Switching to JSON off-TTY would silently break `tj ls | grep`.
  expect(resolveFormat('auto', false).format).toBe('table');
  expect(resolveFormat(undefined, false).format).toBe('table');
  expect(resolveFormat(undefined, true).format).toBe('table');
});

test('an explicit format is honoured regardless of the TTY', () => {
  expect(resolveFormat('json', true).format).toBe('json');
  expect(resolveFormat('quiet', true).format).toBe('quiet');
});

test('colour is only for a table on a terminal', () => {
  expect(resolveFormat('auto', true).color).toBe(true);
  expect(resolveFormat('auto', false).color).toBe(false);
  // JSON is parsed by machines; escape codes would corrupt it.
  expect(resolveFormat('json', true).color).toBe(false);
});

test('isFormatFlag accepts only the documented values', () => {
  expect(isFormatFlag('json')).toBe(true);
  expect(isFormatFlag('yaml')).toBe(false);
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
