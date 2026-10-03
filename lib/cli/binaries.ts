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

export type CliTarget = (typeof CLI_TARGETS)[number];

/** Each target as a person picking a download would name it. */
export const CLI_PLATFORMS: Record<CliTarget, string> = {
  'darwin-arm64': 'macOS, Apple silicon',
  'darwin-x64': 'macOS, Intel',
  'linux-x64': 'Linux, x86-64',
  'linux-arm64': 'Linux, ARM64',
  'windows-x64': 'Windows, x86-64',
};

/** Lists each binary with its SHA256, in `sha256sum` format. */
export const CHECKSUMS_FILE = 'SHA256SUMS';

/** The file bin/build-cli.sh writes for a target. */
export function binaryName(target: CliTarget): string {
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
 * The hashes in a SHA256SUMS file, by file name. Tolerates the `*` binary-mode
 * marker and skips anything that isn't a hash line.
 */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (m) sums.set(m[2], m[1]);
  }
  return sums;
}

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
