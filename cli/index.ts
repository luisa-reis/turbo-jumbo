#!/usr/bin/env bun
import {createInterface} from 'node:readline/promises';
import {COMMANDS, parseCli, type CliInvocation} from '@/lib/cli/args';
import type {ConfirmIo} from '@/lib/cli/confirm';
import {resolveColor, resolveFormat, type OutputFormat} from '@/lib/cli/format';
import {createDiagnostics, SILENT, type Verbosity} from '@/lib/cli/verbosity';
import {resolveServerUrl} from '@/lib/cli/server-url';
import {CliError, UsageError, createClient, type Client} from '@/cli/client';
import {render, type CommandOutput} from '@/cli/output';
import {commandHelp, helpAll, FULL_HELP, SHORT_HELP} from '@/cli/help';
import {ls} from '@/cli/commands/ls';
import {where} from '@/cli/commands/where';
import {disk} from '@/cli/commands/disk';
import {peers} from '@/cli/commands/peers';
import {cliVersion, version} from '@/cli/commands/version';
import {get, type TransferContext} from '@/cli/commands/get';
import {copy} from '@/cli/commands/copy';
import {audit, AuditFindings} from '@/cli/commands/audit';
import {rm} from '@/cli/commands/rm';
import {lemonade} from '@/cli/commands/lemonade';

/**
 * `tj` entry point: parse, resolve the server, dispatch, print. Every exit code
 * and every write to stderr happens here, so the commands stay pure enough to
 * be read at a glance and the conventions can't drift between them.
 */

const EXIT_OK = 0;
const EXIT_ERROR = 1;
/** The command as typed cannot run: a missing argument, an unknown flag. */
const EXIT_USAGE = 2;
/**
 * The audit ran and found something. Distinct from the audit failing to run —
 * and kept off 2, which every caller already reads as "you typed it wrong".
 */
const EXIT_FINDINGS = 3;

/**
 * The local peer's address from config.yaml, if this machine is a peer and the
 * config is readable. Imported lazily: `lib/config` reads the filesystem at
 * module load, and a missing or malformed config must not stop `tj --help` or
 * an explicit `--url` from working.
 */
async function localPeerAddress(): Promise<string | undefined> {
  try {
    const {localPeer} = await import('@/lib/config');
    return localPeer?.address;
  } catch {
    // A malformed config is a real problem, but only when we actually need it
    // to find the server — and by then --url and TJ_URL have had their turn.
    return undefined;
  }
}

/**
 * How a transfer reports itself while it runs. Live progress is for a human
 * watching; every machine format stays silent, so its output is exactly the
 * result and nothing else.
 */
function transferContext(
  format: OutputFormat,
  verbosity: Verbosity,
): TransferContext {
  return {
    isTty: Boolean(process.stdout.isTTY),
    showProgress: format === 'table' && verbosity > SILENT,
    write: (s) => process.stdout.write(s),
  };
}

/**
 * The terminal a destructive command asks before it deletes.
 *
 * Judged by **stdin**, because that is where the answer comes from — piping the
 * result somewhere (`tj rm … --output-format json | jq`) doesn't stop a person from
 * answering. The question and its echo go to stderr for the same reason: stdout
 * carries the result, and a prompt mixed into it would break every parser
 * downstream.
 */
function confirmIo(): ConfirmIo {
  return {
    isInteractive: Boolean(process.stdin.isTTY),
    ask: async (question) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

/**
 * The help this run is asking for, if it is asking for any.
 *
 * `tj help <command>` and `tj <command> --help` are one question asked two
 * ways, so they answer alike. At the top level the spelling decides: -h is the
 * screenful, --help the long form — and a bare `tj`, which the parser reports
 * as the help command, takes the screenful too.
 */
function helpAsked(inv: CliInvocation): string | undefined {
  if (inv.command === 'help') {
    const named = inv.positionals[0];
    if (named === undefined) {
      return inv.help === 'short' ? SHORT_HELP : FULL_HELP;
    }
    const text = commandHelp(named);
    if (text === undefined) {
      throw new UsageError(
        `No help for '${named}': it isn't a command.\n` +
          `Try one of: ${COMMANDS.join(', ')}.`,
      );
    }
    return text;
  }
  return inv.help === undefined ? undefined : commandHelp(inv.command);
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseCli(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n\nTry 'tj help'.\n`);
    return EXIT_USAGE;
  }
  const inv = parsed.value;

  // Before the help branch: a bare `tj --version` names no command, and the
  // parser calls that help. Neither needs a server — which is exactly when
  // you most want to know which tj you are running.
  if (inv.version) {
    process.stdout.write(`${cliVersion(inv.verbosity >= 1)}\n`);
    return EXIT_OK;
  }

  if (inv.helpAll) {
    process.stdout.write(helpAll());
    return EXIT_OK;
  }

  const asked = helpAsked(inv);
  if (asked !== undefined) {
    process.stdout.write(asked);
    return EXIT_OK;
  }

  const format = resolveFormat(inv.outputFormat);
  const color = resolveColor({
    flag: inv.color,
    format,
    isTty: Boolean(process.stdout.isTTY),
    // no-color.org: any non-empty value means don't.
    noColor: (process.env.NO_COLOR ?? '') !== '',
  });
  // Diagnostics go to stderr, always: the dial controls what is said about
  // the work, never the result of it, so `-vvv --output-format json | jq`
  // still hands jq exactly the JSON it would have got without the -vvv.
  const diag = createDiagnostics(inv.verbosity, (line) =>
    process.stderr.write(line),
  );
  const url = resolveServerUrl({
    flag: inv.url,
    env: process.env.TJ_URL,
    localPeerAddress: await localPeerAddress(),
  });
  diag.write(1, `command ${inv.command}`);
  diag.write(1, `server ${url}`);
  const client = createClient(url, diag);

  let out: CommandOutput;
  // Findings are a successful audit with bad news, so they print their report
  // like any other result and only differ in the exit code — a script can then
  // tell "checked, and it is bad" from "could not check at all".
  let exitCode = EXIT_OK;
  try {
    out = await run(client, inv, format, color);
  } catch (e) {
    if (!(e instanceof AuditFindings)) throw e;
    out = e.output;
    exitCode = EXIT_FINDINGS;
  }

  const text = render(out, format);
  if (text) process.stdout.write(`${text}\n`);
  return exitCode;
}

/** Dispatch one command. */
async function run(
  client: Client,
  inv: CliInvocation,
  format: OutputFormat,
  color: boolean,
): Promise<CommandOutput> {
  switch (inv.command) {
    case 'ls':
      return ls(client, inv, color);
    case 'where':
      return where(client, inv, color);
    case 'disk':
      return disk(client, inv, color);
    case 'peers':
      return peers(client, color);
    case 'version':
      return version(client, color);
    case 'get':
      return get(client, inv, transferContext(format, inv.verbosity));
    case 'copy':
      return copy(client, inv, transferContext(format, inv.verbosity));
    case 'audit':
      return audit(client, inv, transferContext(format, inv.verbosity));
    case 'rm':
      return rm(client, inv, confirmIo());
    case 'lemonade':
      return lemonade(
        client,
        inv,
        color,
        transferContext(format, inv.verbosity),
        confirmIo(),
      );
    case 'help':
      // Handled before dispatch; listed so the switch stays exhaustive and a
      // new command can't be added without being wired up here.
      throw new CliError(FULL_HELP);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  // A CliError is already phrased for a human; anything else is a bug, and its
  // stack is the useful part. UsageError is checked first — it extends
  // CliError, and the difference is only which exit code the caller sees.
  if (e instanceof UsageError) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = EXIT_USAGE;
  } else if (e instanceof CliError) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = EXIT_ERROR;
  } else {
    process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
    process.exitCode = EXIT_ERROR;
  }
}
