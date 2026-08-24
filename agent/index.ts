/**
 * Entry point: `bun run agent` (or `bun agent/index.ts`). Reads agent.yaml —
 * override the path with TJ_AGENT_CONFIG — and serves the storage protocol.
 * See agent.yaml.sample.
 */

import fs from 'fs';
import {load as loadYaml} from 'js-yaml';
import type {Roots} from '@/lib/storage/local-storage';
import {startAgent} from '@/agent/server';

interface AgentFileConfig {
  port: number;
  token?: string;
  roots: Roots;
}

function fail(message: string): never {
  console.error(`agent: ${message}`);
  process.exit(1);
}

function loadConfig(file: string): AgentFileConfig {
  let raw: unknown;
  try {
    raw = loadYaml(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof raw !== 'object' || raw === null) fail(`${file} is not a map`);
  const cfg = raw as Record<string, unknown>;
  if (!Number.isInteger(cfg.port) || (cfg.port as number) <= 0) {
    fail(`${file}: port must be a positive integer`);
  }
  if (cfg.token !== undefined && typeof cfg.token !== 'string') {
    fail(`${file}: token must be a string`);
  }
  const roots = cfg.roots;
  if (typeof roots !== 'object' || roots === null) {
    fail(`${file}: roots must be a map of models/cold/lemonade directories`);
  }
  const dirs: Roots = {};
  for (const name of ['models', 'cold', 'lemonade'] as const) {
    const dir = (roots as Record<string, unknown>)[name];
    if (dir === undefined) continue;
    if (typeof dir !== 'string' || dir === '') {
      fail(`${file}: roots.${name} must be a directory path`);
    }
    if (!fs.existsSync(dir)) {
      fail(`${file}: roots.${name} (${dir}) does not exist`);
    }
    dirs[name] = dir;
  }
  if (Object.keys(dirs).length === 0) fail(`${file}: no roots configured`);
  const unknown = Object.keys(cfg).filter(
    (k) => !['port', 'token', 'roots'].includes(k),
  );
  if (unknown.length > 0) fail(`${file}: unknown key ${unknown[0]}`);
  return {
    port: cfg.port as number,
    ...(cfg.token !== undefined ? {token: cfg.token as string} : {}),
    roots: dirs,
  };
}

const file = process.env.TJ_AGENT_CONFIG ?? './agent.yaml';
const cfg = loadConfig(file);
if (cfg.token === undefined) {
  console.warn('agent: no token configured — every caller is trusted');
}
const running = startAgent(cfg);
console.log(
  `turbo-jumbo agent listening on :${running.port} ` +
    `(roots: ${Object.keys(cfg.roots).join(', ')})`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    running.stop();
    process.exit(0);
  });
}
