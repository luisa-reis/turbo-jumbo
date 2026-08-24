/**
 * The storages this control host drives: its own, and one `HttpStorage` per
 * remote peer — a full app answering at `/api/v1/storage` today, a thin
 * agent after the cutover, indistinguishable on purpose.
 *
 * Server-only (config-wired), like storage-instance. The copy and check
 * routes speak entirely in these sites; nothing below them knows which
 * machine a byte lives on.
 */

import {
  agentToken,
  config,
  hasColdStorage,
  hasModelStorage,
  localPeer,
} from '@/lib/config';
import {createHttpStorage} from '@/lib/storage/http-storage';
import type {Site} from '@/lib/storage/site';
import {storage} from '@/lib/storage/storage-instance';
import type {Storage} from '@/lib/storage/storage';

/**
 * Where a peer's storage answers, and the token it wants: the standalone
 * agent named by the peer's `agent_address` when one is configured, else the
 * full app at the peer's own address — the same protocol either way. This is
 * also what a `send` spec carries as its destination, so the token an agent
 * requires travels from this host's config, never between agents.
 */
export function agentTargetFor(peerAddr: string): {
  url: string;
  token?: string;
} {
  const peer = config.peers.find((p) => p.address === peerAddr);
  if (peer?.agent_address) {
    const token = agentToken(peer);
    return {
      url: `http://${peer.agent_address}/api/v1/storage`,
      ...(token !== undefined ? {token} : {}),
    };
  }
  return {url: `http://${peerAddr}/api/v1/storage`};
}

// One client per address: callers get the same memo behavior LocalStorage
// gives, and nothing constructs a second client to the same machine.
const remotes = new Map<string, Storage>();

// A machine that answers none of this within half a minute is down, not
// slow — and only the bounded verbs get the deadline; hashes and jobs run
// as long as they run.
const PEER_TIMEOUT_MS = 30_000;

/** This host's own storage when the address is its own peer entry, an
 *  `HttpStorage` on the peer's protocol root otherwise. */
export function storageForPeer(peerAddr: string): Storage {
  if (peerAddr === localPeer?.address) return storage;
  let s = remotes.get(peerAddr);
  if (!s) {
    s = createHttpStorage({
      ...agentTargetFor(peerAddr),
      timeoutMs: PEER_TIMEOUT_MS,
    });
    remotes.set(peerAddr, s);
  }
  return s;
}

/**
 * A copy-route source or destination name as a `Site`: `cold-storage` is
 * this host's cold mount (the archive is one shared filesystem, so any
 * machine's view of it answers), a peer address is that peer's models root.
 * Null for a tier this host has not configured — the caller answers 400 or
 * skips, rather than resolving paths against nothing.
 */
export function siteForName(name: string): Site | null {
  if (name === 'cold-storage') {
    return hasColdStorage ? {storage, root: 'cold'} : null;
  }
  if (name === localPeer?.address) {
    return hasModelStorage ? {storage, root: 'models'} : null;
  }
  return {storage: storageForPeer(name), root: 'models'};
}
