'use client';

import {useCallback, useMemo, useState} from 'react';
import type {Peer} from '@/lib/config';
import type {Model} from '@/lib/models/models';
import {filePaths} from '@/lib/models/model-types';
import {
  checkpointPresence,
  matchCheckpointFiles,
  type CheckpointStatusRow,
  type InventoryLocation,
} from '@/lib/lemonade/lemonade';
import {readCopyAndReportErrors} from '@/lib/storage/copy-progress';
import {buildSourceFiles, resolveSources} from '@/lib/copy/source-files';

/** A place a missing checkpoint can be recovered from, for a remedy button. */
export interface RecoverySource {
  key: string; // 'cold-storage', or the source peer's address
  label: string; // 'cold storage', or the peer's display name
}

interface ResolvedSource extends RecoverySource {
  models: Model[];
}

/**
 * Copy a missing checkpoint's files onto local storage from wherever a complete
 * copy already lives — cold storage or a peer — for the breakdown hovercard's
 * remedy buttons. Drives the same /api/v1/copy the table's copy flow uses
 * (support files and sidecars ride along there); a peer→local copy runs on the
 * source peer, streaming to this machine's agent, never through the browser.
 * Skips the conflict check: the button only shows for a checkpoint missing
 * locally, so there is nothing to overwrite.
 */
export function useCheckpointRecovery({
  inventoryLocations,
  peerConfigs,
  localPeerAddress,
  onCopied,
}: {
  inventoryLocations: InventoryLocation[];
  peerConfigs: Peer[];
  localPeerAddress: string | null;
  onCopied: () => Promise<void> | void;
}) {
  // The label of the checkpoint being copied; one at a time keeps the progress
  // story simple and the archive/source disk unthrashed.
  const [copyingLabel, setCopyingLabel] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  // Every location a checkpoint could be pulled from — cold storage and the
  // peers — as a copy source. The local peer (the destination) is excluded, as
  // is a peer whose address we can't resolve.
  const sources = useMemo<ResolvedSource[]>(() => {
    const out: ResolvedSource[] = [];
    const cold = inventoryLocations.filter((l) => l.isCold);
    if (cold.length > 0) {
      out.push({
        key: 'cold-storage',
        label: 'cold storage',
        models: cold.flatMap((l) => l.models),
      });
    }
    for (const loc of inventoryLocations) {
      if (loc.isCold || loc.isLocal) continue;
      const address = peerConfigs.find((p) => p.name === loc.name)?.address;
      if (!address || address === localPeerAddress) continue;
      out.push({key: address, label: loc.name, models: loc.models});
    }
    return out;
  }, [inventoryLocations, peerConfigs, localPeerAddress]);

  // The sources that actually hold a **complete** copy of this missing
  // checkpoint — the "Copy from <label>" buttons the breakdown offers. A partial
  // copy is never a source: completing a file from a shorter copy would be
  // skipped and leave it broken, the same rule resolveSources encodes across
  // locations.
  const recoverySourcesFor = useCallback(
    (row: CheckpointStatusRow): RecoverySource[] => {
      if (!localPeerAddress || row.local !== 'none') return [];
      return sources
        .filter(
          (s) => checkpointPresence(row.checkpoint, s.models) === 'complete',
        )
        .map(({key, label}) => ({key, label}));
    },
    [sources, localPeerAddress],
  );

  const copyFrom = useCallback(
    async (row: CheckpointStatusRow, key: string) => {
      if (!localPeerAddress || copyingLabel != null) return;
      const source = sources.find((s) => s.key === key);
      if (!source) return;
      const paths = matchCheckpointFiles(row.checkpoint, source.models).flatMap(
        filePaths,
      );
      const index = resolveSources(
        key === 'cold-storage'
          ? {cold: source.models}
          : {peers: [{address: key, models: source.models}]},
      );
      const files = buildSourceFiles(index, paths);
      if (files.length === 0) {
        setCopyError(`No copy of ${row.label} on ${source.label} was found.`);
        return;
      }
      setCopyingLabel(row.label);
      setCopyError(null);
      try {
        const res = await fetch('/api/v1/copy', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            files,
            toColdStorage: false,
            toPeers: [localPeerAddress],
            deleteAfterCopy: false,
          }),
        });
        if (!res.ok) throw new Error(await res.text());
        await readCopyAndReportErrors(
          res,
          () => {},
          (msg) => setCopyError(msg),
        );
        await onCopied();
      } catch (e) {
        setCopyError(e instanceof Error ? e.message : String(e));
      } finally {
        setCopyingLabel(null);
      }
    },
    [sources, localPeerAddress, copyingLabel, onCopied],
  );

  return {recoverySourcesFor, copyFrom, copyingLabel, copyError};
}
