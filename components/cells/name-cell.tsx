'use client';

import {type ReactNode} from 'react';
import * as stylex from '@stylexjs/stylex';
import {HStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';
import {Button} from '@astryxdesign/core/Button';
import {Badge} from '@astryxdesign/core/Badge';
import {HoverCard} from '@astryxdesign/core/HoverCard';
import {Link} from '@astryxdesign/core/Link';
import {VStack} from '@astryxdesign/core/Stack';
import {CopyNameButton} from '@/components/controls/copy-name-button';
import {modelDisplayName} from '@/lib/models/model-name';
import type {RepoFileState} from '@/lib/models/repo-files';
import {formatSize, type DisplayRow} from '@/lib/models/model-row';
import {
  MIXED_COMMIT,
  type FileProvenance,
  type SidecarLocation,
  type SidecarSummary,
} from '@/lib/models/sidecar-types';
import {checkpointLabel} from '@/lib/lemonade/lemonade-status';
import type {LemonadeEntryGap} from '@/lib/lemonade/lemonade-gaps';

const styles = stylex.create({
  indent1: {paddingInlineStart: '1.5rem'},
  indent2: {paddingInlineStart: '3rem'},
  // Full sha256 hashes wrap inside the hovercard instead of stretching it.
  hash: {fontFamily: 'monospace', wordBreak: 'break-all', maxWidth: 340},
  // Long filenames wrap in the hovercard header instead of stretching it.
  name: {wordBreak: 'break-all', maxWidth: 340},
});

// Per-file status token in a whole-repo model's expanded file list.
function FileStateMarker({state}: {state: RepoFileState}) {
  const {label, variant} =
    state === 'present'
      ? ({label: 'present', variant: 'green'} as const)
      : state === 'missing'
        ? ({label: 'missing', variant: 'neutral'} as const)
        : ({label: 'invalid', variant: 'red'} as const);
  return <Badge label={label} variant={variant} />;
}

/** The Hugging Face commit page URL for a sidecar's model and a commit sha. */
function commitUrl(modelUrl: string, sha: string): string {
  return `${modelUrl}/commit/${sha}`;
}

/** A short commit hash linking to its Hugging Face commit page. */
function CommitLink({modelUrl, sha}: {modelUrl: string; sha: string}) {
  return (
    <Link href={commitUrl(modelUrl, sha)} isExternalLink>
      {sha.slice(0, 12)}
    </Link>
  );
}

/** A label/value pair row inside the model-name hovercard. */
function InfoRow({label, children}: {label: string; children: ReactNode}) {
  return (
    <HStack gap={4} hAlign="between">
      <Text type="supporting">{label}</Text>
      <Text type="body">{children}</Text>
    </HStack>
  );
}

/** A "N · size" file summary, e.g. `3 · 18.7 GiB`. */
function fileSummary(fileCount: number, totalSourceSize: number): string {
  return `${fileCount} · ${formatSize(totalSourceSize)}`;
}

/**
 * The model-level sidecar provenance block appended to the name hovercard.
 * `locations` is set only when the local and cold copies differ (e.g. holding
 * different quantizations); then the file total is broken out per location so it
 * doesn't read as one copy's size standing in for the whole model.
 */
function SidecarInfo({
  sidecar,
  locations,
}: {
  sidecar: SidecarSummary;
  locations?: SidecarLocation[];
}) {
  const {sourceCommit, repoCommit, repoCommitDate, modelUrl} = sidecar;
  return (
    <VStack gap={1}>
      {sourceCommit && (
        <InfoRow label="Source revision">
          {sourceCommit === MIXED_COMMIT ? (
            'mixed'
          ) : (
            <CommitLink modelUrl={modelUrl} sha={sourceCommit} />
          )}
        </InfoRow>
      )}
      {repoCommit && (
        <InfoRow label="Repo HEAD">
          <CommitLink modelUrl={modelUrl} sha={repoCommit} />
          {repoCommitDate && ` (${repoCommitDate.slice(0, 10)})`}
        </InfoRow>
      )}
      {locations && locations.length > 0 ? (
        locations.map((loc) => (
          <InfoRow key={loc.label} label={`Files · ${loc.label}`}>
            {fileSummary(loc.fileCount, loc.totalSourceSize)}
          </InfoRow>
        ))
      ) : (
        <InfoRow label="Files">
          {fileSummary(sidecar.fileCount, sidecar.totalSourceSize)}
        </InfoRow>
      )}
    </VStack>
  );
}

/** A label/value row flagging a local value that diverges from its source. */
function MismatchRow({label, children}: {label: string; children: ReactNode}) {
  return (
    <HStack gap={4} hAlign="between" vAlign="center">
      <HStack gap={1} vAlign="center">
        <Icon icon="warning" size="sm" />
        <Text type="supporting">{label}</Text>
      </HStack>
      <Text type="body">{children}</Text>
    </HStack>
  );
}

/** Full per-file provenance: source revision, sizes, checksums, origin link. */
function FileProvenanceInfo({
  provenance,
  modelUrl,
}: {
  provenance: FileProvenance;
  modelUrl: string;
}) {
  const {
    sourceCommit,
    sourceCommitDate,
    sourceSize,
    computedSize,
    sourceSha256,
    computedSha256,
    originUrl,
  } = provenance;
  const sizeMismatch = computedSize > 0 && computedSize !== sourceSize;
  const shaMismatch =
    !!sourceSha256 && !!computedSha256 && computedSha256 !== sourceSha256;
  return (
    <VStack gap={1}>
      {sourceCommit && (
        <InfoRow label="Source revision">
          <CommitLink modelUrl={modelUrl} sha={sourceCommit} />
          {sourceCommitDate && ` (${sourceCommitDate.slice(0, 10)})`}
        </InfoRow>
      )}
      <InfoRow label="Source size">{formatSize(sourceSize)}</InfoRow>
      {sourceSha256 && (
        <VStack gap={0}>
          <Text type="supporting">Source sha256</Text>
          <Text type="supporting" xstyle={styles.hash}>
            {sourceSha256}
          </Text>
        </VStack>
      )}
      {sizeMismatch && (
        <MismatchRow label="On disk">{formatSize(computedSize)}</MismatchRow>
      )}
      {shaMismatch && (
        <VStack gap={0}>
          <HStack gap={1} vAlign="center">
            <Icon icon="warning" size="sm" />
            <Text type="supporting">Computed sha256</Text>
          </HStack>
          <Text type="supporting" xstyle={styles.hash}>
            {computedSha256}
          </Text>
        </VStack>
      )}
      <Link href={originUrl} isExternalLink>
        View file on Hugging Face
      </Link>
    </VStack>
  );
}

/**
 * Wrap a file row's label in its provenance hovercard: a split quant's
 * aggregate card, a single file's full provenance, or plain text when neither.
 * Like the model hovercard, the first line is the name with a copy button.
 */
function FileHover({row, children}: {row: DisplayRow; children: ReactNode}) {
  // Single-file quant rows label themselves with the quant, not the filename.
  const name = row.filename ?? row.label;
  const nameHeader = (
    <HStack gap={1} vAlign="center">
      <Text type="body" xstyle={styles.name}>
        {name}
      </Text>
      <CopyNameButton name={name} />
    </HStack>
  );
  if (row.provenanceAggregate) {
    return (
      <HoverCard
        placement="above"
        content={
          <VStack gap={1}>
            {nameHeader}
            <SidecarInfo sidecar={row.provenanceAggregate} />
          </VStack>
        }
      >
        {children}
      </HoverCard>
    );
  }
  if (row.provenance) {
    return (
      <HoverCard
        placement="above"
        content={
          <VStack gap={1}>
            {nameHeader}
            <FileProvenanceInfo
              provenance={row.provenance}
              modelUrl={`https://huggingface.co/${row.parentName}`}
            />
          </VStack>
        }
      >
        {children}
      </HoverCard>
    );
  }
  return <>{children}</>;
}

// Flags a file another catalog entry lists as one of its checkpoints — the
// text encoder or VAE of an image model, say — which its own row can't show:
// the file lives in a different repo from the model that needs it.
// Every model Lemonade knows gets the lemon — catalog entries and FastFlowLM's
// FLM models alike — so its absence always means "not a Lemonade model"; the
// hovercard names the exact entries the repo backs, as Lemonade names them.
// On a location's tab it also says which of those this location can serve: an
// entry names several files (an MTP draft model, a projector) and Lemonade
// lists it as downloaded only once every one is present, so it names what's
// missing and offers to download it there.
function LemonMarker({
  names,
  gaps,
  onDownload,
  downloading,
}: {
  names: string[];
  gaps?: LemonadeEntryGap[];
  onDownload?: (repoId: string, variants: Array<string | null>) => void;
  downloading: boolean;
}) {
  const incomplete = (gaps ?? []).filter((g) => g.missing.length > 0);
  const summary = `This repo backs the Lemonade ${
    names.length === 1 ? 'model' : 'models'
  }: ${names.join(', ')}`;
  // One download per repo: the downloader fetches from one repo at a time.
  const byRepo = new Map<string, Array<string | null>>();
  for (const g of incomplete)
    for (const cp of g.missing) {
      const variants = byRepo.get(cp.repoId) ?? [];
      if (!variants.includes(cp.variant)) variants.push(cp.variant);
      byRepo.set(cp.repoId, variants);
    }
  const content =
    gaps == null || gaps.length === 0 ? (
      summary
    ) : (
      <VStack gap={2}>
        <Text type="supporting">{summary}</Text>
        {gaps.map((g) => (
          <VStack key={g.name} gap={0}>
            <HStack gap={2} vAlign="center">
              <Text type="body">{g.name}</Text>
              <Badge
                label={g.missing.length === 0 ? 'ready' : 'incomplete'}
                variant={g.missing.length === 0 ? 'success' : 'warning'}
              />
            </HStack>
            {g.missing.length > 0 && (
              <Text type="supporting">
                Missing here: {g.missing.map(checkpointLabel).join(', ')}
              </Text>
            )}
          </VStack>
        ))}
        {onDownload &&
          [...byRepo].map(([repoId, variants]) => (
            <HStack key={repoId}>
              <Button
                label={
                  downloading
                    ? 'Downloading…'
                    : byRepo.size > 1
                      ? `Download missing files from ${repoId}`
                      : 'Download missing files'
                }
                variant="ghost"
                size="sm"
                isDisabled={downloading}
                onClick={() => onDownload(repoId, variants)}
              />
            </HStack>
          ))}
      </VStack>
    );
  return (
    <HoverCard content={content} placement="above" hideDelay={600}>
      <HStack gap={1} vAlign="center">
        <Text type="supporting" role="img" aria-label="A Lemonade model">
          🍋
        </Text>
        {incomplete.length > 0 && (
          <Icon icon="warning" size="sm" color="warning" />
        )}
      </HStack>
    </HoverCard>
  );
}

function DependencyBadge({dependents}: {dependents?: string[]}) {
  if (!dependents || dependents.length === 0) return null;
  return (
    <HoverCard
      placement="above"
      content={`Needed by the Lemonade catalog ${
        dependents.length === 1 ? 'entry' : 'entries'
      }: ${dependents.join(', ')}. Deleting or archiving this file breaks ${
        dependents.length === 1 ? 'it' : 'them'
      }.`}
    >
      <Badge label="dependency" variant="neutral" />
    </HoverCard>
  );
}

export function NameCell({
  row,
  isExpanded,
  onToggle,
  incomplete = false,
  invalid = false,
  lemonadeNames,
  lemonadeGaps,
  onDownloadCheckpoints,
  downloadingCheckpoints = false,
  dependents,
}: {
  row: DisplayRow;
  isExpanded: boolean;
  onToggle: (key: string) => void;
  // On a location's tab: what that location lacks of each Lemonade entry it
  // holds part of (depth-0 rows only).
  lemonadeGaps?: LemonadeEntryGap[];
  // Download a repo's missing checkpoints onto that location.
  onDownloadCheckpoints?: (
    repoId: string,
    variants: Array<string | null>,
  ) => void;
  downloadingCheckpoints?: boolean;
  // The model's local copy is present but missing files (depth-0 rows only).
  incomplete?: boolean;
  // The model has at least one local file that audits invalid (depth-0 rows).
  invalid?: boolean;
  // Lemonade catalog entries backed by this model's repo (depth-0 rows only) —
  // the catalog names its entries differently from the repo id shown here.
  lemonadeNames?: string[];
  // Lemonade catalog entries this exact file is a checkpoint of (depth-1 rows
  // only) — a warning that deleting or archiving it breaks another model.
  dependents?: string[];
}) {
  // Whole-repo file row: the filename with a present/missing/invalid marker.
  if (row.fileState) {
    return (
      <HStack gap={2} vAlign="center" xstyle={styles.indent1}>
        <FileStateMarker state={row.fileState} />
        <FileHover row={row}>
          <Text type="supporting">{row.label}</Text>
        </FileHover>
        <DependencyBadge dependents={dependents} />
      </HStack>
    );
  }

  // Shard row
  if (row.depth === 2) {
    return (
      <FileHover row={row}>
        <Text type="supporting" xstyle={styles.indent2}>
          {row.label}
        </Text>
      </FileHover>
    );
  }

  // Projector (mmproj) row: a companion file, not a quantization — marked so
  // it reads differently from the quant rows it sits among.
  if (row.isProjector) {
    return (
      <HStack gap={2} vAlign="center" xstyle={styles.indent1}>
        <Badge variant="neutral" label="projector" />
        <FileHover row={row}>
          <Text type="supporting">{row.label}</Text>
        </FileHover>
        <DependencyBadge dependents={dependents} />
      </HStack>
    );
  }

  // Quant row
  if (row.depth === 1) {
    if (row.isSingleFile) {
      return (
        <HStack gap={2} vAlign="center" xstyle={styles.indent1}>
          <FileHover row={row}>
            <Text type="body">{row.filename}</Text>
          </FileHover>
          <Badge label={row.label} variant="neutral" />
          {row.precisions && row.precisions.length > 0 && (
            <Badge label={row.precisions.join(', ')} variant="neutral" />
          )}
          <DependencyBadge dependents={dependents} />
        </HStack>
      );
    }
    // Split quant: expandable to its shards
    return (
      <FileHover row={row}>
        <Button
          label={row.label}
          variant="ghost"
          size="sm"
          xstyle={styles.indent1}
          icon={<Icon icon={isExpanded ? 'chevronDown' : 'chevronRight'} />}
          endContent={
            <HStack gap={2} vAlign="center">
              <Text type="supporting">
                {row.presentShards}/{row.totalShards} files
              </Text>
              {row.missingIndices.length > 0 && (
                <Badge
                  variant="orange"
                  label={`missing: ${row.missingIndices.join(', ')}`}
                />
              )}
              <DependencyBadge dependents={dependents} />
            </HStack>
          }
          onClick={() => onToggle(row.key)}
        />
      </FileHover>
    );
  }

  // Model row. Show the repo segment of an org/repo identity; the full name
  // (linked to Hugging Face when it's an org/repo id), a copy-name button, and
  // the sidecar provenance live in the hovercard.
  return (
    <HStack gap={2} vAlign="center">
      <HoverCard
        placement="above"
        content={
          <VStack gap={1}>
            <HStack gap={1} vAlign="center">
              {row.label.includes('/') ? (
                <Link
                  href={`https://huggingface.co/${row.label}`}
                  isExternalLink
                >
                  {row.label}
                </Link>
              ) : (
                <Text type="body">{row.label}</Text>
              )}
              <CopyNameButton name={row.label} />
            </HStack>
            {row.sidecar && (
              <SidecarInfo
                sidecar={row.sidecar}
                locations={row.sidecarLocations}
              />
            )}
          </VStack>
        }
      >
        <Button
          label={modelDisplayName(row.label)}
          variant="ghost"
          size="sm"
          icon={<Icon icon={isExpanded ? 'chevronDown' : 'chevronRight'} />}
          onClick={() => onToggle(row.parentName)}
        />
      </HoverCard>
      {row.orgSuffix && <Text type="supporting">({row.orgSuffix})</Text>}
      {row.precisions && row.precisions.length > 0 && (
        // A whole-repo model's weight dtype — its expansion lists files, not
        // quant rows, so this is the only place its precision can show.
        <Badge label={row.precisions.join(', ')} variant="neutral" />
      )}
      {lemonadeNames && lemonadeNames.length > 0 && (
        <LemonMarker
          names={lemonadeNames}
          gaps={lemonadeGaps}
          onDownload={onDownloadCheckpoints}
          downloading={downloadingCheckpoints}
        />
      )}
      {incomplete && <Badge variant="error" label="incomplete" />}
      {invalid && (
        <HoverCard content="Invalid download — a local file's size or checksum doesn't match its source">
          <Badge variant="error" label="invalid" />
        </HoverCard>
      )}
    </HStack>
  );
}
