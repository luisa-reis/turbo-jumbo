'use client';

import {useEffect, useMemo, useState} from 'react';
import * as stylex from '@stylexjs/stylex';
import {VStack, HStack, StackItem} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Button} from '@astryxdesign/core/Button';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {List, ListItem} from '@astryxdesign/core/List';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Icon} from '@astryxdesign/core/Icon';
import {Badge} from '@astryxdesign/core/Badge';
import {Banner} from '@astryxdesign/core/Banner';
import {Collapsible} from '@astryxdesign/core/Collapsible';
import {Link} from '@astryxdesign/core/Link';
import {
  DownloadModal,
  buildTjGetCommand,
  useDownloadRunner,
} from '@/components/hf-download/download-runner';
import {copyToClipboard} from '@/lib/util/clipboard';
import type {DownloadTarget} from '@/lib/hf/download-target';
import {
  diskSpaceWarnings,
  type DownloadDiskUsage,
} from '@/lib/storage/disk-space';
import {formatSize} from '@/lib/format/bytes';
import {defaultDownloadSelection, repoDownloadKind} from '@/lib/hf/hf-download';
import {quantGroups, type QuantGroup} from '@/lib/hf/quant-groups';
import {coldStoredPaths} from '@/lib/hf/cold-presence';
import type {RepoCard} from '@/lib/hf/repo-card';
import {parseHfUrl} from '@/lib/hf/hf-url';
import type {Model} from '@/lib/models/model-types';

type HfFile = {path: string; size: number};

// The secondary line on a quantization row: how many of its files are selected
// (a partial set is the whole point of picking files individually, so it's
// spelled out), and which folder holds them when it isn't the repo root.
function groupDetail(g: QuantGroup, selectedCount: number): string | undefined {
  const parts: string[] = [];
  if (g.fileCount > 1)
    parts.push(
      selectedCount > 0 && selectedCount < g.fileCount
        ? `${selectedCount} of ${g.fileCount} files`
        : `${g.fileCount} files`,
    );
  if (g.folder) parts.push(`${g.folder}/`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * How much of a row the target machine already has archived. Silent when it
 * holds none, which is the usual case — the badge is there to catch the
 * expensive mistake of re-fetching gigabytes that are already on a local disk,
 * so it should only speak up when there's something to say.
 */
function ColdBadge({held, total}: {held: number; total: number}) {
  if (held === 0) return null;
  return (
    <Badge
      variant="green"
      label={held === total ? 'In cold storage' : `${held} of ${total} in cold`}
    />
  );
}

const styles = stylex.create({
  // Fixed-height body, matching the Lemonade browser: the dialog must not
  // resize as the file list loads or the filter narrows.
  pickerBody: {height: '55vh', minHeight: 0},
  fileList: {flexGrow: 1, minHeight: 0, overflowY: 'auto'},
  // A quantization's own files, shown only when it's expanded.
  shardRow: {paddingInlineStart: 'var(--spacing-8)'},
  // The card is shown as its own markdown: the repo has no dependency that
  // renders it, and a Files table is legible as source — which is the part
  // people come here to read. Bounded so it can't crowd out the file list.
  cardBody: {
    maxHeight: '24vh',
    overflowY: 'auto',
    whiteSpace: 'pre-wrap',
    fontFamily: 'monospace',
  },
});

/**
 * The Hugging Face download picker, the body of the HF download modal (title
 * and close button live in the dialog header): a URL field, the resolved file
 * list with a filter and cold-storage options, and a Copy/Run footer.
 */
export function HfDownloadPicker({
  target,
  hfTokenSet,
}: {
  target: DownloadTarget;
  hfTokenSet: boolean;
}) {
  const [url, setUrl] = useState('');
  const [sendToCold, setSendToCold] = useState(false);
  const [deleteAfterTransfer, setDeleteAfterTransfer] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  // Free space at the download target (models dir + cold storage), fetched once,
  // to warn before a transfer that wouldn't fit. Null while unknown (loading or
  // unreadable) — no warning.
  const [disk, setDisk] = useState<DownloadDiskUsage | null>(null);
  // The target machine's cold storage, fetched once, to mark files it has
  // already archived. Null while unknown (loading or unreadable) — no marks.
  const [coldModels, setColdModels] = useState<Model[] | null>(null);
  const {
    term,
    progress,
    running,
    command: runCommand,
    start,
    cancel,
    reset,
  } = useDownloadRunner({downloadUrl: target.url, cliUrl: target.cliUrl});
  const [files, setFiles] = useState<HfFile[] | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  // The repo's own card. Null while unknown or absent — plenty of repos ship
  // weights and no card, and the panel simply isn't there.
  const [card, setCard] = useState<RepoCard | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  // Off by default: quantization rows are the whole story for a normal download.
  const [showFiles, setShowFiles] = useState(false);
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());

  // Debounce so we don't hit the HF API on every keypress
  const [debouncedUrl, setDebouncedUrl] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedUrl(url), 400);
    return () => clearTimeout(t);
  }, [url]);

  // Read free space at the target once (best-effort: stay silent if it fails).
  useEffect(() => {
    let cancelled = false;
    fetch(target.diskUsageUrl)
      .then((r) => (r.ok ? (r.json() as Promise<DownloadDiskUsage>) : null))
      .then((d) => {
        if (!cancelled && d) setDisk(d);
      })
      .catch(() => {
        /* unreadable disk: no space warning */
      });
    return () => {
      cancelled = true;
    };
  }, [target.diskUsageUrl]);

  // Read the target's cold storage once (best-effort: a peer that's down, or a
  // host with no cold storage configured, simply gets no marks).
  useEffect(() => {
    let cancelled = false;
    fetch(target.coldStorageUrl)
      .then((r) => (r.ok ? (r.json() as Promise<Model[]>) : null))
      .then((m) => {
        if (!cancelled && m) setColdModels(m);
      })
      .catch(() => {
        /* unreachable: no cold-storage marks */
      });
    return () => {
      cancelled = true;
    };
  }, [target.coldStorageUrl]);

  const parsed = useMemo(
    () => (debouncedUrl.trim() ? parseHfUrl(debouncedUrl.trim()) : null),
    [debouncedUrl],
  );

  // Only show invalid after the debounce has settled (avoids flashing mid-type)
  const isInvalid =
    url.trim() !== '' && url === debouncedUrl && parsed === null;

  // The card follows the repo, not the folder: opening a quantization's
  // directory doesn't change which card describes it, so this refetches on the
  // repo and branch alone.
  const cardRepo = parsed ? `${parsed.repoId}@${parsed.branch}` : null;
  useEffect(() => {
    if (!cardRepo) return;
    const [repoId, branch] = cardRepo.split('@');
    let cancelled = false;
    fetch(`/api/v1/hf-card?${new URLSearchParams({repoId, branch})}`)
      .then((r) => (r.ok ? (r.json() as Promise<RepoCard | null>) : null))
      // A card that won't load is not worth an error: the file list is the
      // job, and the card is context beside it.
      .catch(() => null)
      .then((c) => {
        if (!cancelled) setCard(c);
      });
    return () => {
      cancelled = true;
    };
  }, [cardRepo]);

  // Fetch file list from HF API whenever parsed URL changes. Resetting state
  // synchronously here is the intended "re-sync to the new URL" behaviour.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!parsed) {
      setFiles(null);
      setFilesError(null);
      setFilesLoading(false);
      setCard(null);
      setSelectedPaths(new Set());
      setFilter('');
      setShowFiles(false);
      setOpenKeys(new Set());
      return;
    }
    setFiles(null);
    setFilesError(null);
    setFilesLoading(true);
    setFilter('');
    setShowFiles(false);
    setOpenKeys(new Set());

    const params = new URLSearchParams({
      repoId: parsed.repoId,
      branch: parsed.branch,
    });
    if (parsed.folder) params.set('folder', parsed.folder);

    let cancelled = false;
    fetch(`/api/v1/hf-files?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json() as Promise<HfFile[]>;
      })
      .then((data) => {
        if (!cancelled) {
          setFiles(data);
          setSelectedPaths(
            defaultDownloadSelection(data, parsed.filename, parsed.folder),
          );
          setFilesLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setFilesError(String(e.message ?? e));
          setFilesLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [parsed]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const selectedFiles = useMemo(
    () => files?.filter((f) => selectedPaths.has(f.path)) ?? [],
    [files, selectedPaths],
  );
  const totalSize = selectedFiles.reduce((s, f) => s + f.size, 0);
  const spaceWarnings = useMemo(
    () =>
      disk
        ? diskSpaceWarnings(disk, totalSize, sendToCold, deleteAfterTransfer)
        : [],
    [disk, totalSize, sendToCold, deleteAfterTransfer],
  );
  const notEnoughSpace = spaceWarnings.length > 0;

  // A repo whose weights are independent, self-contained picks (GGUF quants,
  // ggml .bin models) is offered as quantizations rather than files: the user is
  // choosing a quant, and a sharded one spans several files they'd otherwise
  // have to tick individually. Everything else — a safetensors model and its
  // companions, a whole-repo ONNX model — is a file list, since its files aren't
  // alternatives to each other.
  const groups = useMemo(() => {
    if (!files || repoDownloadKind(files.map((f) => f.path)) !== 'pick-one')
      return null;
    return quantGroups(files);
  }, [files]);

  // Files the target already has archived. Informational only — a cold copy
  // isn't at the download target, so it never changes what's selected; getting
  // it back is a copy, not a download.
  const inCold = useMemo(() => {
    if (!files || !coldModels || !parsed) return new Set<string>();
    return coldStoredPaths(coldModels, parsed.repoId, files);
  }, [files, coldModels, parsed]);

  const coldCount = (g: QuantGroup) =>
    g.paths.filter((p) => inCold.has(p)).length;

  // The picker shows the rows matching the filter; selection is by path, so
  // rows selected and then filtered out of view stay selected (the footer
  // count always tells the whole story).
  const visibleFiles = useMemo(() => {
    if (!files) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return files;
    // Match the whole relative path so a folder name narrows the list too.
    return files.filter((f) => f.path.toLowerCase().includes(needle));
  }, [files, filter]);

  const visibleGroups = useMemo(() => {
    if (!groups) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return groups;
    return groups.filter((g) =>
      `${g.label} ${g.folder ?? ''}`.toLowerCase().includes(needle),
    );
  }, [groups, filter]);

  const groupSelectedCount = (g: QuantGroup) =>
    g.paths.filter((p) => selectedPaths.has(p)).length;
  const isGroupSelected = (g: QuantGroup) =>
    groupSelectedCount(g) === g.fileCount;
  // A part-selected quantization reads as indeterminate rather than unchecked,
  // so a collapsed row still admits it holds a partial download.
  const groupCheckState = (g: QuantGroup): boolean | 'indeterminate' => {
    const n = groupSelectedCount(g);
    return n === 0 ? false : n === g.fileCount ? true : 'indeterminate';
  };
  const selectedGroupCount = groups?.filter(isGroupSelected).length ?? 0;
  // Once a quantization is only part-selected the footer can't honestly count in
  // quantizations any more, so it counts files instead.
  const hasPartialGroup =
    groups?.some((g) => {
      const n = groupSelectedCount(g);
      return n > 0 && n < g.fileCount;
    }) ?? false;

  // Whole quantizations are the default and cover almost every download. Files
  // are picked individually only to work around what's already on disk —
  // re-fetching one shard of a set whose siblings were moved to cold storage to
  // free space — so the ability is here, behind a switch, rather than in the way.
  // Only sharded quantizations have anything to expand.
  const canPickFiles = groups?.some((g) => g.fileCount > 1) ?? false;
  const expandable = showFiles && canPickFiles;

  // What the command needs beyond the request: the quantizations, so a whole
  // one is named by its label rather than shard by shard, and the full listing,
  // so taking all of a repo that isn't a menu of alternatives is just its name.
  const commandContext = useMemo(
    () => ({
      ...(groups ? {quants: groups} : {}),
      ...(files ? {repoPaths: files.map((f) => f.path)} : {}),
      ...(target.cliUrl ? {cliUrl: target.cliUrl} : {}),
    }),
    [groups, files, target.cliUrl],
  );

  const command = useMemo(() => {
    if (!parsed || !files || selectedFiles.length === 0) return null;
    return buildTjGetCommand(
      {
        repoId: parsed.repoId,
        branch: parsed.branch,
        filePaths: selectedFiles.map((f) => f.path),
        sendToCold,
        deleteAfterTransfer,
      },
      commandContext,
    );
  }, [
    parsed,
    files,
    selectedFiles,
    sendToCold,
    deleteAfterTransfer,
    commandContext,
  ]);

  const toggleFile = (path: string, checked: boolean) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (checked) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  const toggleOpen = (key: string) => {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // A quantization is taken whole — its shards are one download, not a set of
  // independently useful files.
  const toggleGroup = (g: QuantGroup, checked: boolean) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      for (const p of g.paths) {
        if (checked) next.add(p);
        else next.delete(p);
      }
      return next;
    });
  };

  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    if (!command) return;
    copyToClipboard(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const startDownload = () => {
    if (!parsed || selectedFiles.length === 0 || running) return;
    setShowTerminal(true);
    start(
      {
        repoId: parsed.repoId,
        branch: parsed.branch,
        filePaths: selectedFiles.map((f) => f.path),
        sendToCold,
        deleteAfterTransfer,
      },
      commandContext,
    );
  };

  // Closing the terminal returns to the picker (the URL stays).
  const closeTerminal = () => {
    if (running) cancel();
    setShowTerminal(false);
    reset();
  };

  const hasFiles = files !== null && files.length > 0;

  if (showTerminal) {
    return (
      <DownloadModal
        title={parsed ? `Downloading ${parsed.repoId}…` : undefined}
        term={term}
        progress={progress}
        running={running}
        command={runCommand ?? undefined}
        hfTokenSet={hfTokenSet}
        onClose={closeTerminal}
      />
    );
  }

  return (
    <VStack gap={4}>
      <VStack gap={3} xstyle={styles.pickerBody}>
        <TextInput
          label="Hugging Face URL"
          isLabelHidden
          value={url}
          onChange={setUrl}
          placeholder="org/repo  or  a file, or folder, URL from the repo"
          status={
            isInvalid
              ? {type: 'error', message: 'Not a valid Hugging Face file URL.'}
              : undefined
          }
        />
        {filesLoading && <Text type="supporting">Fetching file list…</Text>}
        {filesError && (
          <Text type="supporting" color="accent">
            Error: {filesError}
          </Text>
        )}
        {!hasFiles && !filesLoading && !filesError && (
          <Text type="supporting">
            Enter a Hugging Face URL or org/repo to list its files.
          </Text>
        )}
        {card && (
          <Collapsible
            defaultIsOpen={false}
            trigger={<Text type="supporting">Model card</Text>}
          >
            <VStack gap={2}>
              <Text type="supporting" xstyle={styles.cardBody}>
                {card.markdown}
              </Text>
              <Text type="supporting">
                {card.truncated ? 'Cut short — read the rest on ' : 'On '}
                <Link href={card.url} isExternalLink>
                  the Hub
                </Link>
              </Text>
            </VStack>
          </Collapsible>
        )}
        {hasFiles && (
          <HStack gap={3} vAlign="center">
            <StackItem size="fill">
              <TextInput
                label={groups ? 'Filter quantizations' : 'Filter files'}
                isLabelHidden
                value={filter}
                onChange={setFilter}
                placeholder={groups ? 'Filter quantizations…' : 'Filter files…'}
              />
            </StackItem>
            {canPickFiles && (
              <CheckboxInput
                label="Individual files"
                size="sm"
                value={showFiles}
                onChange={(checked) => {
                  setShowFiles(checked);
                  if (!checked) setOpenKeys(new Set());
                }}
              />
            )}
            <Text type="supporting">
              {groups
                ? `${visibleGroups.length} / ${groups.length} quantizations`
                : `${visibleFiles.length} / ${files!.length} files`}
            </Text>
          </HStack>
        )}
        {hasFiles && groups && (
          <List hasDividers xstyle={styles.fileList}>
            {visibleGroups.flatMap((g) => [
              <ListItem
                key={g.key}
                startContent={
                  <CheckboxInput
                    label={g.label}
                    isLabelHidden
                    value={groupCheckState(g)}
                    onChange={(checked) => toggleGroup(g, checked)}
                    size="sm"
                  />
                }
                label={g.label}
                description={groupDetail(g, groupSelectedCount(g))}
                endContent={
                  <HStack gap={2} vAlign="center">
                    <ColdBadge held={coldCount(g)} total={g.fileCount} />
                    <Text type="supporting">{formatSize(g.size)}</Text>
                    {expandable && g.fileCount > 1 && (
                      <IconButton
                        label={`Show the files in ${g.label}`}
                        variant="ghost"
                        size="sm"
                        icon={
                          <Icon
                            icon={
                              openKeys.has(g.key)
                                ? 'chevronDown'
                                : 'chevronRight'
                            }
                          />
                        }
                        onClick={() => toggleOpen(g.key)}
                      />
                    )}
                  </HStack>
                }
              />,
              ...(expandable && openKeys.has(g.key)
                ? g.paths.map((p) => (
                    <ListItem
                      key={p}
                      xstyle={styles.shardRow}
                      startContent={
                        <CheckboxInput
                          label={p}
                          isLabelHidden
                          value={selectedPaths.has(p)}
                          onChange={(checked) => toggleFile(p, checked)}
                          size="sm"
                        />
                      }
                      label={p.split('/').pop()}
                      endContent={
                        <HStack gap={2} vAlign="center">
                          <ColdBadge held={inCold.has(p) ? 1 : 0} total={1} />
                          <Text type="supporting">
                            {formatSize(
                              files!.find((f) => f.path === p)?.size ?? 0,
                            )}
                          </Text>
                        </HStack>
                      }
                    />
                  ))
                : []),
            ])}
            {visibleGroups.length === 0 && (
              <ListItem label="No quantizations match the filter." />
            )}
          </List>
        )}
        {hasFiles && !groups && (
          <List hasDividers xstyle={styles.fileList}>
            {visibleFiles.map((f) => (
              <ListItem
                key={f.path}
                startContent={
                  <CheckboxInput
                    label={f.path}
                    isLabelHidden
                    value={selectedPaths.has(f.path)}
                    onChange={(checked) => toggleFile(f.path, checked)}
                    size="sm"
                  />
                }
                label={f.path}
                endContent={
                  <HStack gap={2} vAlign="center">
                    <ColdBadge held={inCold.has(f.path) ? 1 : 0} total={1} />
                    <Text type="supporting">{formatSize(f.size)}</Text>
                  </HStack>
                }
              />
            ))}
            {visibleFiles.length === 0 && (
              <ListItem label="No files match the filter." />
            )}
          </List>
        )}
        {hasFiles && (
          <VStack gap={2}>
            <CheckboxInput
              label="Copy to cold storage when done"
              value={sendToCold}
              onChange={(checked) => {
                setSendToCold(checked);
                if (!checked) setDeleteAfterTransfer(false);
              }}
              size="sm"
            />
            {sendToCold && (
              <CheckboxInput
                label="Delete from local storage after transfer"
                value={deleteAfterTransfer}
                onChange={setDeleteAfterTransfer}
                size="sm"
              />
            )}
          </VStack>
        )}
      </VStack>
      {hasFiles && notEnoughSpace && (
        <Banner
          status="error"
          title={`Not enough disk space — ${spaceWarnings.join('; ')}.`}
        />
      )}
      <HStack gap={2} hAlign="between" vAlign="center">
        <Text type="supporting">
          {selectedFiles.length === 0
            ? 'Nothing selected'
            : groups && !hasPartialGroup
              ? `${selectedGroupCount} quantization${
                  selectedGroupCount !== 1 ? 's' : ''
                } · ${formatSize(totalSize)}`
              : `${selectedFiles.length} file${
                  selectedFiles.length !== 1 ? 's' : ''
                } · ${formatSize(totalSize)}`}
        </Text>
        <HStack gap={2} hAlign="end">
          <Button
            label={copied ? 'Copied' : 'Copy command'}
            variant="secondary"
            size="sm"
            onClick={handleCopy}
            isDisabled={command == null}
          />
          <Button
            label="Download"
            variant="primary"
            size="sm"
            onClick={startDownload}
            isDisabled={selectedFiles.length === 0}
          />
        </HStack>
      </HStack>
    </VStack>
  );
}
