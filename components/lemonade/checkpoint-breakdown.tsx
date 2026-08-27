'use client';

import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Badge} from '@astryxdesign/core/Badge';
import {Button} from '@astryxdesign/core/Button';
import type {CheckpointStatusRow, Presence} from '@/lib/lemonade/lemonade';
import type {RecoverySource} from '@/components/lemonade/use-checkpoint-recovery';

const PRESENCE_BADGE: Record<
  Presence,
  {label: string; variant: 'green' | 'orange' | 'error' | 'neutral'}
> = {
  complete: {label: 'present', variant: 'green'},
  partial: {label: 'partial', variant: 'orange'},
  none: {label: 'missing', variant: 'error'},
  untracked: {label: 'untracked', variant: 'neutral'},
};

// Where a checkpoint stands, as one supporting line: its local state, then —
// for a missing one — the nearest place a copy already exists, because that
// is what decides the remedy (copy from cold, fetch from a peer, or download).
function whereabouts(row: CheckpointStatusRow): string {
  if (row.local === 'complete')
    return row.inCache
      ? "downloaded · in Lemonade's cache"
      : "downloaded · not yet in Lemonade's cache (sync places it)";
  if (row.local === 'partial') return 'partially downloaded';
  if (row.local === 'untracked') return 'not tracked by the file scan';
  const parts = ['missing locally'];
  if (row.cold === 'complete' || row.cold === 'partial')
    parts.push('in cold storage');
  if (row.peers.length > 0) parts.push(`on ${row.peers.join(', ')}`);
  if (parts.length === 1) parts.push('Download fetches it from Hugging Face');
  return parts.join(' · ');
}

/**
 * Hovercard body for a multi-checkpoint catalog entry: each checkpoint judged
 * on its own, so a "partial" roll-up says which file is the gap and where a
 * copy already exists. Lemonade only lists the entry once every checkpoint is
 * in its cache, which is why one missing file deserves this much explanation.
 */
export function CheckpointBreakdown({
  rows,
  copyingLabel,
  copyError,
  recoverySourcesFor,
  onCopyFrom,
}: {
  rows: CheckpointStatusRow[];
  copyingLabel?: string | null;
  copyError?: string | null;
  // For a missing checkpoint, the locations a complete copy can be pulled from
  // (cold storage, a peer) — one remedy button each. `onCopyFrom` starts the
  // copy from the chosen source. Absent on tabs where recovery doesn't apply.
  recoverySourcesFor?: (row: CheckpointStatusRow) => RecoverySource[];
  onCopyFrom?: (row: CheckpointStatusRow, key: string) => void;
}) {
  return (
    <VStack gap={3}>
      {rows.map((row) => {
        const badge = PRESENCE_BADGE[row.local];
        const copying = copyingLabel === row.label;
        const sources =
          onCopyFrom != null ? (recoverySourcesFor?.(row) ?? []) : [];
        return (
          <VStack key={row.label} gap={1}>
            <HStack gap={2} vAlign="center">
              <Badge label={badge.label} variant={badge.variant} />
              <Text type="body">{row.label}</Text>
            </HStack>
            <Text type="supporting">{whereabouts(row)}</Text>
            {sources.map((source) => (
              <HStack key={source.key}>
                <Button
                  label={copying ? 'Copying…' : `Copy from ${source.label}`}
                  variant="ghost"
                  size="sm"
                  onClick={() => onCopyFrom?.(row, source.key)}
                  isDisabled={copyingLabel != null}
                />
              </HStack>
            ))}
          </VStack>
        );
      })}
      {copyError && <Text type="supporting">{copyError}</Text>}
    </VStack>
  );
}
