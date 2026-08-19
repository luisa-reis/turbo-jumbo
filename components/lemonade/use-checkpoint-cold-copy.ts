'use client';

import {useCallback, useState} from 'react';
import type {Model} from '@/lib/models/models';
import {filePaths} from '@/lib/models/model-types';
import {
  matchCheckpointFiles,
  type CheckpointStatusRow,
} from '@/lib/lemonade/lemonade';
import {readCopyAndReportErrors} from '@/lib/storage/copy-progress';
import {buildSourceFiles, resolveSources} from '@/lib/copy/source-files';

/**
 * Copy one checkpoint's files from cold storage into local storage, for the
 * breakdown hovercard's remedy button. Drives the same /api/v1/copy the
 * table's copy flow uses — support files and sidecars ride along there — but
 * skips the conflict check: the button only shows for a checkpoint that is
 * missing locally, so there is nothing to overwrite.
 */
export function useCheckpointColdCopy({
  coldModels,
  localPeerAddress,
  onCopied,
}: {
  coldModels: Model[];
  localPeerAddress: string | null;
  onCopied: () => Promise<void> | void;
}) {
  // The label of the checkpoint being copied; one at a time keeps the
  // progress story simple and the archive disk unthrashed.
  const [copyingLabel, setCopyingLabel] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  const copyFromCold = useCallback(
    async (row: CheckpointStatusRow) => {
      if (!localPeerAddress || copyingLabel != null) return;
      const paths = matchCheckpointFiles(row.checkpoint, coldModels).flatMap(
        filePaths,
      );
      const files = buildSourceFiles(resolveSources({cold: coldModels}), paths);
      if (files.length === 0) {
        setCopyError(`No cold-storage copy of ${row.label} was found.`);
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
    [coldModels, localPeerAddress, copyingLabel, onCopied],
  );

  return {copyFromCold, copyingLabel, copyError};
}
