import type {Client} from '@/cli/client';
import type {CommandOutput} from '@/cli/output';
import {fetchPeerModels, fetchPeers} from '@/cli/fetch-peers';
import type {CliInvocation} from '@/lib/cli/args';
import {renderTable, type Column} from '@/lib/cli/format';
import {buildInventory, type InventoryRow} from '@/lib/cli/inventory';
import {formatSize} from '@/lib/format/bytes';
import type {ModelRow} from '@/lib/models/model-row';

/**
 * `tj ls` — one row per quantization, with everywhere it is held.
 *
 * The models table already assembles local and cold in a single request; only
 * the peers need a fan-out, and they run in parallel.
 */
export async function ls(
  client: Client,
  inv: CliInvocation,
  color: boolean,
): Promise<CommandOutput> {
  const [rows, peers] = await Promise.all([
    client.json<ModelRow[]>('/api/v1/models-table'),
    fetchPeers(client),
  ]);
  const peerModels = await fetchPeerModels(client, peers);

  const inventory = buildInventory(rows, peerModels, {
    pattern: inv.positionals[0],
    local: inv.local,
    cold: inv.cold,
    peer: inv.peer,
  });

  const columns: Column<InventoryRow>[] = [
    {header: 'MODEL', value: (r) => r.model},
    {header: 'QUANT', value: (r) => r.quant},
    {header: 'SIZE', value: (r) => formatSize(r.size), align: 'right'},
    {header: 'WHERE', value: (r) => where(r)},
  ];

  return {
    json: inventory,
    table: renderTable(columns, inventory, color),
    // The model name alone: what you would feed to another command.
    lines: [...new Set(inventory.map((r) => r.model))],
  };
}

// Cold storage is called out when the copy is there but undersized, since
// "cold" would otherwise promise a copy that can't be restored from.
function where(r: InventoryRow): string {
  return r.locations
    .map((l) => (l === 'cold' && r.coldIncomplete ? 'cold(partial)' : l))
    .join(', ');
}
