import {parseArgs} from 'node:util';
import {isFormatFlag, type FormatFlag} from '@/lib/cli/format';

/**
 * Command-line parsing for `tj`. Built on node's own `parseArgs` rather than a
 * dependency — the option set is small and the repo keeps a deliberately short
 * dependency list.
 *
 * Returns a discriminated result instead of throwing or exiting, so the entry
 * point owns every write to stderr and every exit code in one place, and the
 * parse itself stays testable.
 */

export const COMMANDS = [
  'ls',
  'where',
  'disk',
  'peers',
  'version',
  'help',
] as const;
export type Command = (typeof COMMANDS)[number];

export interface CliInvocation {
  command: Command;
  positionals: string[];
  format?: FormatFlag;
  url?: string;
  peer?: string;
  local: boolean;
  cold: boolean;
  all: boolean;
  help: boolean;
}

export type ParseResult =
  {ok: true; value: CliInvocation} | {ok: false; error: string};

const OPTIONS = {
  format: {type: 'string'},
  url: {type: 'string'},
  peer: {type: 'string'},
  local: {type: 'boolean'},
  cold: {type: 'boolean'},
  all: {type: 'boolean'},
  help: {type: 'boolean', short: 'h'},
} as const;

function isCommand(s: string): s is Command {
  return (COMMANDS as readonly string[]).includes(s);
}

export function parseCli(argv: string[]): ParseResult {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
    });
  } catch (e) {
    // parseArgs reports unknown options and missing values; its message is
    // already user-facing ("Unknown option '--verbose'").
    return {ok: false, error: e instanceof Error ? e.message : String(e)};
  }

  const {values, positionals} = parsed;
  const [name, ...rest] = positionals;

  // A bare `tj`, or `tj --help`, is the help screen rather than an error: it is
  // what someone types to find out what the tool does.
  if (name === undefined) {
    return {
      ok: true,
      value: invocation('help', [], values),
    };
  }
  if (!isCommand(name)) {
    return {
      ok: false,
      error: `Unknown command '${name}'. Try one of: ${COMMANDS.join(', ')}.`,
    };
  }

  if (values.format !== undefined && !isFormatFlag(values.format)) {
    return {
      ok: false,
      error: `Unknown format '${values.format}'. Try one of: auto, table, json, quiet.`,
    };
  }

  if (values.peer !== undefined && values.peer.trim() === '') {
    return {ok: false, error: '--peer needs a peer slug.'};
  }

  return {ok: true, value: invocation(name, rest, values)};
}

type Values = ReturnType<typeof parseArgs<{options: typeof OPTIONS}>>['values'];

function invocation(
  command: Command,
  positionals: string[],
  values: Values,
): CliInvocation {
  return {
    command,
    positionals,
    format: values.format as FormatFlag | undefined,
    url: values.url,
    peer: values.peer,
    local: values.local ?? false,
    cold: values.cold ?? false,
    all: values.all ?? false,
    help: values.help ?? false,
  };
}
