import {encode as toToon} from '@toon-format/toon';
import {toCsv, type OutputFormat} from '@/lib/cli/format';
import {UsageError} from '@/cli/client';

/**
 * What a command produces, in each of the shapes a run might ask for. Commands
 * build the human table and the structured answer; the machine formats are
 * derived from that answer here, so a new one costs nothing per command.
 */
export interface CommandOutput {
  /** The structured answer, and the source of `csv` and `toon`. */
  json: unknown;
  /** The default: already rendered for a person. */
  table: string;
  /** `--output-format lines`: one identifier per line, for xargs. */
  lines: string[];
}

export function render(out: CommandOutput, format: OutputFormat): string {
  switch (format) {
    case 'json':
      return JSON.stringify(out.json, null, 2);
    case 'csv': {
      const csv = toCsv(out.json);
      if (csv === null) {
        // A documented format the answer genuinely has no shape for. Say which
        // ones it does, rather than printing something that isn't a CSV.
        throw new UsageError(
          "This command's answer isn't a table, so it has no CSV form.\n" +
            'Try --output-format json or --output-format toon.',
        );
      }
      return csv;
    }
    case 'toon':
      return toToon(out.json);
    case 'lines':
      return out.lines.join('\n');
    case 'table':
      return out.table;
  }
}
