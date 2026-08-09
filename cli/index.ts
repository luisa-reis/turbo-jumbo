#!/usr/bin/env bun
import {createInterface} from 'node:readline/promises';
import {parseCli, type CliInvocation} from '@/lib/cli/args';
import type {ConfirmIo} from '@/lib/cli/confirm';
import {resolveFormat, type OutputFormat} from '@/lib/cli/format';
import {resolveServerUrl} from '@/lib/cli/server-url';
import {CliError, createClient, type Client} from '@/cli/client';
import {render, type CommandOutput} from '@/cli/output';
import {HELP} from '@/cli/help';
import {ls} from '@/cli/commands/ls';
import {where} from '@/cli/commands/where';
import {disk} from '@/cli/commands/disk';
import {peers} from '@/cli/commands/peers';
import {version} from '@/cli/commands/version';
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
/** The audit ran and found something. Distinct from the audit failing to run. */
const EXIT_FINDINGS = 2;

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
 * watching; `--format json` and `--format quiet` stay silent so their output is
 * exactly the result and nothing else.
 */
function transferContext(format: OutputFormat): TransferContext {
  return {
    isTty: Boolean(process.stdout.isTTY),
    showProgress: format === 'table',
    write: (s) => process.stdout.write(s),
  };
}

/**
 * The terminal a destructive command asks before it deletes.
 *
 * Judged by **stdin**, because that is where the answer comes from — piping the
 * result somewhere (`tj rm … --format json | jq`) doesn't stop a person from
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

async function main(argv: string[]): Promise<number> {
  const parsed = parseCli(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n\nTry 'tj help'.\n`);
    return EXIT_ERROR;
  }
  const inv = parsed.value;

  if (inv.command === 'help' || inv.help) {
    process.stdout.write(HELP);
    return EXIT_OK;
  }

  const {format, color} = resolveFormat(inv.format, process.stdout.isTTY);
  const client = createClient(
    resolveServerUrl({
      flag: inv.url,
      env: process.env.TJ_URL,
      localPeerAddress: await localPeerAddress(),
    }),
  );

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

/** Dispatch one command. `color` follows the same TTY rule as the format. */
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
      return get(client, inv, transferContext(format));
    case 'copy':
      return copy(client, inv, transferContext(format));
    case 'audit':
      return audit(client, inv, transferContext(format));
    case 'rm':
      return rm(client, inv, confirmIo());
    case 'lemonade':
      return lemonade(client, inv, color, transferContext(format), confirmIo());
    case 'help':
      // Handled before dispatch; listed so the switch stays exhaustive and a
      // new command can't be added without being wired up here.
      throw new CliError(HELP);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  // A CliError is already phrased for a human; anything else is a bug, and its
  // stack is the useful part.
  if (e instanceof CliError) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = EXIT_ERROR;
  } else {
    process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
    process.exitCode = EXIT_ERROR;
  }
}
