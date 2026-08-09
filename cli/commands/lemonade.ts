import {CliError, type Client} from '@/cli/client';
import type {CommandOutput} from '@/cli/output';
import type {TransferContext} from '@/cli/commands/get';
import {fetchPeers} from '@/cli/fetch-peers';
import {runTransfer, summarise} from '@/cli/transfer';
import {peerSlug} from '@/lib/peers/peer-slug';
import type {CliInvocation} from '@/lib/cli/args';
import {renderTable, type Column} from '@/lib/cli/format';
import {
  matchEntries,
  planCatalogDownload,
  planFlmDownload,
  type DownloadPlan,
  type LemonadeEntry,
  type PlanResult,
} from '@/lib/cli/lemonade-get-plan';
import {formatSize} from '@/lib/format/bytes';
import type {FlmModel} from '@/lib/lemonade/flm';
import {
  matchVariantFiles,
  missingVariantFiles,
} from '@/lib/lemonade/lemonade-plan';
import type {LemonadeModel} from '@/lib/lemonade/lemonade-types';
import type {LemonadeSyncPreview} from '@/lib/lemonade/lemonade-sync';
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
): Promise<CommandOutput> {
  const sub = inv.positionals[0];
  if (sub === 'ls') return lemonadeLs(client, inv, color);
  if (sub === 'get') return lemonadeGet(client, inv, ctx);
  if (sub === 'sync') return lemonadeSync(client, inv, color);
  throw new CliError(
    `Usage: tj lemonade ls | tj lemonade get <model> | tj lemonade sync [--dry-run] [--yes]`,
  );
}

/**
 * The catalog and the FLM models of one Lemonade server, as one list.
 *
 * FLM models never appear in the static catalog — a Lemonade server discovers
 * them from its local `flm` binary — so they are fetched per peer. A peer with
 * no `lemonade_url`, or one whose server is down, contributes none rather than
 * failing the command: the catalog half is still worth answering with.
 */
async function lemonadeEntries(
  client: Client,
  inv: CliInvocation,
): Promise<LemonadeEntry[]> {
  const slug = await flmPeerSlug(client, inv);
  const [catalog, flm] = await Promise.all([
    client.json<{models: LemonadeModel[]}>('/api/v1/lemonade-models'),
    slug
      ? client.tryJson<{configured: boolean; models: FlmModel[]}>(
          `/api/v1/lemonade/flm?peer=${encodeURIComponent(slug)}`,
        )
      : Promise.resolve(null),
  ]);
  return [
    ...catalog.models.map((model) => ({kind: 'catalog' as const, model})),
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
  if (!pattern) throw new CliError('Usage: tj lemonade get <model>');

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

  const {plan, repoFiles} = await resolve(client, entry);

  if (inv.deleteAfter && inv.to !== 'cold') {
    throw new CliError(
      '--delete-after only makes sense with --to cold: it removes the local copy after archiving it.',
    );
  }

  const sizeOf = new Map(repoFiles.map((f) => [f.path, f.size]));
  const chosen = plan.filePaths.map((path) => ({
    path,
    size: sizeOf.get(path) ?? 0,
  }));
  const total = chosen.reduce((s, f) => s + f.size, 0);
  const summary = {
    model: entry.model.name,
    repo: plan.repoId,
    revision: plan.branch,
    files: chosen,
    totalBytes: total,
    ...(plan.fileScope ? {fileScope: plan.fileScope} : {}),
    toColdStorage: inv.to === 'cold',
    deleteAfterTransfer: inv.deleteAfter,
  };

  if (inv.dryRun) {
    return {
      json: {dryRun: true, ...summary},
      table: renderGetPlan(entry.model.name, plan, chosen, total, inv),
      quiet: chosen.map((f) => f.path),
    };
  }

  const run = await runTransfer({
    client,
    path: '/api/v1/hf-download',
    body: {
      repoId: plan.repoId,
      branch: plan.branch,
      filePaths: plan.filePaths,
      ...(plan.fileScope ? {fileScope: plan.fileScope} : {}),
      sendToCold: inv.to === 'cold',
      deleteAfterTransfer: inv.deleteAfter,
    },
    format: 'text',
    expectedFiles: chosen.length,
    showProgress: ctx.showProgress,
    isTty: ctx.isTty,
    write: ctx.write,
  });

  if (run.errors.length > 0) {
    throw new CliError(
      `Download failed:\n${run.errors.map((e) => `  ${e}`).join('\n')}`,
    );
  }

  return {
    json: {...summary, elapsedMs: run.elapsedMs},
    table: summarise('downloaded', run),
    quiet: [],
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
): Promise<{plan: DownloadPlan; repoFiles: HfFile[]}> {
  const listing = (repoId: string, branch: string) =>
    client.json<HfFile[]>(
      `/api/v1/hf-files?${new URLSearchParams({repoId, branch})}`,
    );
  const local = () => client.json<Model[]>('/api/v1/local-models');

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
    return {
      plan: unwrap(planFlmDownload(source, repoFiles, targetModels)),
      repoFiles,
    };
  }

  const [repoFiles, targetModels] = await Promise.all([
    listing(entry.model.repoId, 'main'),
    local(),
  ]);
  return {
    plan: unwrap(planCatalogDownload(entry.model, repoFiles, targetModels)),
    repoFiles,
  };
}

const unwrap = (r: PlanResult): DownloadPlan => {
  if (!r.ok) throw new CliError(r.error);
  return r.plan;
};

function renderGetPlan(
  name: string,
  plan: DownloadPlan,
  chosen: HfFile[],
  total: number,
  inv: CliInvocation,
): string {
  const columns: Column<HfFile>[] = [
    {header: 'FILE', value: (f) => f.path},
    {header: 'SIZE', value: (f) => formatSize(f.size), align: 'right'},
  ];
  const dest = inv.to === 'cold' ? 'local storage, then cold' : 'local storage';
  const at =
    plan.branch === 'main' ? plan.repoId : `${plan.repoId}@${plan.branch}`;
  return [
    `Would download ${chosen.length} file(s) for ${name} from ${at} to ${dest}:`,
    '',
    renderTable(columns, chosen),
    '',
    `total ${formatSize(total)}${inv.deleteAfter ? ' · local copy removed after archiving' : ''}`,
    ...(plan.fileScope
      ? ['', 'These files would be recorded as the model’s complete set.']
      : []),
  ].join('\n');
}

interface CatalogRow {
  name: string;
  repoId: string;
  variant: string;
  // Which runtime the entry is for: `llamacpp` for the GGUF catalog, `flm` for
  // a live server's NPU models. They come from different places and download
  // differently, so the column earns its width.
  recipe: string;
  sizeGb: number;
  where: string;
}

/** A catalog GGUF model's row. */
function row(m: LemonadeModel, cache: Model[], local: Model[]): CatalogRow {
  const where: string[] = [];
  if (holds(cache, m)) where.push('lemonade');
  if (holds(local, m)) where.push('local');
  return {
    name: m.name,
    repoId: m.repoId,
    variant: m.variant ?? '(whole repo)',
    recipe: 'llamacpp',
    sizeGb: m.sizeGb,
    where: where.join(', '),
  };
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
  if (
    m.source &&
    m.source.files.length > 0 &&
    missingVariantFiles(m.source.files, local, m.source.repoId).length === 0
  ) {
    where.push('local');
  }
  return {
    name: m.name,
    repoId: m.source?.repoId ?? '',
    variant: m.checkpoint,
    recipe: 'flm',
    sizeGb: m.sizeGb,
    where: where.join(', '),
  };
}

/** `tj lemonade ls` — the catalog, marked with what is already on this machine. */
async function lemonadeLs(
  client: Client,
  inv: CliInvocation,
  color: boolean,
): Promise<CommandOutput> {
  const [entries, cache, local] = await Promise.all([
    lemonadeEntries(client, inv),
    client.json<Model[]>('/api/v1/lemonade-cache'),
    client.json<Model[]>('/api/v1/local-models'),
  ]);

  const pattern = inv.positionals[1]?.toLowerCase();

  const rows: CatalogRow[] = entries
    .map((e) =>
      e.kind === 'flm' ? flmRow(e.model, local) : row(e.model, cache, local),
    )
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
    quiet: rows.map((r) => r.name),
  };
}

/**
 * Whether a storage tier holds a catalog entry, resolved **within that entry's
 * own repo**.
 *
 * The variant is often a bare quant token (`UD-Q4_K_XL`, `Q8_0`) rather than a
 * filename — 38 of the 84 catalog entries at the time of writing — so matching
 * it against every file on the machine reports any model's `Q8_0` as this
 * entry's. `matchVariantFiles` is the resolver the Lemonade downloader already
 * uses, and it works from one repo's file list, which is exactly the scoping
 * that keeps the answer honest.
 */
function holds(models: Model[], m: LemonadeModel): boolean {
  const repo = models.find((x) => x.name === m.repoId);
  if (!repo) return false;
  const files = repo.files.flatMap((f) =>
    f.isSplit
      ? f.files.map((s) => ({path: s.path, size: s.size}))
      : [{path: f.path, size: f.size}],
  );
  return matchVariantFiles(files, m.variant, m.mmproj).length > 0;
}

/** `tj lemonade sync` — preview with `--dry-run`, run with `--yes`. */
async function lemonadeSync(
  client: Client,
  inv: CliInvocation,
  color: boolean,
): Promise<CommandOutput> {
  const base = await syncPath(client, inv);

  if (inv.dryRun) {
    const {preview} = await client.json<{preview: LemonadeSyncPreview[]}>(base);
    const columns: Column<LemonadeSyncPreview>[] = [
      {header: 'REPO', value: (p) => p.repoId},
      {header: 'MOVE', value: (p) => String(p.moveCount), align: 'right'},
      {header: 'DEDUP', value: (p) => String(p.dedupCount), align: 'right'},
      {header: 'LINK', value: (p) => String(p.linkCount), align: 'right'},
      {header: 'STALE', value: (p) => String(p.staleCount), align: 'right'},
      {header: 'NOTE', value: (p) => (p.blocked ? p.blocked : '')},
    ];
    const totals = preview.reduce(
      (a, p) => ({
        move: a.move + p.moveCount,
        dedup: a.dedup + p.dedupCount,
        link: a.link + p.linkCount,
        stale: a.stale + p.staleCount,
      }),
      {move: 0, dedup: 0, link: 0, stale: 0},
    );
    return {
      json: {dryRun: true, preview, totals},
      table:
        preview.length === 0
          ? 'Nothing to sync.'
          : [
              renderTable(columns, preview, color),
              '',
              `would move ${totals.move}, deduplicate ${totals.dedup}, ` +
                `link ${totals.link}, remove ${totals.stale} stale link(s)`,
              // DEDUP and STALE are deletions; say so rather than letting two
              // neutral-looking columns hide it.
              `deduplicating and removing stale links deletes files from Lemonade's cache`,
            ].join('\n'),
      quiet: preview.map((p) => p.repoId),
    };
  }

  if (!inv.yes) {
    throw new CliError(
      'tj lemonade sync needs --yes: it moves files and deletes ' +
        "Lemonade's duplicate copies and stale links.\n" +
        'Try --dry-run first to see what would change.',
    );
  }

  const res = await fetch(`${client.baseUrl}${base}`, {method: 'POST'});
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).trim();
    throw new CliError(
      `Sync failed: ${res.status} ${res.statusText}${body ? `: ${body}` : ''}`,
    );
  }
  const {results} = (await res.json()) as {
    results: Array<{repoId: string; rev: string; files: unknown[]}>;
  };
  const fileCount = results.reduce((s, r) => s + r.files.length, 0);
  return {
    json: {results},
    table: `synced ${results.length} model(s) · ${fileCount} file(s)`,
    quiet: results.map((r) => r.repoId),
  };
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
