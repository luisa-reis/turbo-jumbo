/**
 * Output shaping for the `tj` CLI: which format a run uses, and how a table is
 * drawn. Pure — no process or stream access — so the TTY rule is a parameter
 * rather than a hidden global, and every branch is testable.
 */

/**
 * Every shape output can take. `table` is the default and the only one meant
 * for a person; there is no `auto`, because nothing switches on its own and a
 * value that always resolves to the default is a value that does nothing.
 */
export const FORMAT_VALUES = ['table', 'json', 'csv', 'toon', 'lines'] as const;
export type OutputFormat = (typeof FORMAT_VALUES)[number];
export type FormatFlag = OutputFormat;

export function isFormatFlag(s: string): s is FormatFlag {
  return (FORMAT_VALUES as readonly string[]).includes(s);
}

/**
 * The format a run should use. Piping never changes it — switching to JSON
 * off-TTY would silently break `tj ls | grep`, so machine-readable output is
 * asked for explicitly. What the TTY does decide is decoration: colour is
 * dropped when stdout isn't a terminal, so redirected output holds no escape
 * codes, and a machine format is never coloured at all.
 */
export function resolveFormat(
  flag: FormatFlag | undefined,
  isTty: boolean,
): {format: OutputFormat; color: boolean} {
  const format: OutputFormat = flag ?? 'table';
  return {format, color: isTty && format === 'table'};
}

/**
 * A CSV of whatever `--output-format json` would have printed.
 *
 * It follows the JSON rather than the table's columns: a machine format
 * carries the data, and the table drops fields to stay readable in eighty
 * columns — a spreadsheet has no such problem.
 *
 * `null` when the answer isn't records at all, which is the honest reply for
 * something like a bare list of names: there is no table in it.
 */
export function toCsv(json: unknown): string | null {
  const rows = isRecord(json) ? [json] : Array.isArray(json) ? json : null;
  if (rows === null || !rows.every(isRecord)) return null;

  const headers: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!headers.includes(key)) headers.push(key);
    }
  }
  return [
    headers.map(csvCell).join(','),
    ...rows.map((row) => headers.map((h) => csvCell(row[h])).join(',')),
  ].join('\n');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** RFC 4180: quote any field holding a comma, a quote or a line break. */
function csvCell(v: unknown): string {
  const s =
    v === null || v === undefined
      ? ''
      : Array.isArray(v)
        ? v.join('; ')
        : typeof v === 'object'
          ? JSON.stringify(v)
          : String(v);
  return /["\n\r,]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export interface Column<T> {
  header: string;
  value: (row: T) => string;
  /** Right-align sizes and counts so digits line up; names stay left. */
  align?: 'left' | 'right';
}

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * A plain column-aligned table: header row, two spaces between columns, no
 * borders — the shape `git`, `docker` and `kubectl` all settled on, and the one
 * `awk '{print $2}'` can read. Trailing whitespace is trimmed so a redirected
 * table doesn't carry padding to end of line.
 */
export function renderTable<T>(
  columns: Column<T>[],
  rows: T[],
  color = false,
): string {
  const cells = rows.map((r) => columns.map((c) => c.value(r)));
  const widths = columns.map((c, i) =>
    Math.max(c.header.length, ...cells.map((row) => row[i].length), 0),
  );

  const line = (values: string[]) =>
    values
      .map((v, i) =>
        columns[i].align === 'right'
          ? v.padStart(widths[i])
          : v.padEnd(widths[i]),
      )
      .join('  ')
      .trimEnd();

  const header = line(columns.map((c) => c.header));
  return [color ? `${DIM}${header}${RESET}` : header, ...cells.map(line)].join(
    '\n',
  );
}
