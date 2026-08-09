import {CliError, type Client} from '@/cli/client';
import type {CommandOutput} from '@/cli/output';
import {fetchPeers} from '@/cli/fetch-peers';
import {peerSlug} from '@/lib/peers/peer-slug';
import type {CliInvocation} from '@/lib/cli/args';
import {renderTable, type Column} from '@/lib/cli/format';
import {formatSize} from '@/lib/format/bytes';
import {matchVariantFiles} from '@/lib/lemonade/lemonade-plan';
import type {LemonadeModel} from '@/lib/lemonade/lemonade-types';
import type {LemonadeSyncPreview} from '@/lib/lemonade/lemonade-sync';
import type {Model} from '@/lib/models/model-types';

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
): Promise<CommandOutput> {
  const sub = inv.positionals[0];
  if (sub === 'ls') return lemonadeLs(client, inv, color);
  if (sub === 'sync') return lemonadeSync(client, inv, color);
  throw new CliError(
    `Usage: tj lemonade ls | tj lemonade sync [--dry-run] [--yes]`,
  );
}

interface CatalogRow {
  name: string;
  repoId: string;
  variant: string;
  sizeGb: number;
  where: string;
}

/** `tj lemonade ls` — the catalog, marked with what is already on this machine. */
async function lemonadeLs(
  client: Client,
  inv: CliInvocation,
  color: boolean,
): Promise<CommandOutput> {
  const [catalog, cache, local] = await Promise.all([
    client.json<{models: LemonadeModel[]}>('/api/v1/lemonade-models'),
    client.json<Model[]>('/api/v1/lemonade-cache'),
    client.json<Model[]>('/api/v1/local-models'),
  ]);

  const pattern = inv.positionals[1]?.toLowerCase();

  const rows: CatalogRow[] = catalog.models
    .filter(
      (m) =>
        !pattern ||
        m.name.toLowerCase().includes(pattern) ||
        m.repoId.toLowerCase().includes(pattern),
    )
    .map((m) => {
      const where: string[] = [];
      if (holds(cache, m)) where.push('lemonade');
      if (holds(local, m)) where.push('local');
      return {
        name: m.name,
        repoId: m.repoId,
        variant: m.variant ?? '(whole repo)',
        sizeGb: m.sizeGb,
        where: where.join(', '),
      };
    });

  const columns: Column<CatalogRow>[] = [
    {header: 'NAME', value: (r) => r.name},
    {header: 'REPO', value: (r) => r.repoId},
    {header: 'VARIANT', value: (r) => r.variant},
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
