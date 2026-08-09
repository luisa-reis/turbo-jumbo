import {test, expect} from 'bun:test';
import {buildTjGetCommand} from '@/lib/hf/download-command';

const REPO = 'unsloth/DeepSeek-V4-Flash-0731-GGUF';
const shard = (i: number) =>
  `UD-IQ3_S/DeepSeek-V4-Flash-0731-UD-IQ3_S-0000${i}-of-00004.gguf`;

const req = {repoId: REPO, branch: 'main', filePaths: [shard(1), shard(2)]};
const quants = [{label: 'UD-IQ3_S', paths: [shard(1), shard(2)]}];

test('names the quantization when a whole one is selected', () => {
  expect(buildTjGetCommand(req, {quants})).toBe(
    `tj get ${REPO} --quant UD-IQ3_S`,
  );
});

test('repeats --quant for each quantization selected', () => {
  const two = [
    {label: 'Q4_K_M', paths: ['a-Q4_K_M.gguf']},
    {label: 'Q8_0', paths: ['a-Q8_0.gguf']},
  ];
  const cmd = buildTjGetCommand(
    {
      repoId: 'org/repo',
      branch: 'main',
      filePaths: ['a-Q4_K_M.gguf', 'a-Q8_0.gguf'],
    },
    {quants: two},
  );
  expect(cmd).toBe('tj get org/repo --quant Q4_K_M --quant Q8_0');
});

test('falls back to --file when only part of a quantization is selected', () => {
  const cmd = buildTjGetCommand({...req, filePaths: [shard(2)]}, {quants});
  expect(cmd).toBe(`tj get ${REPO} --file ${shard(2)}`);
});

test('names files when the repo has no quantizations to choose between', () => {
  // A safetensors model: the runner knows only the paths it asked for.
  const cmd = buildTjGetCommand({
    repoId: 'org/model',
    branch: 'main',
    filePaths: ['model.safetensors'],
  });
  expect(cmd).toBe('tj get org/model --file model.safetensors');
});

test('names nothing when the whole of a non-pick-one repo is taken', () => {
  const repoPaths = ['model.safetensors', 'config.json', 'tokenizer.json'];
  const cmd = buildTjGetCommand(
    {repoId: 'org/model', branch: 'main', filePaths: [...repoPaths]},
    {repoPaths},
  );
  expect(cmd).toBe('tj get org/model');
});

test('still names the quantizations when every one of them is selected', () => {
  // A pick-one repo taken whole is not `tj get <repo>` — that prints the menu.
  const repoPaths = ['a-Q4_K_M.gguf', 'a-Q8_0.gguf'];
  const cmd = buildTjGetCommand(
    {repoId: 'org/repo', branch: 'main', filePaths: [...repoPaths]},
    {
      repoPaths,
      quants: [
        {label: 'Q4_K_M', paths: ['a-Q4_K_M.gguf']},
        {label: 'Q8_0', paths: ['a-Q8_0.gguf']},
      ],
    },
  );
  expect(cmd).toBe('tj get org/repo --quant Q4_K_M --quant Q8_0');
});

test('carries a pinned revision as a tree URL, having no flag for one', () => {
  const cmd = buildTjGetCommand({...req, branch: 'v0.9.20'}, {quants});
  expect(cmd).toBe(
    `tj get https://huggingface.co/${REPO}/tree/v0.9.20 --quant UD-IQ3_S`,
  );
});

test('spells out the cold-storage checkboxes', () => {
  const cmd = buildTjGetCommand(
    {...req, sendToCold: true, deleteAfterTransfer: true},
    {quants},
  );
  expect(cmd).toBe(`tj get ${REPO} --quant UD-IQ3_S --to cold --delete-after`);
});

test('points at the machine that should run a peer-targeted download', () => {
  // A download runs on whichever server the CLI is pointed at, so a download
  // aimed elsewhere has to say so or it lands on the wrong machine.
  const cmd = buildTjGetCommand(req, {quants, cliUrl: '192.0.2.11:3000'});
  expect(cmd).toBe(`tj --url 192.0.2.11:3000 get ${REPO} --quant UD-IQ3_S`);
});

test('wraps a long selection onto continuation lines', () => {
  const cmd = buildTjGetCommand({
    repoId: REPO,
    branch: 'main',
    filePaths: [shard(2), shard(3), shard(4)],
  });
  expect(cmd).toBe(
    [
      `tj get ${REPO} \\`,
      `  --file ${shard(2)} \\`,
      `  --file ${shard(3)} \\`,
      `  --file ${shard(4)}`,
    ].join('\n'),
  );
});

test('quotes an argument that the shell would otherwise split', () => {
  const cmd = buildTjGetCommand({
    repoId: 'org/repo',
    branch: 'main',
    filePaths: ['some folder/weights.gguf'],
  });
  expect(cmd).toBe("tj get org/repo --file 'some folder/weights.gguf'");
});
