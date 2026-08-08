#!/usr/bin/env bun
import {parseCli} from '@/lib/cli/args';
import {resolveFormat} from '@/lib/cli/format';
import {resolveServerUrl} from '@/lib/cli/server-url';
import {CliError, createClient} from '@/cli/client';
import {render, type CommandOutput} from '@/cli/output';
import {HELP} from '@/cli/help';
import {ls} from '@/cli/commands/ls';
import {where} from '@/cli/commands/where';
import {disk} from '@/cli/commands/disk';
import {peers} from '@/cli/commands/peers';
import {version} from '@/cli/commands/version';

/**
 * `tj` entry point: parse, resolve the server, dispatch, print. Every exit code
 * and every write to stderr happens here, so the commands stay pure enough to
 * be read at a glance and the conventions can't drift between them.
 */

const EXIT_OK = 0;
const EXIT_ERROR = 1;

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
  switch (inv.command) {
    case 'ls':
      out = await ls(client, inv, color);
      break;
    case 'where':
      out = await where(client, inv, color);
      break;
    case 'disk':
      out = await disk(client, inv, color);
      break;
    case 'peers':
      out = await peers(client, color);
      break;
    case 'version':
      out = await version(client, color);
      break;
  }

  const text = render(out, format);
  if (text) process.stdout.write(`${text}\n`);
  return EXIT_OK;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  // A CliError is already phrased for a human; anything else is a bug, and its
  // stack is the useful part.
  if (e instanceof CliError) process.stderr.write(`${e.message}\n`);
  else process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = EXIT_ERROR;
}
