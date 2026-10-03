import {promises as fsp} from 'fs';
import path from 'path';
import {
  CHECKSUMS_FILE,
  CLI_PLATFORMS,
  CLI_TARGETS,
  binaryName,
  cliDir,
  parseChecksums,
  type CliTarget,
} from '@/lib/cli/binaries';

/** One `tj` binary this server actually has on disk. */
export interface ServedBinary {
  target: CliTarget;
  /** Human name of the platform, e.g. "macOS, Apple silicon". */
  platform: string;
  name: string;
  size: number;
  /** From SHA256SUMS; null when that file is missing or doesn't list it. */
  sha256: string | null;
  /** Server-relative URL it downloads from. */
  path: string;
}

async function sizeOf(file: string): Promise<number | null> {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return null;
  }
}

/**
 * The binaries present in the CLI dir, in CLI_TARGETS order. Only what is
 * there: a deploy builds a subset of the targets, and a dev checkout none
 * until bin/build-cli.sh runs.
 */
export async function servedBinaries(
  dir: string = cliDir(),
): Promise<ServedBinary[]> {
  const sums = parseChecksums(
    await fsp.readFile(path.join(dir, CHECKSUMS_FILE), 'utf8').catch(() => ''),
  );
  const found = await Promise.all(
    CLI_TARGETS.map(async (target): Promise<ServedBinary | null> => {
      const name = binaryName(target);
      const size = await sizeOf(path.join(dir, name));
      if (size === null) return null;
      return {
        target,
        platform: CLI_PLATFORMS[target],
        name,
        size,
        sha256: sums.get(name) ?? null,
        path: `/api/v1/cli/${name}`,
      };
    }),
  );
  return found.filter((b) => b !== null);
}
