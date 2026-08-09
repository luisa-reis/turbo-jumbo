import {CliError, type Client} from '@/cli/client';
import {fetchPeers} from '@/cli/fetch-peers';
import {peerSlug} from '@/lib/peers/peer-slug';

/**
 * One of the three places models live, resolved from `--cold` / `--peer` or
 * from an explicit `--from`. Shared by the commands that address a single tier
 * (`audit`, `rm`), which each need the same four spellings of it: the endpoint
 * to list it, the endpoint to delete from it, the `location` value the audit
 * API expects, and a name to print.
 */
export type Location =
  | {kind: 'local'}
  | {kind: 'cold'}
  | {kind: 'peer'; slug: string; address: string};

/** Resolve a `local` / `cold` / peer-slug name, or fail naming the choices. */
export async function resolveLocationName(
  client: Client,
  name: string,
): Promise<Location> {
  if (name === 'local') return {kind: 'local'};
  if (name === 'cold' || name === 'cold-storage') return {kind: 'cold'};
  const peers = await fetchPeers(client);
  const peer = peers.find((p) => peerSlug(p) === name);
  if (!peer) {
    throw new CliError(
      `Unknown location '${name}'. Try local, cold, or a peer slug: ` +
        `${peers.map(peerSlug).join(', ') || '(no peers configured)'}`,
    );
  }
  return {kind: 'peer', slug: peerSlug(peer), address: peer.address};
}

/** Resolve from the `--cold` / `--peer` flags, defaulting to local storage. */
export async function resolveLocationFlags(
  client: Client,
  flags: {cold: boolean; peer?: string},
): Promise<Location> {
  if (flags.cold) return {kind: 'cold'};
  if (flags.peer) return resolveLocationName(client, flags.peer);
  return {kind: 'local'};
}

/** `/api/v1/audit` names a peer by address, not by slug. */
export const locationParam = (l: Location) =>
  l.kind === 'cold' ? 'cold-storage' : l.kind === 'local' ? 'local' : l.address;

export const modelsPath = (l: Location) =>
  l.kind === 'cold'
    ? '/api/v1/cold-storage'
    : l.kind === 'local'
      ? '/api/v1/local-models'
      : `/api/v1/peers/${l.slug}/models`;

/** Where a DELETE for this tier goes. Same route as its listing, by design. */
export const deletePath = modelsPath;

export const describeLocation = (l: Location) =>
  l.kind === 'cold' ? 'cold storage' : l.kind === 'local' ? 'local' : l.slug;
