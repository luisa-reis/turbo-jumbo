import {test, expect} from 'bun:test';
import {buildDownloadScript} from '@/lib/hf/download-command';

const req = {
  repoId: 'unsloth/DeepSeek-V4-Flash-0731-GGUF',
  branch: 'main',
  filePaths: [
    'UD-IQ3_S/DeepSeek-V4-Flash-0731-UD-IQ3_S-00001-of-00004.gguf',
    'UD-IQ3_S/DeepSeek-V4-Flash-0731-UD-IQ3_S-00002-of-00004.gguf',
  ],
};

test('cds to the models directory and downloads into the repo below it', () => {
  const s = buildDownloadScript(req, '/mnt/models/turbo-jumbo');
  expect(s).toContain('cd "/mnt/models/turbo-jumbo"');
  // The server downloads into <models>/<repoId>; having cd'd, --local-dir is
  // that path relative to where we now stand.
  expect(s).toContain(
    '--local-dir "unsloth/DeepSeek-V4-Flash-0731-GGUF" --revision main',
  );
  expect(s).toContain(
    '--include "UD-IQ3_S/DeepSeek-V4-Flash-0731-UD-IQ3_S-00001-of-00004.gguf"',
  );
});

test('writes the sidecar to /tmp and copies it into the model directory', () => {
  const s = buildDownloadScript(req, '/mnt/models/turbo-jumbo');
  expect(s).toContain("cat > /tmp/tjmodel.json <<'JSON'");
  expect(s).toContain(
    'cp /tmp/tjmodel.json "unsloth/DeepSeek-V4-Flash-0731-GGUF/tjmodel.json"',
  );
});

test('the sidecar heredoc holds the JSON the app itself would write', () => {
  const s = buildDownloadScript(req, '/mnt/models/turbo-jumbo');
  const body = s.split("<<'JSON'\n")[1].split('\nJSON\n')[0];
  expect(JSON.parse(body)).toEqual({
    modelUrl: 'https://huggingface.co/unsloth/DeepSeek-V4-Flash-0731-GGUF',
    repoId: 'unsloth/DeepSeek-V4-Flash-0731-GGUF',
    files: [],
  });
});

test('a non-default branch is recorded as the model revision', () => {
  const s = buildDownloadScript({...req, branch: 'v0.9.20'}, '/m');
  const body = s.split("<<'JSON'\n")[1].split('\nJSON\n')[0];
  expect(JSON.parse(body).revision).toBe('v0.9.20');
  expect(s).toContain('--revision v0.9.20');
});

test('main is left out of the sidecar, being the default', () => {
  const s = buildDownloadScript(req, '/m');
  const body = s.split("<<'JSON'\n")[1].split('\nJSON\n')[0];
  expect('revision' in JSON.parse(body)).toBe(false);
});

test('a models directory with spaces stays quoted', () => {
  const s = buildDownloadScript(req, '/mnt/my models/tj');
  expect(s).toContain('cd "/mnt/my models/tj"');
});
