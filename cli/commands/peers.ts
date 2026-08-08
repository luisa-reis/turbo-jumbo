import type {Client} from '@/cli/client';
import type {CommandOutput} from '@/cli/output';
import {fetchPeers} from '@/cli/fetch-peers';
import {peerSlug} from '@/lib/peers/peer-slug';
import {renderTable, type Column} from '@/lib/cli/format';

interface PeerRow {
  slug: string;
  name: string;
  address: string;
  local: boolean;
  reachable: boolean;
  version: string;
}

/**
 * `tj peers` — the configured peers and whether each answers.
 *
 * `/api/v1/peers` reports configuration, not liveness, so each peer is probed
 * for its version. A peer being down is reported, not raised: the command still
 * exits 0, because "that machine is off" is an answer, not a failure.
 */
export async function peers(
  client: Client,
  color: boolean,
): Promise<CommandOutput> {
  const configured = await fetchPeers(client);

  const rows: PeerRow[] = await Promise.all(
    configured.map(async (p) => {
      const slug = peerSlug(p);
      const v = await client.tryJson<{version: string; dev?: boolean}>(
        `/api/v1/peers/${slug}/version`,
      );
      return {
        slug,
        name: p.name,
        address: p.address,
        local: p.isLocal === true,
        reachable: v != null,
        version: v ? `${v.version}${v.dev ? ' (dev)' : ''}` : '',
      };
    }),
  );

  const columns: Column<PeerRow>[] = [
    {header: 'SLUG', value: (r) => r.slug},
    {header: 'NAME', value: (r) => r.name},
    {header: 'ADDRESS', value: (r) => r.address},
    {header: 'STATUS', value: (r) => status(r)},
    {header: 'VERSION', value: (r) => r.version},
  ];

  return {
    json: rows,
    table: renderTable(columns, rows, color),
    quiet: rows.filter((r) => r.reachable).map((r) => r.slug),
  };
}

function status(r: PeerRow): string {
  if (!r.reachable) return 'unreachable';
  return r.local ? 'up (this machine)' : 'up';
}
