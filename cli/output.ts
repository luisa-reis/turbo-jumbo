import type {OutputFormat} from '@/lib/cli/format';

/**
 * What a command produces, in each of the three shapes a run might ask for.
 * Commands build all three and the entry point picks one, so every command
 * supports every format without each remembering to.
 */
export interface CommandOutput {
  /** `--format json`: the structured answer. */
  json: unknown;
  /** `--format auto|table`: already rendered. */
  table: string;
  /** `--format quiet`: one identifier per line, for xargs. */
  quiet: string[];
}

export function render(out: CommandOutput, format: OutputFormat): string {
  switch (format) {
    case 'json':
      return JSON.stringify(out.json, null, 2);
    case 'quiet':
      return out.quiet.join('\n');
    case 'table':
      return out.table;
  }
}
