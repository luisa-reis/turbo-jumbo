import {
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type {Model} from '@/lib/models/models';
import type {AsyncState} from '@/lib/util/async-state';
import {
  readCopyAndReportErrors,
  type CopyProgress,
} from '@/lib/storage/copy-progress';
import {
  readCheckStream,
  type CheckProgress,
} from '@/lib/storage/check-progress';
import {type CopyDestinations} from '@/components/models/copy-modal';
import {type ConflictItem} from '@/components/models/conflicts-modal';
import {
  buildSourceFiles,
  preferLocation,
  resolveSources,
  type SourceFile,
} from '@/lib/copy/source-files';
import {COLD_STORAGE_LOCATION} from '@/lib/storage/locations';

/**
 * The copy workflow: the conflict-check → optional conflicts-modal → copy
 * pipeline, the cold-storage-resume fix, and the copy progress state. Per-path
 * source resolution lives in `lib/copy/source-files`, shared with `tj copy`.
 * The shared pieces this touches — the selection, the audit reset and the
 * models refresh — are passed in.
 */
export function useCopyWorkflow({
  selected,
  setSelected,
  resetAudit,
  refreshModels,
  setError,
  coldModels,
  localPeerAddress,
  seededPeerModels,
  activeLocation,
}: {
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  resetAudit: () => void;
  refreshModels: () => Promise<void>;
  setError: Dispatch<SetStateAction<string | null>>;
  coldModels: Model[];
  localPeerAddress: string | null;
  seededPeerModels: Map<string, AsyncState<Model[]>>;
  // The tab the copy is started from: `all`, `cold-storage`, or a peer address.
  activeLocation: string;
}) {
  const [confirmingCopy, setConfirmingCopy] = useState(false);
  const [copying, setCopying] = useState(false);
  // A single-file recovery copy (audit hovercard's "Copy from <source>") is in
  // flight. Separate from `copying` so it disables only the recovery button.
  const [recovering, setRecovering] = useState(false);
  const [copyProgress, setCopyProgress] = useState<CopyProgress | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkProgress, setCheckProgress] = useState<CheckProgress | null>(
    null,
  );
  // Aborts the in-flight conflict check. The server stops between files when
  // the request is aborted, so a check that turned out to need real hashing
  // can be abandoned instead of waited out.
  const checkAbort = useRef<AbortController | null>(null);
  // Aborts the running copy. The server cancels every transfer still in
  // flight when the request goes away, and deletes no sources (a move's
  // deletes run only after all transfers finish).
  const copyAbort = useRef<AbortController | null>(null);
  const [pendingConflicts, setPendingConflicts] = useState<ConflictItem[]>([]);
  const [pendingDestinations, setPendingDestinations] =
    useState<CopyDestinations | null>(null);
  // The checked file list held for the conflicts modal round-trip: the check
  // expands the selection with support files (config/tokenizer/…), and the
  // copy must send exactly the list the check reported on.
  const [pendingFiles, setPendingFiles] = useState<SourceFile[] | null>(null);

  // Per-path presence + size across cold storage, local, and remote peers, so
  // a mixed selection can name each file's own source. The resolution rules
  // (largest copy wins; cold → local → remote on a tie) live in
  // `lib/copy/source-files`, shared with `tj copy` so the CLI and the UI can't
  // disagree about which copy of a file is authoritative.
  const pathPresence = useMemo(() => {
    const value = (address: string) => {
      const lo = seededPeerModels.get(address);
      return lo?.type === 'value' ? lo.value : null;
    };
    // The local peer resolves from the same polled map the table renders
    // from (seeded from server data until the first poll lands), so anything
    // selectable is copyable — server-rendered props alone go stale the
    // moment a download finishes, and copies would silently resolve to zero
    // source files.
    const localModels = localPeerAddress ? value(localPeerAddress) : null;
    return resolveSources({
      cold: coldModels,
      local:
        localPeerAddress && localModels
          ? {address: localPeerAddress, models: localModels}
          : undefined,
      peers: [...seededPeerModels]
        .filter(([addr]) => addr !== localPeerAddress)
        .flatMap(([address, lo]) =>
          lo.type === 'value' ? [{address, models: lo.value}] : [],
        ),
    });
  }, [coldModels, localPeerAddress, seededPeerModels]);

  function buildSourceFilesFor(paths: Iterable<string>): SourceFile[] {
    return buildSourceFiles(pathPresence, paths);
  }

  // The selection's sources for a copy the user starts: from a location's tab,
  // that location's own copies (see `preferLocation`); from All, the most
  // complete copy anywhere.
  const selectionSources = useMemo(() => {
    if (activeLocation === 'all') return pathPresence;
    const at =
      activeLocation === COLD_STORAGE_LOCATION
        ? resolveSources({cold: coldModels})
        : (() => {
            const lo = seededPeerModels.get(activeLocation);
            return lo?.type === 'value'
              ? resolveSources({
                  peers: [{address: activeLocation, models: lo.value}],
                })
              : null;
          })();
    return at ? preferLocation(at, pathPresence) : pathPresence;
  }, [activeLocation, coldModels, seededPeerModels, pathPresence]);

  function sourceFilesForSelection() {
    return buildSourceFiles(selectionSources, selected);
  }

  async function onCopy(destinations: CopyDestinations) {
    setConfirmingCopy(false);
    // Refuse rather than quietly copy a subset (or nothing): every selected
    // path must resolve to a source.
    const sourceFiles = sourceFilesForSelection();
    if (sourceFiles.length < selected.size) {
      setError(
        'Some selected files have no known source yet — wait for the table to refresh and retry.',
      );
      return;
    }
    setChecking(true);
    setCheckProgress(null);
    setError(null);
    let hasConflicts = false;
    let hasError = false;
    let cancelled = false;
    let filesToCopy: SourceFile[] = sourceFiles;
    const abort = new AbortController();
    checkAbort.current = abort;
    try {
      const res = await fetch('/api/v1/copy/check', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        signal: abort.signal,
        body: JSON.stringify({
          files: sourceFiles,
          toColdStorage: destinations.toColdStorage,
          toPeers: destinations.toPeers,
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      // The check streams progress and ends with its verdict; no result frame
      // means it was abandoned, and nothing should be copied.
      const result = await readCheckStream<ConflictItem, SourceFile>(
        res,
        setCheckProgress,
      );
      if (!result) {
        cancelled = true;
      } else {
        // The check expands the selection with the support files living in
        // the same model directories; the copy sends that expanded list.
        filesToCopy = result.files ?? sourceFiles;
        if (result.conflicts.length > 0) {
          hasConflicts = true;
          setPendingConflicts(result.conflicts);
          setPendingDestinations(destinations);
          setPendingFiles(filesToCopy);
        }
      }
    } catch (e) {
      if (abort.signal.aborted) {
        cancelled = true;
      } else {
        hasError = true;
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      checkAbort.current = null;
      setChecking(false);
      setCheckProgress(null);
    }
    if (!hasConflicts && !hasError && !cancelled)
      await doCopy(destinations, [], filesToCopy);
  }

  // Abandon a running check. The copy never starts: the user asked to stop.
  const cancelCheck = () => checkAbort.current?.abort();
  const cancelCopy = () => copyAbort.current?.abort();

  // POST a copy and follow its progress stream to the end. Resolves true when
  // it ran to completion, false when it was cancelled; any other failure
  // throws.
  async function runCopyRequest(body: object): Promise<boolean> {
    const abort = new AbortController();
    copyAbort.current = abort;
    try {
      const res = await fetch('/api/v1/copy', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      await readCopyAndReportErrors(res, setCopyProgress, setError);
      return true;
    } catch (e) {
      if (abort.signal.aborted) return false;
      throw e;
    } finally {
      if (copyAbort.current === abort) copyAbort.current = null;
    }
  }

  async function onConflictsConfirm(
    skip: Array<{file: string; destination: string}>,
  ) {
    if (!pendingDestinations) return;
    const dest = pendingDestinations;
    const files = pendingFiles ?? sourceFilesForSelection();
    setPendingConflicts([]);
    setPendingDestinations(null);
    setPendingFiles(null);
    await doCopy(dest, skip, files);
  }

  async function doCopy(
    destinations: CopyDestinations,
    skip: Array<{file: string; destination: string}>,
    files: SourceFile[],
  ) {
    setCopying(true);
    setCopyProgress(null);
    setError(null);
    try {
      const finished = await runCopyRequest({files, ...destinations, skip});
      // A cancelled copy keeps the selection, so copying it again resumes.
      if (finished) {
        setSelected(new Set());
        resetAudit();
      }
      await refreshModels();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCopying(false);
      setCopyProgress(null);
    }
  }

  // Complete a partial cold-storage copy: re-copy the affected files to cold
  // storage from their most complete copy. pathPresence resolves each file to
  // its largest copy, so the truncated cold copy loses to the full one whether
  // that lives locally or on a peer — completing the cold copy works from any
  // tab. The server resumes from the verified prefix already in cold storage, so
  // only the missing tail is transferred. Bypasses the conflict check (skip:[])
  // — overwriting the partial copy is the point.
  async function onFixColdIncomplete(paths: string[]) {
    if (paths.length === 0) return;
    // A file whose only copy is the cold one can't be completed from a copy
    // (cold → cold is a no-op); drop those so we never send an empty transfer.
    const files = buildSourceFilesFor(paths).filter(
      (f) => f.from !== 'cold-storage',
    );
    if (files.length === 0) return;
    setCopying(true);
    setCopyProgress(null);
    setError(null);
    try {
      await runCopyRequest({
        files,
        toColdStorage: true,
        toPeers: [],
        deleteAfterCopy: false,
        skip: [],
      });
      await refreshModels();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCopying(false);
      setCopyProgress(null);
    }
  }

  // Where a single file can be recovered from: its largest complete copy across
  // cold storage and the peers, by exact path. A missing file (an absent
  // projector, a gap in a shard set) sits at the same `<repoId>/<file>` path on
  // any machine that holds it, so the path-keyed index finds it. Used by the
  // audit hovercard to offer "Copy from <source>" beside the HF re-download.
  function recoverySourceFor(path: string): SourceFile | undefined {
    return buildSourceFilesFor([path])[0];
  }

  // Pull one missing file onto `destAddress` from the source `recoverySourceFor`
  // found — the audit hovercard's copy-based recovery. A peer→peer or cold→peer
  // copy runs as a job on the machine holding the bytes (this host never carries
  // them). Bypasses the conflict check: the destination doesn't have the file,
  // so there's nothing to overwrite. Refreshes the table so the recovered file
  // (and any flags keyed off it) reflect the new state.
  async function onRecoverFile(destAddress: string, source: SourceFile) {
    if (source.from === destAddress) return;
    setRecovering(true);
    setCopyProgress(null);
    setError(null);
    try {
      await runCopyRequest({
        files: [source],
        toColdStorage: false,
        toPeers: [destAddress],
        deleteAfterCopy: false,
        skip: [],
      });
      await refreshModels();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRecovering(false);
      setCopyProgress(null);
    }
  }

  const cancelConflicts = () => {
    setPendingConflicts([]);
    setPendingDestinations(null);
    setPendingFiles(null);
  };

  return {
    copying,
    copyProgress,
    checking,
    checkProgress,
    cancelCheck,
    cancelCopy,
    confirmingCopy,
    setConfirmingCopy,
    pendingConflicts,
    onCopy,
    onConflictsConfirm,
    onFixColdIncomplete,
    cancelConflicts,
    recoverySourceFor,
    onRecoverFile,
    recovering,
  };
}
