import type {Peer} from '@/lib/config';
import {peerSlug} from '@/lib/peers/peer-slug';
import type {Model} from '@/lib/models/model-types';
import type {PeerInventory} from '@/lib/cli/inventory';
import type {Client} from '@/cli/client';

export type PeerConfig = Peer & {isLocal?: boolean};

export interface PeersResponse {
  peers: PeerConfig[];
  /** Whether the server's own host has a cold-storage archive. */
  coldStorage: boolean;
}

/**
 * The configured peers. `/api/v1/peers` answers from config, so this says who
 * exists, not who is reachable — liveness needs a probe (see `tj peers`).
 * The server's own host is among them only when it holds models; a viewer
 * that merely drives the others is nobody's location.
 */
export async function fetchPeers(client: Client): Promise<PeerConfig[]> {
  return (await fetchPeersResponse(client)).peers;
}

export async function fetchPeersResponse(
  client: Client,
): Promise<PeersResponse> {
  return client.json<PeersResponse>('/api/v1/peers');
}

/**
 * Every remote peer's models, fetched through the local server's proxies in
 * parallel. A peer that doesn't answer yields `models: null` rather than
 * failing the command — one machine being off shouldn't stop the others being
 * listed. The local peer is skipped: its models are already in the models table.
 */
export async function fetchPeerModels(
  client: Client,
  peers: PeerConfig[],
): Promise<PeerInventory[]> {
  const remote = peers.filter((p) => !p.isLocal);
  return Promise.all(
    remote.map(async (p) => {
      const slug = peerSlug(p);
      return {
        slug,
        models: await client.tryJson<Model[]>(`/api/v1/peers/${slug}/models`),
      };
    }),
  );
}
