import type {Client} from '@/cli/client';
import type {CommandOutput} from '@/cli/output';
import {fetchPeers} from '@/cli/fetch-peers';
import {peerSlug} from '@/lib/peers/peer-slug';
import type {CliInvocation} from '@/lib/cli/args';
import {renderTable, type Column} from '@/lib/cli/format';
import {formatSize} from '@/lib/format/bytes';
import type {DownloadDiskUsage} from '@/lib/storage/disk-space';

interface DiskRow {
  location: string;
  tier: string;
  free: number;
  total: number;
  reachable: boolean;
}

/**
 * `tj disk` — free and total space on the filesystems holding models, for this
 * machine and (with `--all`) every peer.
 *
 * Reports the models and cold-storage filesystems separately, except when they
 * are the same device: there their free space is one pool, and listing it twice
 * would suggest twice the headroom actually available.
 */
export async function disk(
  client: Client,
  inv: CliInvocation,
  color: boolean,
): Promise<CommandOutput> {
  const rows: DiskRow[] = [];

  const add = (location: string, usage: DownloadDiskUsage | null) => {
    if (!usage) {
      rows.push({location, tier: '—', free: 0, total: 0, reachable: false});
      return;
    }
    rows.push({
      location,
      tier: usage.sameDevice ? 'models+cold' : 'models',
      free: usage.models.free,
      total: usage.models.total,
      reachable: true,
    });
    if (!usage.sameDevice) {
      rows.push({
        location,
        tier: 'cold',
        free: usage.cold.free,
        total: usage.cold.total,
        reachable: true,
      });
    }
  };

  add('local', await client.tryJson<DownloadDiskUsage>('/api/v1/disk-usage'));

  if (inv.all) {
    const peers = await fetchPeers(client);
    const remote = peers.filter((p) => !p.isLocal);
    const usages = await Promise.all(
      remote.map(async (p) => ({
        slug: peerSlug(p),
        usage: await client.tryJson<DownloadDiskUsage>(
          `/api/v1/peers/${peerSlug(p)}/disk-usage`,
        ),
      })),
    );
    for (const {slug, usage} of usages) add(slug, usage);
  }

  const columns: Column<DiskRow>[] = [
    {header: 'LOCATION', value: (r) => r.location},
    {header: 'TIER', value: (r) => r.tier},
    {
      header: 'FREE',
      value: (r) => (r.reachable ? formatSize(r.free) : 'unreachable'),
      align: 'right',
    },
    {
      header: 'TOTAL',
      value: (r) => (r.reachable ? formatSize(r.total) : ''),
      align: 'right',
    },
    {
      header: 'USED%',
      value: (r) =>
        r.reachable && r.total > 0
          ? `${Math.round(((r.total - r.free) / r.total) * 100)}%`
          : '',
      align: 'right',
    },
  ];

  return {
    json: rows,
    table: renderTable(columns, rows, color),
    quiet: rows.map((r) => `${r.location}\t${r.free}`),
  };
}
