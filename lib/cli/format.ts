/**
 * Output shaping for the `tj` CLI: which format a run uses, and how a table is
 * drawn. Pure — no process or stream access — so the TTY rule is a parameter
 * rather than a hidden global, and every branch is testable.
 */

export type OutputFormat = 'table' | 'json' | 'quiet';

/** Formats accepted on the command line. `auto` resolves against the TTY. */
export const FORMAT_VALUES = ['auto', 'table', 'json', 'quiet'] as const;
export type FormatFlag = (typeof FORMAT_VALUES)[number];

export function isFormatFlag(s: string): s is FormatFlag {
  return (FORMAT_VALUES as readonly string[]).includes(s);
}

/**
 * The format a run should use. `auto` (the default) always means a table —
 * deliberately not JSON-when-piped, which silently breaks `tj ls | grep`.
 * Machine-readable output is asked for explicitly. What the TTY does decide is
 * decoration: colour is dropped when stdout isn't a terminal, so redirected
 * output holds no escape codes.
 */
export function resolveFormat(
  flag: FormatFlag | undefined,
  isTty: boolean,
): {format: OutputFormat; color: boolean} {
  const format: OutputFormat =
    flag === undefined || flag === 'auto' ? 'table' : flag;
  return {format, color: isTty && format === 'table'};
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
