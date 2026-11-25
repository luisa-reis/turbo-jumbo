'use client';

import * as stylex from '@stylexjs/stylex';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Link} from '@astryxdesign/core/Link';
import {Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';
import {Button} from '@astryxdesign/core/Button';
import {isMmprojFilename} from '@/lib/models/model-name';
import {Badge} from '@astryxdesign/core/Badge';
import {HoverCard} from '@astryxdesign/core/HoverCard';
import type {AuditResult, AuditStatus, UpdateResult} from '@/lib/audit/audit';
import {
  hovercardOrder,
  redownloadableFailures,
  updateDownload,
  type RowAudit,
} from '@/lib/audit/row-audit';
import type {RepoFile} from '@/lib/models/repo-files';
import {formatSize} from '@/lib/models/model-row';

const styles = stylex.create({
  // Cached (sidecar-derived) audit verdicts are toned down vs fresh results.
  dimmed: {opacity: 0.6},
  // Long per-file listings scroll inside the hovercard so the action buttons
  // below them stay reachable no matter how many files are affected.
  fileList: {maxHeight: 280, overflowY: 'auto'},
});

// Hovercards holding buttons or links get a longer hide delay than the 200ms
// default: leaving the badge starts the hide countdown, and the pointer must
// reach the card before it fires — a tight window when the target is a button
// at the far edge of a tall card.
const INTERACTIVE_HIDE_DELAY = 600;

const AUDIT_BADGE: Record<
  AuditStatus,
  {label: string; variant: 'success' | 'error' | 'warning' | 'neutral'}
> = {
  pass: {label: 'Pass', variant: 'success'},
  incomplete: {label: 'Incomplete', variant: 'error'},
  'checksum-mismatch': {label: 'Mismatch', variant: 'error'},
  misplaced: {label: 'Misplaced', variant: 'warning'},
  duplicate: {label: 'Duplicate', variant: 'warning'},
  unverifiable: {label: 'Unverifiable', variant: 'neutral'},
  error: {label: 'Error', variant: 'error'},
};

// The expected value most relevant to a given failure, drawn from the HF source.
// Size isn't special-cased here: the `incomplete` message already names the
// expected size, and the HF block below always shows it.
function expectedDetail(f: AuditResult): string | null {
  if (!f.hf) return null;
  switch (f.status) {
    case 'checksum-mismatch':
      return `Expected sha256: ${f.hf.expectedSha256}`;
    case 'misplaced':
      return `Expected path: ${f.hf.expectedPath}`;
    default:
      return null;
  }
}

function AuditFailureContent({
  failures,
  onFix,
  fixing,
  onSetSource,
  onRedownload,
  onRedownloadAll,
  redownloading,
  onShowRevisions,
  onFixDuplicate,
  fixingDuplicate,
  copySourceLabelFor,
  onCopyFrom,
  recovering,
}: {
  failures: AuditResult[];
  onFix?: (path: string) => void;
  fixing?: boolean;
  onSetSource?: (path: string) => void;
  onRedownload?: (file: AuditResult) => void;
  // Download every re-fetchable missing file in one request. Shown instead of
  // per-file buttons when several files are missing — pressing "Download
  // missing files" must not quietly fetch just one.
  onRedownloadAll?: (files: AuditResult[]) => void;
  redownloading?: boolean;
  onShowRevisions?: (file: AuditResult) => void;
  onFixDuplicate?: (path: string) => void;
  fixingDuplicate?: boolean;
  // For a missing file recoverable by copy, the display name of the location it
  // can be pulled from (a peer, or "Cold storage"); null when no other machine
  // holds it. `onCopyFrom` starts that copy. Offered beside the HF re-download
  // so a missing projector can be recovered over the LAN instead of the internet.
  copySourceLabelFor?: (file: AuditResult) => string | null;
  onCopyFrom?: (file: AuditResult) => void;
  recovering?: boolean;
}) {
  // The files a re-download can recover. With more than one, a single grouped
  // action downloads them all — including small companions the audit found no
  // HF summary for (non-LFS files like a tokenizer_config.json), which have
  // no per-file button; the group derives their source from a sibling. A
  // projector keeps its own labeled button (its download has a distinct
  // flow), and a lone summary-bearing file keeps a per-file button.
  const redownloadable = redownloadableFailures(failures);
  const isRedownloadable = new Set(redownloadable.map((f) => f.file));
  const grouped =
    redownloadable.length > 1 &&
    redownloadable.some((f) => f.hf != null) &&
    onRedownloadAll != null;
  // In grouped mode each incomplete file renders as a compact name + message
  // row: the badge, revision, and repo links they'd repeat are identical
  // across the group, so they appear once in the shared source block below.
  const sources = redownloadable.map((f) => f.hf).filter((h) => h != null);
  const sharedSource = grouped ? (sources[0] ?? null) : null;
  const commits = new Set(
    sources.map((h) => h.commit).filter((c) => c != null),
  );
  const sharedCommit =
    grouped && commits.size === 1
      ? (sources.find((h) => h.commit != null) ?? null)
      : null;
  // "Copy from <location>" for a missing file another machine holds — rendered
  // beside the HF re-download in both the grouped and per-file layouts.
  const copyButton = (f: AuditResult) => {
    const label = copySourceLabelFor?.(f) ?? null;
    if (!label || onCopyFrom == null) return null;
    return (
      <HStack>
        <Button
          label={recovering ? 'Copying…' : `Copy from ${label}`}
          variant="ghost"
          size="sm"
          onClick={() => onCopyFrom(f)}
          isDisabled={recovering}
        />
      </HStack>
    );
  };
  return (
    <VStack gap={3}>
      <VStack gap={3} xstyle={styles.fileList}>
        {hovercardOrder(failures).map((f) => {
          if (grouped && isRedownloadable.has(f.file)) {
            const name = f.file.split('/').pop() ?? f.file;
            const isProjector = isMmprojFilename(name);
            return (
              <VStack
                key={f.file}
                gap={0}
                xstyle={f.cached ? styles.dimmed : undefined}
              >
                <Text type="body">
                  {name}
                  {f.cached ? ' (cached)' : ''}
                </Text>
                {(f.message || f.hf?.expectedSize != null) && (
                  <Text type="supporting">
                    {f.message}
                    {f.hf?.expectedSize != null &&
                      `${f.message ? ' · ' : ''}${formatSize(f.hf.expectedSize)}`}
                  </Text>
                )}
                {isProjector && f.hf != null && onRedownload != null && (
                  <HStack>
                    <Button
                      label={redownloading ? 'Downloading…' : 'Download mmproj'}
                      variant="ghost"
                      size="sm"
                      onClick={() => onRedownload?.(f)}
                      isDisabled={redownloading}
                    />
                  </HStack>
                )}
                {copyButton(f)}
              </VStack>
            );
          }
          const name = f.file.split('/').pop() ?? f.file;
          const isProjector = isMmprojFilename(name);
          const detail = expectedDetail(f);
          const {label, variant} = AUDIT_BADGE[f.status];
          // Only non-cached misplaced files can be relocated server-side.
          const canFix = f.status === 'misplaced' && !f.cached && onFix != null;
          // Unverifiable files have no inferred source — let the user supply one.
          const canSetSource =
            f.status === 'unverifiable' && onSetSource != null;
          // Incomplete (partial) files can be re-fetched; the HF downloader
          // recovers the existing file in place, so it's never deleted first.
          // (Grouped incomplete files render as compact rows above, so this
          // full path only sees a lone incomplete file.)
          const canRedownload =
            isRedownloadable.has(f.file) &&
            f.hf != null &&
            onRedownload != null;
          // A size/checksum failure that scanned the repo's history carries the
          // revisions it ruled out, viewable in a modal.
          const canShowRevisions =
            (f.revisionsChecked?.length ?? 0) > 0 && onShowRevisions != null;
          // Duplicate groups can be resolved server-side: invalid/older copies
          // deleted, the surviving copy placed at the expected path.
          const canFixDuplicate =
            f.status === 'duplicate' && !f.cached && onFixDuplicate != null;
          return (
            <VStack
              key={f.file}
              gap={1}
              xstyle={f.cached ? styles.dimmed : undefined}
            >
              <Text type="body">
                {name}
                {f.cached ? ' (cached)' : ''}
              </Text>
              <HStack gap={2} vAlign="center">
                <Badge label={label} variant={variant} />
                {f.message && <Text type="supporting">{f.message}</Text>}
              </HStack>
              {detail && <Text type="supporting">{detail}</Text>}
              {f.hf && (
                <VStack gap={0}>
                  {f.hf.expectedSize != null && (
                    <Text type="supporting">
                      Size: {formatSize(f.hf.expectedSize)}
                    </Text>
                  )}
                  {f.hf.commit && (
                    <Link href={f.hf.commitUrl ?? f.hf.fileUrl} isExternalLink>
                      Revision {f.hf.commit.slice(0, 12)}
                      {f.hf.commitDate && ` (${f.hf.commitDate.slice(0, 10)})`}
                    </Link>
                  )}
                  <Link href={f.hf.modelUrl} isExternalLink>
                    {f.hf.repoId}
                  </Link>
                  <Link href={f.hf.fileUrl} isExternalLink>
                    View file on HuggingFace
                  </Link>
                </VStack>
              )}
              {canFix && (
                <HStack>
                  <Button
                    label={fixing ? 'Fixing…' : 'Fix'}
                    variant="ghost"
                    size="sm"
                    onClick={() => onFix?.(f.file)}
                    isDisabled={fixing}
                  />
                </HStack>
              )}
              {canFixDuplicate && (
                <HStack>
                  <Button
                    label={fixingDuplicate ? 'Fixing…' : 'Fix'}
                    variant="ghost"
                    size="sm"
                    onClick={() => onFixDuplicate?.(f.file)}
                    isDisabled={fixingDuplicate}
                  />
                </HStack>
              )}
              {canSetSource && (
                <HStack>
                  <Button
                    label="Set source…"
                    variant="ghost"
                    size="sm"
                    onClick={() => onSetSource?.(f.file)}
                  />
                </HStack>
              )}
              {canRedownload && (
                <HStack>
                  <Button
                    label={
                      redownloading
                        ? 'Downloading…'
                        : isProjector
                          ? 'Download mmproj'
                          : 'Download missing file'
                    }
                    variant="ghost"
                    size="sm"
                    onClick={() => onRedownload?.(f)}
                    isDisabled={redownloading}
                  />
                </HStack>
              )}
              {canShowRevisions && (
                <HStack>
                  <Button
                    label="Checked revisions…"
                    variant="ghost"
                    size="sm"
                    onClick={() => onShowRevisions?.(f)}
                  />
                </HStack>
              )}
              {copyButton(f)}
            </VStack>
          );
        })}
      </VStack>
      {sharedSource && (
        <VStack gap={0}>
          {sharedCommit?.commit && (
            <Link
              href={sharedCommit.commitUrl ?? sharedCommit.fileUrl}
              isExternalLink
            >
              Revision {sharedCommit.commit.slice(0, 12)}
              {sharedCommit.commitDate &&
                ` (${sharedCommit.commitDate.slice(0, 10)})`}
            </Link>
          )}
          <Link href={sharedSource.modelUrl} isExternalLink>
            {sharedSource.repoId}
          </Link>
        </VStack>
      )}
      {grouped && (
        <HStack>
          <Button
            label={
              redownloading
                ? 'Downloading…'
                : `Download missing files (${redownloadable.length})`
            }
            variant="ghost"
            size="sm"
            onClick={() => onRedownloadAll?.(redownloadable)}
            isDisabled={redownloading}
          />
        </HStack>
      )}
    </VStack>
  );
}

// Shown in the Audit column when a row has at least one file whose repo head
// commit is newer than the file's recorded source commit. The hovercard lists
// each behind file with a link to the newer commit, and — where the location
// can take a download — fetches the newer versions in place.
export function UpdateBadge({
  updates,
  onDownloadFiles,
  downloading = false,
}: {
  updates: UpdateResult[];
  onDownloadFiles?: (
    repoId: string,
    repoPaths: string[],
    branch: string,
  ) => void;
  downloading?: boolean;
}) {
  const download = onDownloadFiles ? updateDownload(updates) : null;
  return (
    <HoverCard
      placement="above"
      hideDelay={INTERACTIVE_HIDE_DELAY}
      content={
        <VStack gap={1}>
          <Text type="supporting">Newer version on Hugging Face</Text>
          {updates.map((u) => {
            const name = u.file.split('/').pop() ?? u.file;
            const local = u.localCommitDate
              ? u.localCommitDate.slice(0, 10)
              : 'unknown';
            const remote = u.latestCommitDate
              ? u.latestCommitDate.slice(0, 10)
              : 'unknown';
            return (
              <VStack key={u.file} gap={0}>
                <Text type="body">{name}</Text>
                <Text type="supporting">
                  Local: {local} · Hugging Face: {remote}
                  {u.latestCommitUrl && u.latestCommit && (
                    <>
                      {' '}
                      <Link href={u.latestCommitUrl} isExternalLink>
                        {u.latestCommit.slice(0, 12)}
                      </Link>
                    </>
                  )}
                </Text>
              </VStack>
            );
          })}
          {download && (
            <HStack>
              <Button
                label={
                  downloading
                    ? 'Downloading…'
                    : download.repoPaths.length > 1
                      ? `Download latest (${download.repoPaths.length})`
                      : 'Download latest'
                }
                variant="ghost"
                size="sm"
                onClick={() =>
                  onDownloadFiles?.(
                    download.repoId,
                    download.repoPaths,
                    download.branch,
                  )
                }
                isDisabled={downloading}
              />
            </HStack>
          )}
        </VStack>
      }
    >
      <Badge
        label="Update"
        variant="info"
        icon={<Icon icon="info" size="sm" />}
      />
    </HoverCard>
  );
}

// The branch the repo's recorded provenance points at (`blob/<branch>/…`), so
// a revision-pinned model's files re-download from its pin. Missing files
// carry no provenance, so any recorded sibling supplies it; main otherwise.
function issuesBranch(issues: RepoFile[]): string {
  for (const f of issues) {
    const m = f.provenance?.originUrl.match(/\/blob\/([^/]+)\//);
    if (m) return m[1];
  }
  return 'main';
}

// Why a whole-repo model's file is flagged, for the invalid audit hovercard.
// A size that differs from Hugging Face is a truncated/corrupt copy; a size that
// matches but is still invalid means the sidecar can't attest it (no checksum).
function repoIssueReason(f: RepoFile): string {
  if (f.state === 'missing')
    return `missing — expected ${formatSize(f.expectedSize)}`;
  if (f.size != null && f.size !== f.expectedSize)
    return `wrong size — ${formatSize(f.size)}, expected ${formatSize(f.expectedSize)}`;
  return "source can't be verified";
}

export function AuditCell({
  audit,
  failures,
  invalid = false,
  incomplete = false,
  coldIncomplete = false,
  onCopyToCold,
  copyingToCold = false,
  repoIssues,
  repoId,
  onDownloadFiles,
  downloadingFiles,
  onFix,
  fixing,
  onSetSource,
  onRedownload,
  onRedownloadAll,
  redownloading,
  onShowRevisions,
  onFixDuplicate,
  fixingDuplicate,
  copySourceLabelFor,
  onCopyFrom,
  recovering,
}: {
  audit: RowAudit;
  failures?: AuditResult[];
  // The model has a local file that audits invalid (depth-0 rows). Its weights
  // can still pass, so a Pass verdict would be misleading — show Invalid instead.
  invalid?: boolean;
  // The model is missing files it needs at this location (depth-0 rows). Its
  // weights can still pass, so the same override applies — show Incomplete.
  incomplete?: boolean;
  // This row's cold-storage copy is present but incomplete (smaller than the
  // largest known copy). The audit of this tab's own copy can still pass, so a
  // Pass verdict would hide the broken backup — show Incomplete instead.
  coldIncomplete?: boolean;
  // Re-copy this row's file(s) to cold storage from their most complete copy,
  // resuming over the partial one. Drives the Incomplete hovercard's button.
  onCopyToCold?: () => void;
  copyingToCold?: boolean;
  // The model's invalid + missing files, named in the hovercard and downloaded.
  repoIssues?: RepoFile[];
  repoId?: string;
  onDownloadFiles?: (
    repoId: string,
    repoPaths: string[],
    branch?: string,
  ) => void;
  downloadingFiles?: boolean;
  onFix?: (path: string) => void;
  fixing?: boolean;
  onSetSource?: (path: string) => void;
  onRedownload?: (file: AuditResult) => void;
  onRedownloadAll?: (files: AuditResult[]) => void;
  redownloading?: boolean;
  onShowRevisions?: (file: AuditResult) => void;
  onFixDuplicate?: (path: string) => void;
  fixingDuplicate?: boolean;
  copySourceLabelFor?: (file: AuditResult) => string | null;
  onCopyFrom?: (file: AuditResult) => void;
  recovering?: boolean;
}) {
  // A flagged model shows its flag even with no hash verdict to override — a
  // copy missing its weights has nothing the audit could hash.
  if (audit == null && !(invalid || incomplete)) return null;
  if (audit?.kind === 'pending') {
    // Waiting for a worker (audits serialize on cold storage): a muted marker
    // until the file's start event arrives.
    if (audit.queued) {
      return <Badge label="Queued" variant="neutral" xstyle={styles.dimmed} />;
    }
    return (
      <HStack gap={2} vAlign="center" wrap="nowrap">
        <Badge label="Auditing…" variant="neutral" />
        {/* The percent tracks the SHA256 hashing — the long part of an audit. */}
        {audit.percent != null && (
          <Text type="supporting">{audit.percent}%</Text>
        )}
      </HStack>
    );
  }
  // A model with an invalid or missing file must not read as Pass even when
  // every audited weight passes: the audit hashes weights, and the bad file — a
  // corrupt index.json, an absent tokenizer — isn't one, so it never enters the
  // audited paths. Invalid wins the label when both apply: it means a file on
  // disk is wrong, not just absent. Expand the row to see which files.
  if ((invalid || incomplete) && (audit == null || audit.status === 'pass')) {
    const token = (
      <Badge
        label={invalid ? 'Invalid' : 'Incomplete'}
        variant="error"
        xstyle={audit?.cached ? styles.dimmed : undefined}
      />
    );
    const issues = repoIssues ?? [];
    // Detail not fetched yet: still don't claim Pass, just no hovercard.
    if (issues.length === 0) {
      return (
        <HoverCard
          content={
            invalid
              ? "Invalid — a file doesn't match its Hugging Face source."
              : 'Incomplete — files the model needs are missing.'
          }
        >
          {token}
        </HoverCard>
      );
    }
    const downloadPaths = issues.map((f) => f.path);
    return (
      <HoverCard
        placement="above"
        hideDelay={INTERACTIVE_HIDE_DELAY}
        content={
          <VStack gap={2}>
            <Text type="supporting">
              {issues.some((f) => f.state !== 'missing')
                ? "These files don't match Hugging Face:"
                : 'These files the model needs are missing:'}
            </Text>
            <VStack gap={2} xstyle={styles.fileList}>
              {issues.map((f) => (
                <VStack key={f.path} gap={0}>
                  <Text type="body">{f.path}</Text>
                  <HStack gap={2} vAlign="center">
                    <Badge
                      label={f.state === 'missing' ? 'missing' : 'invalid'}
                      variant="error"
                    />
                    <Text type="supporting">{repoIssueReason(f)}</Text>
                  </HStack>
                </VStack>
              ))}
            </VStack>
            {onDownloadFiles && repoId && downloadPaths.length > 0 && (
              <Button
                label={downloadingFiles ? 'Downloading…' : 'Download files'}
                variant="ghost"
                size="sm"
                isDisabled={downloadingFiles}
                onClick={() =>
                  onDownloadFiles(repoId, downloadPaths, issuesBranch(issues))
                }
              />
            )}
          </VStack>
        }
      >
        {token}
      </HoverCard>
    );
  }
  // Unflagged and unaudited was already answered above; a flagged one returned
  // its flag. What's left has a verdict.
  if (audit == null) return null;
  // A file whose cold-storage copy is incomplete must not read as Pass even when
  // this tab's own copy verifies (e.g. a peer holds the complete file) — the
  // cold backup is still broken. Mirrors the `invalid` override above.
  if (coldIncomplete && audit.status === 'pass') {
    const token = (
      <Badge
        label="Incomplete"
        variant="error"
        xstyle={audit.cached ? styles.dimmed : undefined}
      />
    );
    if (!onCopyToCold) {
      return (
        <HoverCard content="Cold storage copy is incomplete — re-copy it to cold storage.">
          {token}
        </HoverCard>
      );
    }
    return (
      <HoverCard
        placement="above"
        hideDelay={INTERACTIVE_HIDE_DELAY}
        content={
          <VStack gap={2}>
            <Text type="supporting">
              The cold storage copy is incomplete — a partial transfer. Re-copy
              it from the complete copy to finish it.
            </Text>
            <HStack>
              <Button
                label={copyingToCold ? 'Copying…' : 'Copy to cold storage'}
                variant="ghost"
                size="sm"
                isDisabled={copyingToCold}
                onClick={onCopyToCold}
              />
            </HStack>
          </VStack>
        }
      >
        {token}
      </HoverCard>
    );
  }
  const {label, variant} = AUDIT_BADGE[audit.status];
  // Cached (metadata-derived) verdicts are toned down to contrast with fresh
  // results.
  const plainBadge = (
    <Badge
      label={label}
      variant={variant}
      xstyle={audit.cached ? styles.dimmed : undefined}
    />
  );
  const hasFailures =
    audit.status !== 'pass' && failures != null && failures.length > 0;
  if (!hasFailures) return plainBadge;
  return (
    <HoverCard
      placement="above"
      hideDelay={INTERACTIVE_HIDE_DELAY}
      content={
        <AuditFailureContent
          failures={failures ?? []}
          onFix={onFix}
          fixing={fixing}
          onSetSource={onSetSource}
          onRedownload={onRedownload}
          onRedownloadAll={onRedownloadAll}
          redownloading={redownloading}
          onShowRevisions={onShowRevisions}
          onFixDuplicate={onFixDuplicate}
          fixingDuplicate={fixingDuplicate}
          copySourceLabelFor={copySourceLabelFor}
          onCopyFrom={onCopyFrom}
          recovering={recovering}
        />
      }
    >
      {plainBadge}
    </HoverCard>
  );
}
