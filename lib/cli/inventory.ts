import type {ModelRow} from '@/lib/models/model-row';
import type {Model} from '@/lib/models/model-types';
import {fileBasename, fileJoinKey, peerFileKeys} from '@/lib/peers/peer-paths';

/** Location names that aren't peers. Peers appear under their own slug. */
export const LOCAL = 'local';
export const COLD = 'cold';

export interface PeerInventory {
  slug: string;
  /** The peer's models, or null when it couldn't be reached. */
  models: Model[] | null;
}

/** One quantization of one model, and everywhere it is held. */
export interface InventoryRow {
  model: string;
  quant: string;
  size: number;
  locations: string[];
  /** A cold copy exists but doesn't match the source size. */
  coldIncomplete: boolean;
}

export interface InventoryFilter {
  /** Case-insensitive substring of the model name, as the UI's filter works. */
  pattern?: string;
  local?: boolean;
  cold?: boolean;
  peer?: string;
}

/**
 * Flatten the models table into one row per quantization, annotated with every
 * location holding it.
 *
 * Peer membership joins on `fileJoinKey`, the same join the models table and the
 * copy workflow use — a specific basename stands alone, while generic and mmproj
 * names are qualified by model, since they recur across repos. And as in the
 * table, a peer counts as holding a quantization when it has *any* of its files:
 * a peer part-way through receiving a shard set is holding it, not missing it.
 *
 * Unreachable peers are skipped rather than reported absent. "I could not ask"
 * and "it is not there" are different answers, and only `tj peers` is in a
 * position to tell them apart.
 */
export function buildInventory(
  rows: ModelRow[],
  peers: PeerInventory[] = [],
  filter: InventoryFilter = {},
): InventoryRow[] {
  const peerKeys = peers
    .filter((p) => p.models != null)
    .map((p) => ({slug: p.slug, keys: peerFileKeys(p.models!)}));

  const out: InventoryRow[] = [];
  const needle = filter.pattern?.trim().toLowerCase();

  for (const row of rows) {
    if (needle && !row.name.toLowerCase().includes(needle)) continue;

    for (const q of row.quants) {
      const locations: string[] = [];
      if (q.localSize > 0) locations.push(LOCAL);
      if (q.inColdStorage) locations.push(COLD);

      // A quantization held only in cold storage has no local paths, so both
      // sides are needed to ask a peer whether it has this file.
      const basenames = [...q.paths, ...q.coldPaths].map(fileBasename);
      for (const {slug, keys} of peerKeys) {
        if (basenames.some((b) => keys.has(fileJoinKey(row.name, b))))
          locations.push(slug);
      }

      out.push({
        model: row.name,
        quant: q.label,
        size: q.size,
        locations,
        coldIncomplete: q.inColdStorage && !q.coldComplete,
      });
    }
  }

  return out
    .filter((r) => matchesLocation(r, filter))
    .sort((a, b) => a.model.localeCompare(b.model) || cmpQuant(a, b));
}

function matchesLocation(row: InventoryRow, filter: InventoryFilter): boolean {
  if (filter.local && !row.locations.includes(LOCAL)) return false;
  if (filter.cold && !row.locations.includes(COLD)) return false;
  if (filter.peer && !row.locations.includes(filter.peer)) return false;
  return true;
}

// Largest first within a model: choosing among quantizations is mostly a
// question of size, and it matches the download picker's ordering logic.
function cmpQuant(a: InventoryRow, b: InventoryRow): number {
  return b.size - a.size || a.quant.localeCompare(b.quant);
}
