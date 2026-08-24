import {coldStorageSite, localModelsSite} from '@/lib/storage/storage-instance';
import {config, localPeer, type Peer} from '@/lib/config';
import {storageForPeer} from '@/lib/storage/peer-storage';
import type {Site} from '@/lib/storage/site';
import {logger} from '@/lib/util/logger';

export type AuditTarget =
  {kind: 'site'; site: Site} | {kind: 'peer'; peer: Peer};

/**
 * Resolve an audit location to its target: 'local' and 'cold-storage' are
 * this host's own roots; a peer with an `agent_address` is a site too — the
 * audit runs here, over the agent's storage, hashing on the agent's own
 * disk through its hash verb. Only a full-app peer means the request should
 * be proxied to that peer (which audits its own local storage).
 */
export function resolveAuditLocation(
  location: string | undefined,
): AuditTarget | null {
  if (location === 'cold-storage') {
    return coldStorageSite ? {kind: 'site', site: coldStorageSite} : null;
  }
  if (location === 'local') {
    return localModelsSite ? {kind: 'site', site: localModelsSite} : null;
  }
  const peer = config.peers.find((p) => p.address === location);
  if (!peer || peer === localPeer) return null;
  if (peer.agent_address) {
    return {
      kind: 'site',
      site: {storage: storageForPeer(peer.address), root: 'models'},
    };
  }
  return {kind: 'peer', peer};
}

/**
 * Forward an audit request to a peer as a 'local' audit of its own storage
 * and pass the response — streaming NDJSON included — straight through. The
 * caller's abort signal propagates so the peer stops hashing when the browser
 * disconnects.
 */
export async function proxyAuditRequest(
  peer: Peer,
  pathname: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  logger.debug(`[audit] proxy ${pathname} to ${peer.name} (${peer.address})`);
  try {
    const res = await fetch(`http://${peer.address}${pathname}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({...body, location: 'local'}),
      signal,
    });
    return new Response(res.body, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('Content-Type') ?? 'application/json',
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[audit] proxy ${pathname} to ${peer.name} failed: ${msg}`);
    return new Response(msg, {status: 502});
  }
}
