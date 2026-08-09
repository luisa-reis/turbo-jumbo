import {CliError, UsageError, type Client} from '@/cli/client';
import type {CommandOutput} from '@/cli/output';
import {fetchPeerModels, fetchPeers} from '@/cli/fetch-peers';
import type {CliInvocation} from '@/lib/cli/args';
import {renderTable, type Column} from '@/lib/cli/format';
import {buildInventory, type InventoryRow} from '@/lib/cli/inventory';
import {formatSize} from '@/lib/format/bytes';
import type {ModelRow} from '@/lib/models/model-row';

/**
 * `tj where <model>` — the quantizations of one model and where each is held.
 *
 * The same data as `ls`, narrowed to a single model and dropping the model
 * column, for the question "I know I have this somewhere — where?".
 */
export async function where(
  client: Client,
  inv: CliInvocation,
  color: boolean,
): Promise<CommandOutput> {
  const pattern = inv.positionals[0];
  if (!pattern) throw new UsageError('Usage: tj where <model>');

  const [rows, peers] = await Promise.all([
    client.json<ModelRow[]>('/api/v1/models-table'),
    fetchPeers(client),
  ]);
  const peerModels = await fetchPeerModels(client, peers);
  const inventory = buildInventory(rows, peerModels, {pattern});

  if (inventory.length === 0) {
    throw new CliError(`No model matches '${pattern}'.`);
  }

  // A substring can span models; naming them beats silently reporting one.
  const names = [...new Set(inventory.map((r) => r.model))];
  const columns: Column<InventoryRow>[] = [
    ...(names.length > 1
      ? [{header: 'MODEL', value: (r: InventoryRow) => r.model}]
      : []),
    {header: 'QUANT', value: (r: InventoryRow) => r.quant},
    {
      header: 'SIZE',
      value: (r: InventoryRow) => formatSize(r.size),
      align: 'right' as const,
    },
    {
      header: 'WHERE',
      value: (r: InventoryRow) =>
        r.locations
          .map((l) => (l === 'cold' && r.coldIncomplete ? 'cold(partial)' : l))
          .join(', '),
    },
  ];

  return {
    json: inventory,
    table: renderTable(columns, inventory, color),
    lines: inventory.flatMap((r) => r.locations),
  };
}
