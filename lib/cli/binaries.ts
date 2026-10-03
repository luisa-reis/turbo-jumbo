/**
 * The standalone `tj` binaries this server hands out at /api/v1/cli, built by
 * bin/build-cli.sh into the deploy alongside the app — so a machine on the
 * network can fetch a CLI stamped with exactly the commit its server runs.
 */

import path from 'path';

/** Every platform bin/build-cli.sh compiles for, in its own order. */
export const CLI_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
  'windows-x64',
] as const;

/** Lists each binary with its SHA256, in `sha256sum` format. */
export const CHECKSUMS_FILE = 'SHA256SUMS';

/** The file bin/build-cli.sh writes for a target. */
export function binaryName(target: (typeof CLI_TARGETS)[number]): string {
  return `tj-${target}${target.startsWith('windows-') ? '.exe' : ''}`;
}

const SERVED = new Set<string>([
  ...CLI_TARGETS.map(binaryName),
  CHECKSUMS_FILE,
]);

/**
 * Whether a requested name is one this server serves. An allow-list rather
 * than a path check: the name comes straight from the URL, and nothing outside
 * this set should ever be readable through it.
 */
export function isServedFile(name: string): boolean {
  return SERVED.has(name);
}

/** Every name this server can serve, binaries first. */
export const SERVED_FILES: readonly string[] = [...SERVED];

/**
 * Where the binaries are read from: `TJ_CLI_DIR`, else `build/cli` under the
 * working directory — the repo root in dev, the release dir in a deploy, /app
 * in the image. All three are where bin/build-cli.sh is pointed.
 */
export function cliDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.TJ_CLI_DIR || path.join(process.cwd(), 'build', 'cli');
}
