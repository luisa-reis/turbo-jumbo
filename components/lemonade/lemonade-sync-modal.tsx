'use client';

import {useEffect, useState} from 'react';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Layout, LayoutContent, LayoutFooter} from '@astryxdesign/core/Layout';
import {VStack, HStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {Badge} from '@astryxdesign/core/Badge';
import {List, ListItem} from '@astryxdesign/core/List';
import {CopyNameButton} from '@/components/controls/copy-name-button';

// Mirrors the API shapes in lib/lemonade/lemonade-sync.ts (kept local so this client
// component never imports the server module).
interface Preview {
  repoId: string;
  rev: string;
  moveCount: number;
  dedupCount: number;
  linkCount: number;
  staleCount: number;
  blocked?: 'no-revision';
}
interface FileResult {
  repoPath: string;
  status:
    | 'linked'
    | 'deduplicated'
    | 'materialized'
    | 'already-linked'
    | 'stale-removed'
    | 'skipped'
    | 'error';
  message?: string;
}
interface ModelResult {
  repoId: string;
  rev: string;
  files: FileResult[];
}
/** A model offered to Lemonade through its extra-models directory, as a folder
 *  of symlinks. `folder` is the name Lemonade will list it under. */
interface ExtraChange {
  repoId: string;
  folder: string;
  toLink: number;
  toRemove: number;
}
/** A cache entry moving between builtin/ and extra/. Not a file change — the
 *  directory is renamed — so it is counted and shown apart from the rest. */
interface Placement {
  repoId: string;
  side: 'builtin' | 'extra';
  status: 'moved' | 'in-place' | 'conflict' | 'error';
  message?: string;
}

type Phase = 'loading' | 'preview' | 'running' | 'done' | 'error';

export function LemonadeSyncModal({
  syncUrl,
  onClose,
  onSynced,
}: {
  // The sync endpoint for the targeted peer (preview via GET, run via POST).
  syncUrl: string;
  onClose: () => void;
  // Called once a sync completes so the caller can refresh the table.
  onSynced: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [preview, setPreview] = useState<Preview[]>([]);
  const [results, setResults] = useState<ModelResult[]>([]);
  const [placement, setPlacement] = useState<Placement[]>([]);
  const [extra, setExtra] = useState<ExtraChange[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(syncUrl);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const data = (await res.json()) as {
          preview?: Preview[];
          placement?: Placement[];
          extra?: ExtraChange[];
        };
        if (!cancelled) {
          setPreview(data.preview ?? []);
          setPlacement(data.placement ?? []);
          setExtra(data.extra ?? []);
          setPhase('preview');
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [syncUrl]);

  async function runSync() {
    setPhase('running');
    try {
      const res = await fetch(syncUrl, {method: 'POST'});
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = (await res.json()) as {
        results?: ModelResult[];
        placement?: Placement[];
        extra?: ExtraChange[];
      };
      setResults(data.results ?? []);
      setPlacement(data.placement ?? []);
      setExtra(data.extra ?? []);
      setPhase('done');
      onSynced();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }

  // Blocked models are shown but never synced, so every count excludes them.
  const actionable = preview.filter((p) => !p.blocked);
  const totalFiles = actionable.reduce(
    (n, p) => n + p.moveCount + p.dedupCount + p.linkCount + p.staleCount,
    0,
  );
  // Sorting the cache is work too: a run that only moves directories still has
  // something to do, and the button must not read as if it were a no-op.
  const pending = actionable.length + placement.length + extra.length;
  const fileCountLabel = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
  // Group the preview by action so each model is listed as its own row, the same
  // way across imports, deduplications, and links — never folded into a count.
  const sections: Array<{
    title: string;
    hint?: string; // guidance shown under the title, for non-actionable groups
    items: Preview[];
    describe: (p: Preview) => string;
  }> = [
    {
      title: 'Importing into Turbo Jumbo',
      items: preview.filter((p) => p.moveCount > 0),
      describe: (p: Preview) =>
        `${fileCountLabel(p.moveCount)} · ${p.rev.slice(0, 12)}`,
    },
    {
      title: 'Deduplicating (already in Turbo Jumbo)',
      items: preview.filter((p) => p.dedupCount > 0),
      describe: (p: Preview) =>
        `${fileCountLabel(p.dedupCount)} · ${p.rev.slice(0, 12)}`,
    },
    {
      title: 'Linking into Lemonade (already in Turbo Jumbo)',
      items: preview.filter((p) => p.linkCount > 0),
      describe: (p: Preview) =>
        `${fileCountLabel(p.linkCount)} · ${p.rev.slice(0, 12)}`,
    },
    {
      title: 'Removing stale Lemonade links (target no longer exists)',
      items: preview.filter((p) => p.staleCount > 0),
      describe: (p: Preview) =>
        `${fileCountLabel(p.staleCount)} · ${p.rev.slice(0, 12)}`,
    },
    {
      title: 'Skipped — cannot link into Lemonade',
      hint: 'These models have no recorded revision. Audit them to record one, then consolidate again.',
      items: preview.filter((p) => p.blocked),
      describe: () => 'no revision recorded',
    },
  ].filter((s) => s.items.length > 0);
  const counts = results
    .flatMap((r) => r.files)
    .reduce<Record<string, number>>((acc, f) => {
      acc[f.status] = (acc[f.status] ?? 0) + 1;
      return acc;
    }, {});
  const sorted = placement.filter((p) => p.status === 'moved').length;
  const offered = extra.filter((e) => e.toLink > 0).length;
  const errors = results
    .flatMap((r) => r.files.map((f) => ({repoId: r.repoId, ...f})))
    .filter((f) => f.status === 'error');

  // Every kind of work a run does, in one list so a count of zero simply drops
  // out. A badge that renders its own absence — "0 linked" after a run that
  // sorted twenty-seven directories — reads as failure.
  //
  // `linked` and `materialized` are opposite directions and were both once
  // labelled "linked": one imports a Lemonade-only file into Turbo Jumbo, the
  // other lends a Turbo Jumbo file back to Lemonade.
  const plural = (n: number, one: string, many = `${one}s`) =>
    n === 1 ? one : many;
  const tallies: Array<{
    label: string;
    variant: 'success' | 'neutral' | 'error';
  }> = (
    [
      [counts.linked ?? 0, (n: number) => `${n} imported`, 'success'],
      [counts.deduplicated ?? 0, (n: number) => `${n} deduplicated`, 'success'],
      [
        counts.materialized ?? 0,
        (n: number) => `${n} linked into Lemonade`,
        'success',
      ],
      [
        counts['stale-removed'] ?? 0,
        (n: number) => `${n} stale ${plural(n, 'link')} removed`,
        'success',
      ],
      [sorted, (n: number) => `${n} sorted into builtin/extra`, 'success'],
      [offered, (n: number) => `${n} offered to Lemonade`, 'success'],
      [counts.skipped ?? 0, (n: number) => `${n} skipped`, 'neutral'],
      [errors.length, (n: number) => `${n} failed`, 'error'],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, label, variant]) => ({label: label(n), variant}));

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      width={620}
      purpose="form"
    >
      {/* Header and footer stay pinned; a long preview scrolls in between, so
          the action buttons remain reachable however many models are listed. */}
      <Layout
        header={<DialogHeader title="Consolidate with Lemonade" />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <Text type="supporting">
                Moves models that exist only in Lemonade into Turbo Jumbo&apos;s
                file structure, and deduplicates files Turbo Jumbo already holds
                — then replaces the Lemonade copies with symbolic links into
                Turbo Jumbo. Catalog models Turbo Jumbo already has but Lemonade
                hasn&apos;t downloaded are linked into Lemonade&apos;s cache,
                and stale links whose files were deleted are removed.
              </Text>
              <Text type="supporting">
                It also keeps Lemonade&apos;s two directories in order: its
                cache holds what Lemonade lists, and its extra-models directory
                is offered everything else this machine holds — so a model
                Lemonade has never heard of can be served from the copy you
                already have.
              </Text>

              {phase === 'loading' && (
                <Text type="body">Finding models to sync…</Text>
              )}

              {phase === 'error' && <Text type="body">{error}</Text>}

              {phase === 'preview' &&
                (pending === 0 ? (
                  <Text type="body">
                    Nothing to sync — Lemonade is already consolidated into
                    Turbo Jumbo.
                  </Text>
                ) : (
                  <VStack gap={3}>
                    {placement.length > 0 && (
                      <VStack gap={1}>
                        <Text type="supporting">
                          Sorting Lemonade&apos;s cache
                        </Text>
                        <Text type="supporting">
                          Models Lemonade lists go in builtin, the rest in
                          extra. Directories are moved; no files change.
                        </Text>
                        <List hasDividers>
                          {placement.map((p) => (
                            <ListItem
                              key={`${p.repoId}-${p.side}`}
                              label={p.repoId}
                              description={
                                p.status === 'conflict'
                                  ? `already in ${p.side} — left alone`
                                  : `→ ${p.side}`
                              }
                            />
                          ))}
                        </List>
                      </VStack>
                    )}
                    {extra.length > 0 && (
                      <VStack gap={1}>
                        <Text type="supporting">
                          Offering to Lemonade (models it doesn&apos;t list)
                        </Text>
                        <Text type="supporting">
                          Linked into Lemonade&apos;s extra-models directory
                          under the name shown. GGUF only — it loads nothing
                          else from there.
                        </Text>
                        <List hasDividers>
                          {extra.map((e) => (
                            <ListItem
                              key={e.folder}
                              label={`extra.${e.folder}`}
                              description={
                                e.toLink > 0
                                  ? `${e.repoId} · ${fileCountLabel(e.toLink)}`
                                  : `${e.repoId} · removing ${fileCountLabel(e.toRemove)}`
                              }
                            />
                          ))}
                        </List>
                      </VStack>
                    )}
                    {sections.map((s) => (
                      <VStack key={s.title} gap={1}>
                        <Text type="supporting">{s.title}</Text>
                        {s.hint && <Text type="supporting">{s.hint}</Text>}
                        <List hasDividers>
                          {s.items.map((p) => (
                            <ListItem
                              key={p.repoId}
                              label={p.repoId}
                              description={s.describe(p)}
                              endContent={<CopyNameButton name={p.repoId} />}
                            />
                          ))}
                        </List>
                      </VStack>
                    ))}
                  </VStack>
                ))}

              {phase === 'running' && (
                <Text type="body">Moving files and creating links…</Text>
              )}

              {phase === 'done' && (
                <VStack gap={2}>
                  {tallies.length > 0 ? (
                    <HStack gap={2} vAlign="center">
                      {tallies.map((t) => (
                        <Badge
                          key={t.label}
                          label={t.label}
                          variant={t.variant}
                        />
                      ))}
                    </HStack>
                  ) : (
                    <Text type="body">
                      Nothing needed changing — Lemonade and Turbo Jumbo were
                      already in step.
                    </Text>
                  )}
                  {errors.map((e, i) => (
                    <Text key={i} type="supporting">
                      {e.repoId}/{e.repoPath}: {e.message}
                    </Text>
                  ))}
                </VStack>
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              {phase === 'done' || phase === 'error' ? (
                <Button label="Close" variant="primary" onClick={onClose} />
              ) : (
                <>
                  <Button
                    label="Cancel"
                    variant="secondary"
                    onClick={onClose}
                    isDisabled={phase === 'running'}
                  />
                  <Button
                    label={
                      phase === 'running'
                        ? 'Syncing…'
                        : // Say what the run will actually do. Counting only
                          // file work read as "N models" on a run whose whole
                          // job was moving directories, and then reported none.
                          [
                            actionable.length > 0
                              ? `Sync ${actionable.length} model${actionable.length === 1 ? '' : 's'} (${fileCountLabel(totalFiles)})`
                              : null,
                            placement.length > 0
                              ? `Sort ${placement.length}`
                              : null,
                            extra.length > 0 ? `Offer ${extra.length}` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ') || 'Sync'
                    }
                    variant="primary"
                    onClick={runSync}
                    isDisabled={phase !== 'preview' || pending === 0}
                  />
                </>
              )}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
