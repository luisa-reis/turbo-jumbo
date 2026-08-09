import {test, expect} from 'bun:test';
import {parseCli} from '@/lib/cli/args';

const ok = (argv: string[]) => {
  const r = parseCli(argv);
  if (!r.ok) throw new Error(`expected a parse, got: ${r.error}`);
  return r.value;
};
const err = (argv: string[]) => {
  const r = parseCli(argv);
  if (r.ok) throw new Error('expected a parse error');
  return r.error;
};

test('a bare command parses with defaults', () => {
  const v = ok(['ls']);
  expect(v.command).toBe('ls');
  expect(v.positionals).toEqual([]);
  expect(v).toMatchObject({local: false, cold: false, all: false});
  expect(v.outputFormat).toBeUndefined();
});

test('a positional argument is kept for the command', () => {
  expect(ok(['where', 'DeepSeek-V4-Flash']).positionals).toEqual([
    'DeepSeek-V4-Flash',
  ]);
});

test('flags are collected', () => {
  const v = ok([
    'ls',
    'qwen',
    '--cold',
    '--output-format',
    'json',
    '--url',
    'http://192.0.2.7:3000',
  ]);
  expect(v).toMatchObject({
    command: 'ls',
    positionals: ['qwen'],
    cold: true,
    outputFormat: 'json',
    url: 'http://192.0.2.7:3000',
  });
});

test('no command at all is help, not an error', () => {
  // What someone types to find out what the tool does.
  expect(ok([]).command).toBe('help');
});

test('an unknown command names the alternatives', () => {
  const e = err(['frobnicate']);
  expect(e).toContain("Unknown command 'frobnicate'");
  expect(e).toContain('ls');
});

test('an unknown option is reported rather than ignored', () => {
  expect(err(['ls', '--verbose'])).toContain('--verbose');
});

test('an unknown format is caught at parse time', () => {
  expect(err(['ls', '--output-format', 'yaml'])).toContain(
    "Unknown format 'yaml'",
  );
});

test('--peer without a slug is rejected', () => {
  expect(err(['ls', '--peer', ' '])).toContain('--peer');
});

test('-h is accepted as help', () => {
  expect(ok(['ls', '-h']).help).toBe(true);
});

test('--exact is collected for a scoped download', () => {
  expect(ok(['get', 'org/repo', '--file', 'a.gguf', '--exact']).exact).toBe(
    true,
  );
});

test('--exact defaults to off', () => {
  expect(ok(['get', 'org/repo']).exact).toBe(false);
});

test('-n is --dry-run', () => {
  // The short form every tool spells the same way; a plan is what you ask for
  // most often, and -n is what the fingers already type.
  expect(ok(['copy', 'qwen', '--to', 'cold', '-n']).dryRun).toBe(true);
  expect(ok(['copy', 'qwen', '--to', 'cold', '--dry-run']).dryRun).toBe(true);
  expect(ok(['copy', 'qwen', '--to', 'cold']).dryRun).toBe(false);
});
