import {parseArgs} from 'node:util';
import {FORMAT_VALUES, isFormatFlag, type FormatFlag} from '@/lib/cli/format';

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
  'get',
  'copy',
  'audit',
  'rm',
  'lemonade',
  'help',
] as const;
export type Command = (typeof COMMANDS)[number];

export interface CliInvocation {
  command: Command;
  positionals: string[];
  outputFormat?: FormatFlag;
  url?: string;
  peer?: string;
  local: boolean;
  cold: boolean;
  all: boolean;
  help: boolean;
  // Transfers (phase 2).
  quant: string[];
  file: string[];
  // The named files are the whole model, not part of a bigger repo: they are
  // recorded as its complete file set (see `fileScope`).
  exact: boolean;
  to?: string;
  from?: string;
  deleteAfter: boolean;
  dryRun: boolean;
  // Audit (phase 3).
  fix: boolean;
  allowDelete: boolean;
  cached: boolean;
  // Removal and sync (phase 4).
  yes: boolean;
}

export type ParseResult =
  {ok: true; value: CliInvocation} | {ok: false; error: string};

const OPTIONS = {
  'output-format': {type: 'string'},
  url: {type: 'string'},
  peer: {type: 'string'},
  local: {type: 'boolean'},
  cold: {type: 'boolean'},
  all: {type: 'boolean'},
  help: {type: 'boolean', short: 'h'},
  // Repeatable: several quantizations, or several files, in one transfer.
  quant: {type: 'string', multiple: true},
  file: {type: 'string', multiple: true},
  exact: {type: 'boolean'},
  to: {type: 'string'},
  from: {type: 'string'},
  'delete-after': {type: 'boolean'},
  'dry-run': {type: 'boolean', short: 'n'},
  fix: {type: 'boolean'},
  'allow-delete': {type: 'boolean'},
  cached: {type: 'boolean'},
  yes: {type: 'boolean', short: 'y'},
} as const;

function isCommand(s: string): s is Command {
  return (COMMANDS as readonly string[]).includes(s);
}

/**
 * What to print when parseArgs refuses the arguments.
 *
 * Its own wording for an unknown option answers a question nobody asked —
 * every one of them carries a lecture about placing positional arguments
 * after `--`. Someone who mistyped a flag needs to hear that the flag is
 * unknown, and nothing else; the entry point points them at the help.
 */
function parseErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const unknown = /^Unknown option '([^']+)'/.exec(raw);
  return unknown ? `Unknown option '${unknown[1]}'.` : raw;
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
    return {ok: false, error: parseErrorMessage(e)};
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

  const requested = values['output-format'];
  if (requested !== undefined && !isFormatFlag(requested)) {
    return {
      ok: false,
      error: `Unknown format '${requested}'. Try one of: ${FORMAT_VALUES.join(', ')}.`,
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
    outputFormat: values['output-format'] as FormatFlag | undefined,
    url: values.url,
    peer: values.peer,
    local: values.local ?? false,
    cold: values.cold ?? false,
    all: values.all ?? false,
    help: values.help ?? false,
    quant: values.quant ?? [],
    file: values.file ?? [],
    exact: values.exact ?? false,
    to: values.to,
    from: values.from,
    deleteAfter: values['delete-after'] ?? false,
    dryRun: values['dry-run'] ?? false,
    fix: values.fix ?? false,
    allowDelete: values['allow-delete'] ?? false,
    cached: values.cached ?? false,
    yes: values.yes ?? false,
  };
}
