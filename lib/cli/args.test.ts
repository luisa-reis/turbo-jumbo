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
  expect(v.format).toBeUndefined();
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
    '--format',
    'json',
    '--url',
    'http://192.0.2.7:3000',
  ]);
  expect(v).toMatchObject({
    command: 'ls',
    positionals: ['qwen'],
    cold: true,
    format: 'json',
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
  expect(err(['ls', '--format', 'yaml'])).toContain("Unknown format 'yaml'");
});

test('--peer without a slug is rejected', () => {
  expect(err(['ls', '--peer', ' '])).toContain('--peer');
});

test('-h is accepted as help', () => {
  expect(ok(['ls', '-h']).help).toBe(true);
});
