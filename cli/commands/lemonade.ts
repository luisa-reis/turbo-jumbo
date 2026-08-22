import {CliError, UsageError, type Client} from '@/cli/client';
import type {CommandOutput} from '@/cli/output';
import type {TransferContext} from '@/cli/commands/get';
import {fetchPeers} from '@/cli/fetch-peers';
import {runTransfer, summarise, type TransferResult} from '@/cli/transfer';
import {peerSlug} from '@/lib/peers/peer-slug';
import type {CliInvocation} from '@/lib/cli/args';
import {confirmDestructive, type ConfirmIo} from '@/lib/cli/confirm';
import type {Placement} from '@/lib/lemonade/lemonade-place';
import type {ExtraChange} from '@/lib/lemonade/lemonade-extra';
import type {FlmStoreChange} from '@/lib/lemonade/lemonade-flm-store';
import {renderTable, type Column} from '@/lib/cli/format';
import {
  matchEntries,
  planCatalogDownload,
  planComponentDownload,
  planFlmDownload,
  type DownloadPlan,
  type LemonadeEntry,
  type PlanResult,
} from '@/lib/cli/lemonade-get-plan';
import {formatSize} from '@/lib/format/bytes';
import type {FlmModel} from '@/lib/lemonade/flm';
import {missingVariantFiles} from '@/lib/lemonade/lemonade-plan';
import {
  componentDownloadStatus,
  componentInLemonadeCache,
  lemonadeDownloadStatus,
  modelCacheSide,
} from '@/lib/lemonade/lemonade-status';
import type {
  DownloadStatus,
  InventoryLocation,
  LemonadeComponent,
  LemonadeModel,
} from '@/lib/lemonade/lemonade-types';
import type {LemonadeSyncPreview} from '@/lib/lemonade/lemonade-sync';
import type {CachedModel} from '@/lib/lemonade/lemonade-cache-scan';
import type {Model} from '@/lib/models/model-types';

type HfFile = {path: string; size: number};

/**
 * `tj lemonade` — browse the Lemonade catalog, and reconcile its cache with
 * Turbo Jumbo's storage.
 *
 * Lemonade keeps a separate on-disk cache of models it has pulled. `sync`
 * consolidates that into Turbo Jumbo and mirrors what Turbo Jumbo already holds
 * back as symlinks, which means it both moves and *deletes* files — hence the
 * same `--yes` the removal command needs.
 */
export async function lemonade(
  client: Client,
  inv: CliInvocation,
  color: boolean,
  ctx: TransferContext,
  io: ConfirmIo,
): Promise<CommandOutput> {
  const sub = inv.positionals[0];
  if (sub === 'ls') return lemonadeLs(client, inv, color);
  if (sub === 'get') return lemonadeGet(client, inv, ctx);
  if (sub === 'sync') return lemonadeSync(client, inv, color, io);
  throw new UsageError(
    `Usage: tj lemonade ls | tj lemonade get <model> | tj lemonade sync [--dry-run] [--yes]`,
  );
}

/**
 * Everything the CLI can name: the catalog's llamacpp models, its other
 * standalone models (vLLM, ONNX, image, speech, TTS — carried as components),
 * and the FLM models of one Lemonade server.
 *
 * FLM models never appear in the static catalog — a Lemonade server discovers
 * them from its local `flm` binary — so they are fetched per peer. A peer with
 * no `lemonade_url`, or one whose server is down, contributes none rather than
 * failing the command: the catalog half is still worth answering with.
 *
 * Omni collections stay out: they are bundles of these entries rather than a
 * download of their own, and their members are reachable individually.
 */
async function lemonadeEntries(
  client: Client,
  inv: CliInvocation,
): Promise<LemonadeEntry[]> {
  const slug = await flmPeerSlug(client, inv);
  const [catalog, flm] = await Promise.all([
    client.json<{models: LemonadeModel[]; extraModels: LemonadeComponent[]}>(
      '/api/v1/lemonade-models',
    ),
    slug
      ? client.tryJson<{configured: boolean; models: FlmModel[]}>(
          `/api/v1/lemonade/flm?peer=${encodeURIComponent(slug)}`,
        )
      : Promise.resolve(null),
  ]);
  return [
    ...catalog.models.map((model) => ({kind: 'catalog' as const, model})),
    // Only the ones with checkpoints to fetch: an entry the catalog names but
    // gives no repo for can't be downloaded, so listing it would be a lie.
    ...(catalog.extraModels ?? [])
      .filter((model) => model.downloadable)
      .map((model) => ({kind: 'component' as const, model})),
    ...(flm?.models ?? []).map((model) => ({kind: 'flm' as const, model})),
  ];
}

/** Whose Lemonade server lists the FLM models: `--peer`, else the local one. */
async function flmPeerSlug(
  client: Client,
  inv: CliInvocation,
): Promise<string | null> {
  const peers = await fetchPeers(client);
  if (!inv.peer) {
    const local = peers.find((p) => p.isLocal);
    return local ? peerSlug(local) : null;
  }
  const peer = peers.find((p) => peerSlug(p) === inv.peer);
  if (!peer) {
    throw new CliError(
      `Unknown peer '${inv.peer}'. Try: ${peers.map(peerSlug).join(', ')}`,
    );
  }
  return peerSlug(peer);
}

/**
 * `tj lemonade get <model>` — download a catalog model or an FLM model into
 * Turbo Jumbo storage, resolving the name the way `tj lemonade ls` prints it.
 *
 * Both paths end at `/api/v1/hf-download`, the endpoint the download modal
 * posts to. An FLM model's request carries the registry's file list as its
 * scope, so the repo's other files — NPU kernels for targets this model
 * doesn't use — aren't counted against it as missing.
 */
async function lemonadeGet(
  client: Client,
  inv: CliInvocation,
  ctx: TransferContext,
): Promise<CommandOutput> {
  const pattern = inv.positionals[1];
  if (!pattern) throw new UsageError('Usage: tj lemonade get <model>');

  const entries = await lemonadeEntries(client, inv);
  const hits = matchEntries(entries, pattern);
  if (hits.length === 0) {
    throw new CliError(
      `Nothing in the Lemonade catalog matches '${pattern}'.\n` +
        `Run 'tj lemonade ls' to see what there is.`,
    );
  }
  if (hits.length > 1) {
    throw new CliError(
      `'${pattern}' matches ${hits.length} models. Narrow it:\n` +
        hits.map((e) => `  ${e.model.name}`).join('\n'),
    );
  }
  const entry = hits[0];

  if (inv.deleteAfter && inv.to !== 'cold') {
    throw new CliError(
      '--delete-after only makes sense with --to cold: it removes the local copy after archiving it.',
    );
  }

  // One job per repo: a component's checkpoints can span several (an image
  // pipeline's UNet and VAE), and a single-repo entry is just the case of one.
  const jobs = await resolve(client, entry);
  const total = jobs.reduce((s, j) => s + j.totalBytes, 0);
  const summary = {
    model: entry.model.name,
    repos: jobs.map((j) => ({
      repo: j.plan.repoId,
      revision: j.plan.branch,
      files: j.chosen,
      totalBytes: j.totalBytes,
      ...(j.plan.fileScope ? {fileScope: j.plan.fileScope} : {}),
    })),
    totalBytes: total,
    toColdStorage: inv.to === 'cold',
    deleteAfterTransfer: inv.deleteAfter,
  };

  if (inv.dryRun) {
    return {
      json: {dryRun: true, ...summary},
      table: renderGetPlan(entry.model.name, jobs, total, inv),
      lines: jobs.flatMap((j) => j.chosen.map((f) => f.path)),
    };
  }

  const runs: TransferResult[] = [];
  for (const [i, job] of jobs.entries()) {
    // Name the repo when there is more than one, so a multi-repo model's
    // progress bars aren't three anonymous runs in a row.
    if (jobs.length > 1 && ctx.showProgress) {
      ctx.write(
        `${i > 0 ? '\n' : ''}${job.plan.repoId}  (${i + 1}/${jobs.length})\n`,
      );
    }
    const run = await runTransfer({
      client,
      path: '/api/v1/hf-download',
      body: {
        repoId: job.plan.repoId,
        branch: job.plan.branch,
        filePaths: job.plan.filePaths,
        ...(job.plan.fileScope ? {fileScope: job.plan.fileScope} : {}),
        sendToCold: inv.to === 'cold',
        deleteAfterTransfer: inv.deleteAfter,
      },
      format: 'text',
      expectedFiles: job.chosen.length,
      showProgress: ctx.showProgress,
      isTty: ctx.isTty,
      write: ctx.write,
    });
    runs.push(run);
    // A failed repo poisons the rest: half a multi-repo model can't run, so
    // stop rather than burying the error under the next download.
    if (run.errors.length > 0) {
      const left = jobs.length - i - 1;
      throw new CliError(
        `Download failed for ${job.plan.repoId}:\n` +
          run.errors.map((e) => `  ${e}`).join('\n') +
          (left > 0 ? `\nStopped: ${left} more repo(s) not attempted.` : ''),
      );
    }
  }

  // One repo reports exactly as `tj get` does; several are rolled into one
  // line, so a three-repo model doesn't end with three separate summaries.
  const rolled: TransferResult = {
    progress: {
      filesDone: runs.reduce((s, r) => s + (r.progress?.filesDone ?? 0), 0),
      filesTotal: runs.reduce((s, r) => s + (r.progress?.filesTotal ?? 0), 0),
      bytesDone: runs.reduce((s, r) => s + (r.progress?.bytesDone ?? 0), 0),
      bytesTotal: runs.reduce((s, r) => s + (r.progress?.bytesTotal ?? 0), 0),
      errors: runs.flatMap((r) => r.progress?.errors ?? []),
    },
    errors: [],
    elapsedMs: runs.reduce((s, r) => s + r.elapsedMs, 0),
    expectedFiles: runs.reduce((s, r) => s + r.expectedFiles, 0),
  };
  return {
    json: {...summary, elapsedMs: rolled.elapsedMs},
    table: summarise('downloaded', rolled),
    lines: [],
  };
}

/**
 * What a chosen entry resolves to: the download to run, and the repo listing it
 * was resolved against (which carries the sizes the plan is reported in). The
 * two kinds fetch from different places — an FLM model from the revision its
 * registry entry pins, a catalog model from its repo's head — so each branch
 * asks for its own listing.
 */
async function resolve(
  client: Client,
  entry: LemonadeEntry,
): Promise<DownloadJob[]> {
  const listing = (repoId: string, branch: string) =>
    client.json<HfFile[]>(
      `/api/v1/hf-files?${new URLSearchParams({repoId, branch})}`,
    );
  const local = () => client.json<Model[]>('/api/v1/local-models');

  if (entry.kind === 'component') {
    const repos = [...new Set(entry.model.checkpoints.map((c) => c.repoId))];
    const [listings, targetModels] = await Promise.all([
      Promise.all(
        repos.map(
          async (repoId) => [repoId, await listing(repoId, 'main')] as const,
        ),
      ),
      local(),
    ]);
    const sizes = new Map(listings);
    const result = planComponentDownload(entry.model, sizes, targetModels);
    if (!result.ok) throw new CliError(result.error);
    return result.plans.map((plan) => job(plan, sizes.get(plan.repoId) ?? []));
  }

  if (entry.kind === 'flm') {
    const source = entry.model.source;
    // An FLM tag the registry doesn't name has no Hugging Face source at all.
    if (!source) {
      throw new CliError(
        `${entry.model.name} has no Hugging Face source: FastFlowLM's ` +
          `registry doesn't name one for '${entry.model.checkpoint}'.\n` +
          `The web UI can ask the Lemonade server to pull it into its own FLM ` +
          `store instead, which is a different place than Turbo Jumbo storage.`,
      );
    }
    const [repoFiles, targetModels] = await Promise.all([
      listing(source.repoId, source.revision),
      local(),
    ]);
    return [
      job(unwrap(planFlmDownload(source, repoFiles, targetModels)), repoFiles),
    ];
  }

  const [repoFiles, targetModels] = await Promise.all([
    listing(entry.model.repoId, 'main'),
    local(),
  ]);
  return [
    job(
      unwrap(planCatalogDownload(entry.model, repoFiles, targetModels)),
      repoFiles,
    ),
  ];
}

/** One repo's download, with the sizes its plan is reported in. */
interface DownloadJob {
  plan: DownloadPlan;
  chosen: HfFile[];
  totalBytes: number;
}

function job(plan: DownloadPlan, repoFiles: HfFile[]): DownloadJob {
  const sizeOf = new Map(repoFiles.map((f) => [f.path, f.size]));
  const chosen = plan.filePaths.map((path) => ({
    path,
    size: sizeOf.get(path) ?? 0,
  }));
  return {plan, chosen, totalBytes: chosen.reduce((s, f) => s + f.size, 0)};
}

const unwrap = (r: PlanResult): DownloadPlan => {
  if (!r.ok) throw new CliError(r.error);
  return r.plan;
};

function renderGetPlan(
  name: string,
  jobs: DownloadJob[],
  total: number,
  inv: CliInvocation,
): string {
  const columns: Column<HfFile>[] = [
    {header: 'FILE', value: (f) => f.path},
    {header: 'SIZE', value: (f) => formatSize(f.size), align: 'right'},
  ];
  const dest = inv.to === 'cold' ? 'local storage, then cold' : 'local storage';
  const count = jobs.reduce((s, j) => s + j.chosen.length, 0);
  const scoped = jobs.some((j) => j.plan.fileScope);
  return [
    `Would download ${count} file(s) for ${name} to ${dest}:`,
    ...jobs.flatMap((j) => {
      const at =
        j.plan.branch === 'main'
          ? j.plan.repoId
          : `${j.plan.repoId}@${j.plan.branch}`;
      return ['', `${at}`, renderTable(columns, j.chosen)];
    }),
    '',
    `total ${formatSize(total)}${inv.deleteAfter ? ' · local copy removed after archiving' : ''}`,
    ...(scoped
      ? ['', 'These files would be recorded as the model’s complete set.']
      : []),
  ].join('\n');
}

interface CatalogRow {
  name: string;
  repoId: string;
  variant: string;
  // Which runtime the entry is for: `llamacpp` for the GGUF catalog, `vllm` /
  // `oga-*` / `sd-cpp` and friends for its other standalone models, `flm` for a
  // live server's NPU models. They come from different places and download
  // differently, so the column earns its width.
  recipe: string;
  sizeGb: number;
  where: string;
}

/** A catalog GGUF model's row. */
function row(m: LemonadeModel, cache: Model[], local: Model[]): CatalogRow {
  const where: string[] = [];
  const side = modelCacheSide(m, cache);
  if (side) where.push(`lemonade (${side})`);
  return {
    name: m.name,
    repoId: m.repoId,
    variant: m.variant ?? '(whole repo)',
    recipe: 'llamacpp',
    sizeGb: m.sizeGb,
    where: whereWith(where, lemonadeDownloadStatus(m, localOnly(local)).status),
  };
}

/**
 * A standalone non-llamacpp model's row — vLLM, ONNX, image, speech, TTS. Its
 * checkpoints can span several repos, so `REPO` lists them; one is the usual
 * case. `VARIANT` names the files they pin, and reads `(whole repo)` when the
 * catalog names none, which is what a vLLM checkpoint normally does.
 */
function componentRow(
  c: LemonadeComponent,
  cache: Model[],
  local: Model[],
): CatalogRow {
  const where: string[] = [];
  if (componentInLemonadeCache(c, cache)) where.push('lemonade');
  const variants = [
    ...new Set(c.checkpoints.map((cp) => cp.variant ?? '(whole repo)')),
  ];
  return {
    name: c.name,
    repoId: [...new Set(c.checkpoints.map((cp) => cp.repoId))].join(', '),
    variant: variants.join(', '),
    recipe: c.recipe,
    sizeGb: c.sizeGb,
    where: whereWith(
      where,
      componentDownloadStatus(c, localOnly(local)).status,
    ),
  };
}

// The local storage scan as the status functions take it.
const localOnly = (local: Model[]): InventoryLocation[] => [
  {name: 'local', models: local, isLocal: true},
];

/**
 * The WHERE cell. A partial local copy says so rather than reading as held —
 * the whole point of the column is knowing what you'd have to fetch, and half a
 * model is not having it.
 */
function whereWith(before: string[], status: DownloadStatus): string {
  const where = [...before];
  if (status === 'complete') where.push('local');
  else if (status === 'partial') where.push('local (partial)');
  return where.join(', ');
}

/**
 * An FLM model's row. `lemonade` here means the Lemonade server's own FLM
 * store, which is where it reports the model as downloaded; `local` means Turbo
 * Jumbo storage holds every file the registry names. A tag the registry doesn't
 * name has no repo to look in, so it shows none.
 */
function flmRow(m: FlmModel, local: Model[]): CatalogRow {
  const where: string[] = [];
  if (m.downloaded) where.push('lemonade');
  return {
    name: m.name,
    repoId: m.source?.repoId ?? '',
    variant: m.checkpoint,
    recipe: 'flm',
    sizeGb: m.sizeGb,
    where: whereWith(where, flmLocalStatus(m, local)),
  };
}

/**
 * How much of an FLM model Turbo Jumbo storage holds, judged against the exact
 * files FastFlowLM's registry names — more precise than a whole-repo presence
 * check, because the repo carries kernels for other targets that aren't part of
 * this model. A tag the registry doesn't name has no file list to judge.
 */
function flmLocalStatus(m: FlmModel, local: Model[]): DownloadStatus {
  const files = m.source?.files ?? [];
  if (!m.source || files.length === 0) return 'none';
  const missing = missingVariantFiles(files, local, m.source.repoId);
  if (missing.length === 0) return 'complete';
  return missing.length < files.length ? 'partial' : 'none';
}

/** `tj lemonade ls` — the catalog, marked with what is already on this machine. */
async function lemonadeLs(
  client: Client,
  inv: CliInvocation,
  color: boolean,
): Promise<CommandOutput> {
  const [entries, cache, local] = await Promise.all([
    lemonadeEntries(client, inv),
    client.json<CachedModel[]>('/api/v1/lemonade-cache'),
    client.json<Model[]>('/api/v1/local-models'),
  ]);

  const pattern = inv.positionals[1]?.toLowerCase();

  const rows: CatalogRow[] = entries
    .map((e) => {
      if (e.kind === 'flm') return flmRow(e.model, local);
      if (e.kind === 'component') return componentRow(e.model, cache, local);
      return row(e.model, cache, local);
    })
    .filter(
      (r) =>
        !pattern ||
        r.name.toLowerCase().includes(pattern) ||
        r.repoId.toLowerCase().includes(pattern),
    );

  const columns: Column<CatalogRow>[] = [
    {header: 'NAME', value: (r) => r.name},
    {header: 'REPO', value: (r) => r.repoId},
    {header: 'VARIANT', value: (r) => r.variant},
    {header: 'RECIPE', value: (r) => r.recipe},
    {
      header: 'SIZE',
      value: (r) => (r.sizeGb > 0 ? formatSize(r.sizeGb * 1024 ** 3) : ''),
      align: 'right',
    },
    {header: 'WHERE', value: (r) => r.where},
  ];

  return {
    json: rows,
    table: renderTable(columns, rows, color),
    lines: rows.map((r) => r.name),
  };
}

/** `tj lemonade sync` — preview with `--dry-run`, run with `--yes`. */
async function lemonadeSync(
  client: Client,
  inv: CliInvocation,
  color: boolean,
  io: ConfirmIo,
): Promise<CommandOutput> {
  const base = await syncPath(client, inv);

  if (inv.dryRun) {
    const {
      preview,
      placement,
      extra,
      flm = [],
    } = await client.json<{
      preview: LemonadeSyncPreview[];
      placement: Placement[];
      extra: ExtraChange[];
      flm?: FlmStoreChange[];
    }>(base);
    const columns: Column<LemonadeSyncPreview>[] = [
      {header: 'REPO', value: (p) => p.repoId},
      {header: 'SIDE', value: (p) => p.side},
      {header: 'MOVE', value: (p) => String(p.moveCount), align: 'right'},
      {header: 'DEDUP', value: (p) => String(p.dedupCount), align: 'right'},
      {header: 'LINK', value: (p) => String(p.linkCount), align: 'right'},
      {header: 'STALE', value: (p) => String(p.staleCount), align: 'right'},
      {
        header: 'NOTE',
        value: (p) =>
          p.emptyEntry ? 'empty — entry removed' : (p.blocked ?? ''),
      },
    ];
    const totals = preview.reduce(
      (a, p) => ({
        move: a.move + p.moveCount,
        dedup: a.dedup + p.dedupCount,
        link: a.link + p.linkCount,
        stale: a.stale + p.staleCount,
        empty: a.empty + (p.emptyEntry ? 1 : 0),
      }),
      {move: 0, dedup: 0, link: 0, stale: 0, empty: 0},
    );
    const nothing =
      preview.length === 0 &&
      placement.length === 0 &&
      extra.length === 0 &&
      flm.length === 0;
    return {
      json: {dryRun: true, preview, placement, extra, flm, totals},
      table: nothing
        ? 'Nothing to sync.'
        : [
            ...(placement.length > 0
              ? [renderPlacement(placement, color), '']
              : []),
            ...(extra.length > 0 ? [renderExtra(extra, color), ''] : []),
            ...(flm.length > 0 ? [renderFlm(flm, color), ''] : []),
            ...(preview.length > 0
              ? [
                  renderTable(columns, preview, color),
                  '',
                  // Only what a run will actually do: a line of zeroes under a
                  // table of changes reads as "nothing will happen".
                  [
                    totals.move > 0 ? `move ${totals.move}` : null,
                    totals.dedup > 0 ? `deduplicate ${totals.dedup}` : null,
                    totals.link > 0 ? `link ${totals.link}` : null,
                    totals.stale > 0
                      ? `remove ${totals.stale} stale link(s)`
                      : null,
                    totals.empty > 0
                      ? `remove ${totals.empty} empty entry(s)`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(', ')
                    .replace(/^./, (c) => `would ${c}`),
                  // DEDUP and STALE are deletions; say so rather than letting
                  // two neutral-looking columns hide it.
                  `deduplicating and removing stale links deletes files from Lemonade's cache`,
                ]
              : []),
          ].join('\n'),
      lines: preview.map((p) => p.repoId),
    };
  }

  const verdict = await confirmDestructive({
    summary:
      "This moves files into Turbo Jumbo and deletes Lemonade's duplicate " +
      'copies and stale links.\n' +
      'Run with --dry-run first to see exactly what would change.',
    preapproved: inv.yes,
    flagHint:
      'tj lemonade sync needs --yes: it moves files and deletes ' +
      "Lemonade's duplicate copies and stale links.\n" +
      'Try --dry-run first to see what would change.',
    io,
  });
  if (!verdict.ok) throw new CliError(verdict.reason);

  const res = await fetch(`${client.baseUrl}${base}`, {method: 'POST'});
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).trim();
    throw new CliError(
      `Sync failed: ${res.status} ${res.statusText}${body ? `: ${body}` : ''}`,
    );
  }
  const {results, placement, extra, flm, flmRefresh} = (await res.json()) as {
    results: Array<{repoId: string; rev: string; files: unknown[]}>;
    placement: Placement[];
    extra: ExtraChange[];
    flm?: FlmStoreChange[];
    flmRefresh?: {ok: boolean; message?: string};
  };
  const fileCount = results.reduce((s, r) => s + r.files.length, 0);
  const sorted = (placement ?? []).filter((p) => p.status === 'moved').length;
  const offered = (extra ?? []).filter((e) => e.toLink > 0).length;
  const offeredFlm = (flm ?? []).filter((f) => f.status === 'link').length;
  return {
    json: {
      results,
      placement,
      extra,
      flm: flm ?? [],
      ...(flmRefresh ? {flmRefresh} : {}),
    },
    table:
      `synced ${results.length} model(s) · ${fileCount} file(s)` +
      (sorted > 0 ? ` · sorted ${sorted} into builtin/extra` : '') +
      (offered > 0 ? ` · offered ${offered} model(s) in extra` : '') +
      (offeredFlm > 0
        ? ` · linked ${offeredFlm} model(s) into flm's store`
        : '') +
      (flmRefresh && !flmRefresh.ok
        ? `\nLemonade was not told about the new links (${flmRefresh.message ?? 'unknown reason'}); it will list them after its next restart.`
        : ''),
    lines: results.map((r) => r.repoId),
  };
}

/** The models being offered to Lemonade through its extra-models directory,
 *  named as Lemonade will list them so the name here is the name there. */
function renderExtra(extra: ExtraChange[], color: boolean): string {
  const columns: Column<ExtraChange>[] = [
    {header: 'MODEL', value: (e) => `extra.${e.folder}`},
    {header: 'REPO', value: (e) => e.repoId},
    {header: 'LINK', value: (e) => String(e.toLink), align: 'right'},
    {header: 'DROP', value: (e) => String(e.toRemove), align: 'right'},
  ];
  return [
    renderTable(columns, extra, color),
    '',
    "Offered to Lemonade's extra-models directory as symlinks — GGUF only, " +
      'since that is all it loads from there.',
  ].join('\n');
}

/** The FLM models being offered to flm's store, named as flm resolves them —
 *  one directory link each. An incomplete one is shown for what it lacks. */
function renderFlm(flm: FlmStoreChange[], color: boolean): string {
  const columns: Column<FlmStoreChange>[] = [
    {header: 'MODEL', value: (f) => f.folder},
    {header: 'REPO', value: (f) => f.repoId},
    {
      header: 'ACTION',
      value: (f) =>
        f.status === 'link'
          ? 'link'
          : f.status === 'remove'
            ? 'remove stale link'
            : `incomplete: missing ${(f.missing ?? []).join(', ')}`,
    },
  ];
  return [
    renderTable(columns, flm, color),
    '',
    "Offered to flm's store (<lemonade>/flm/models) as one directory link per " +
      'model, which is enough for Lemonade to count it as downloaded.',
  ].join('\n');
}

/** What sorting the cache into its two halves would do, or did. Conflicts are
 *  called out by name: they are the only outcome needing a person. */
function renderPlacement(placement: Placement[], color: boolean): string {
  const columns: Column<Placement>[] = [
    {header: 'REPO', value: (p) => p.repoId},
    {header: 'TO', value: (p) => p.side},
    {
      header: 'STATUS',
      value: (p) => (p.status === 'moved' ? 'move' : p.status),
    },
    {header: 'NOTE', value: (p) => p.message ?? ''},
  ];
  return [
    renderTable(columns, placement, color),
    '',
    'These move between builtin/ and extra/ so Lemonade sees each on the ' +
      'side it belongs on.',
  ].join('\n');
}

async function syncPath(client: Client, inv: CliInvocation): Promise<string> {
  if (!inv.peer) return '/api/v1/lemonade/sync';
  const peers = await fetchPeers(client);
  const peer = peers.find((p) => peerSlug(p) === inv.peer);
  if (!peer) {
    throw new CliError(
      `Unknown peer '${inv.peer}'. Try: ${peers.map(peerSlug).join(', ')}`,
    );
  }
  return `/api/v1/peers/${peerSlug(peer)}/lemonade/sync`;
}
