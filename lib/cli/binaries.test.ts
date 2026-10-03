import {describe, expect, test} from 'bun:test';
import {
  CLI_TARGETS,
  SERVED_FILES,
  binaryName,
  cliDir,
  isServedFile,
} from '@/lib/cli/binaries';

describe('binaryName', () => {
  test('matches what bin/build-cli.sh writes', () => {
    expect(binaryName('darwin-arm64')).toBe('tj-darwin-arm64');
    expect(binaryName('windows-x64')).toBe('tj-windows-x64.exe');
  });
});

describe('isServedFile', () => {
  test('serves every binary and the checksums', () => {
    for (const t of CLI_TARGETS) expect(isServedFile(binaryName(t))).toBe(true);
    expect(isServedFile('SHA256SUMS')).toBe(true);
  });

  test('serves nothing else from the directory or beyond it', () => {
    for (const name of [
      '',
      '.',
      '..',
      '../config.yaml',
      'tj-windows-x64',
      'tj-darwin-arm64/../../server.js',
      'tj-plan9-mips',
    ]) {
      expect(isServedFile(name)).toBe(false);
    }
  });

  test('lists binaries before the checksums', () => {
    expect(SERVED_FILES.at(-1)).toBe('SHA256SUMS');
    expect(SERVED_FILES).toHaveLength(CLI_TARGETS.length + 1);
  });
});

describe('cliDir', () => {
  test('TJ_CLI_DIR wins', () => {
    expect(cliDir({TJ_CLI_DIR: '/srv/tj-cli'})).toBe('/srv/tj-cli');
  });

  test('defaults to build/cli under the working directory', () => {
    expect(cliDir({})).toBe(`${process.cwd()}/build/cli`);
  });
});
