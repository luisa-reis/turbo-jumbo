import fs from 'fs';
import os from 'os';
import path from 'path';
import {load as loadYaml} from 'js-yaml';
import Ajv2020 from 'ajv/dist/2020';
import schema from '@/config.schema.json';
import {peerSlugError} from '@/lib/peers/peer-slug';

export interface Peer {
  name: string;
  address: string; // host:port the peer serves on
  // URL-safe identity (see lib/peers/peer-slug.ts). Optional; derived from the
  // name when unset.
  slug?: string;
  // Where this peer keeps models. Both optional: a local peer with no
  // base_path holds no models (see localModelsPeer), and a host can have cold
  // storage without fast storage or vice versa. Remote peers manage their own
  // paths; the values are meaningful only on the peer they describe.
  base_path?: string;
  cold_storage_path?: string;
  // Subdirectory names under base_path; default to turbo-jumbo / lemonade.
  turbo_jumbo_subdir?: string;
  lemonade_subdir?: string;
  // API base URL of the Lemonade server tied to this peer, for browsing and
  // downloading the models only that server can fetch (FLM/NPU).
  lemonade_url?: string;
  // host:port of a standalone storage agent serving this peer's disks. When
  // set, storage operations and transfers go to the agent instead of the full
  // app at `address` (see lib/storage/peer-storage.ts).
  agent_address?: string;
  // Set by the /api/v1/peers response for the peer that is this machine.
  isLocal?: boolean;
}

/** A peer as config.yaml spells it: the Peer above plus its secrets, which
 *  never make it onto the Peer object — see withoutSecrets. */
export interface RawPeer extends Peer {
  // The Lemonade server's API key, when it was started with LEMONADE_API_KEY.
  lemonade_api_key?: string;
  // The bearer token the peer's standalone agent requires, if any.
  agent_token?: string;
}

export interface Config {
  peers: Peer[];
  log_level?: string;
  peer_check_interval?: number;
}

interface RawConfig extends Omit<Config, 'peers'> {
  peers: RawPeer[];
}

const validate = new Ajv2020({allErrors: true}).compile<RawConfig>(schema);

/**
 * Validate a parsed config object against config.schema.json. Returns null if
 * valid, or a human-readable summary of every violation otherwise. The schema
 * covers structure and types; the cross-peer slug rules it can't express are
 * checked on top of it.
 */
export function validateRawConfig(raw: unknown): string | null {
  if (validate(raw)) return peerSlugError(raw.peers);
  return (validate.errors ?? [])
    .map((e) => {
      const where = e.instancePath || '(root)';
      if (e.keyword === 'additionalProperties') {
        return `${where} has unknown property "${e.params.additionalProperty}"`;
      }
      return `${where} ${e.message}`;
    })
    .join('; ');
}

function configPath(): string {
  return process.env.CONFIG_PATH ?? `${process.cwd()}/config.yaml`;
}

/**
 * Split the secrets out of freshly parsed peers. Peer objects travel far —
 * into page shells, client component props, and API responses — so rather
 * than stripping the key at every exit, it never gets onto the object: the
 * only way to it is lemonadeApiKey(), which the routes talking to that
 * server call.
 */
export function withoutSecrets(raw: RawPeer[]): {
  peers: Peer[];
  lemonadeKeys: WeakMap<Peer, string>;
  agentTokens: WeakMap<Peer, string>;
} {
  const lemonadeKeys = new WeakMap<Peer, string>();
  const agentTokens = new WeakMap<Peer, string>();
  const peers = raw.map(({lemonade_api_key, agent_token, ...peer}) => {
    if (lemonade_api_key) lemonadeKeys.set(peer, lemonade_api_key);
    if (agent_token) agentTokens.set(peer, agent_token);
    return peer;
  });
  return {peers, lemonadeKeys, agentTokens};
}

let lemonadeKeys = new WeakMap<Peer, string>();
let agentTokens = new WeakMap<Peer, string>();

/** The API key for a peer's Lemonade server, when config.yaml gives one. */
export function lemonadeApiKey(peer: Peer): string | undefined {
  return lemonadeKeys.get(peer);
}

/** The bearer token for a peer's standalone agent, when config.yaml gives
 *  one. Only lib/storage/peer-storage.ts should need it. */
export function agentToken(peer: Peer): string | undefined {
  return agentTokens.get(peer);
}

function loadConfig(): Config {
  const file = configPath();
  const loaded = loadYaml(fs.readFileSync(file, 'utf8'));
  const error = validateRawConfig(loaded);
  if (error) throw new Error(`Invalid config at ${file}: ${error}`);
  const raw = loaded as RawConfig;
  const split = withoutSecrets(raw.peers);
  lemonadeKeys = split.lemonadeKeys;
  agentTokens = split.agentTokens;
  return {...raw, peers: split.peers};
}

// Loaded once when this module is first imported (on server boot).
export const config = loadConfig();

// The host part of "host:port" (also strips IPv6 brackets).
function addressHost(address: string): string {
  return address.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
}

// The local peer is the one whose address host matches one of this machine's
// own IP addresses. undefined when none match — which is allowed: a machine
// that is in nobody's peer list can still run the UI against the peers it
// lists (see localModelsPeer).
export const localPeer: Peer | undefined = (() => {
  const localIps = new Set(
    Object.values(os.networkInterfaces())
      .flat()
      .filter((ni): ni is os.NetworkInterfaceInfo => ni != null)
      .map((ni) => ni.address),
  );
  return config.peers.find((p) => localIps.has(addressHost(p.address)));
})();

/**
 * The turbo-jumbo (local models) and Lemonade directories for a peer, derived
 * from its base_path and optional subdir-name overrides. Defaults: models live
 * in <base>/turbo-jumbo and Lemonade's cache in <base>/lemonade.
 */
export function resolveBaseSubdirs(peer: Peer): {
  localModels: string;
  lemonade: string;
} {
  const base = peer.base_path!;
  return {
    localModels: path.join(base, peer.turbo_jumbo_subdir ?? 'turbo-jumbo'),
    lemonade: path.join(base, peer.lemonade_subdir ?? 'lemonade'),
  };
}

// The local peer's model directories. undefined when no local peer matches
// this machine.
export const localModelsDir: string | undefined = localPeer?.base_path
  ? resolveBaseSubdirs(localPeer).localModels
  : undefined;

export const coldStorageDir: string | undefined = localPeer?.cold_storage_path;

// Lemonade keeps its own model cache. The scanner skips it (see
// lib/models/models.ts's scanModels) so Lemonade's copies don't show up as local
// models.
export const lemonadeDir: string | undefined = localPeer?.base_path
  ? resolveBaseSubdirs(localPeer).lemonade
  : undefined;

/**
 * The two halves of that cache, each a Hugging Face cache tree in its own right.
 *
 * `builtin` holds the models Lemonade itself knows — the ones its catalog lists,
 * plus the FastFlowLM tags it serves — and is what Lemonade is pointed at as its
 * cache root. `extra` holds the rest in the same layout, so Lemonade can be
 * given it as a second root and serve models its catalog never listed.
 *
 * Splitting them is what lets the second kind exist at all: one directory could
 * only ever hold what Lemonade already believed in.
 */
export const lemonadeBuiltinDir: string | undefined = lemonadeDir
  ? path.join(lemonadeDir, 'builtin')
  : undefined;

export const lemonadeExtraDir: string | undefined = lemonadeDir
  ? path.join(lemonadeDir, 'extra')
  : undefined;

/** Whether this host has fast model storage / a cold-storage archive. */
export const hasModelStorage = localModelsDir !== undefined;
export const hasColdStorage = coldStorageDir !== undefined;

/**
 * This machine as a model location: the local peer, only when it has model
 * storage. Undefined on a viewer — a local peer without base_path, or a
 * machine that isn't in the peer list at all — which runs the UI and drives
 * the other peers but holds no models, so nothing may offer it as a place to
 * put them.
 */
export const localModelsPeer: Peer | undefined = hasModelStorage
  ? localPeer
  : undefined;

/**
 * The peers to present as model locations: every configured peer in config
 * order, each flagged with whether it is this machine — minus this machine
 * when it is a viewer. Pure, so the rule can be tested without a config file.
 */
export function selectModelPeers(
  peers: Peer[],
  local: Peer | undefined,
  localHasModels: boolean,
): Peer[] {
  return peers
    .filter((p) => p !== local || localHasModels)
    .map((p) => ({...p, isLocal: p === local}));
}

/**
 * What the UI and `/api/v1/peers` hand out as the peer list. The proxies under
 * `/api/v1/peers/[slug]` and the peer monitor keep using `config.peers`: they
 * identify the local peer by object identity, which these copies don't share.
 */
export const modelPeers: Peer[] = selectModelPeers(
  config.peers,
  localPeer,
  hasModelStorage,
);
