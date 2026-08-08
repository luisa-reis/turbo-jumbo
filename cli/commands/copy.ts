import {CliError, type Client} from '@/cli/client';
import type {CommandOutput} from '@/cli/output';
import type {TransferContext} from '@/cli/commands/get';
import {runTransfer, summarise} from '@/cli/transfer';
import {fetchPeers, type PeerConfig} from '@/cli/fetch-peers';
import {peerSlug} from '@/lib/peers/peer-slug';
import type {CliInvocation} from '@/lib/cli/args';
import {renderTable, type Column} from '@/lib/cli/format';
import {matchModels, planCopyFiles, selectQuants} from '@/lib/cli/copy-plan';
import {resolveSources, type SourceFile} from '@/lib/copy/source-files';
import {formatSize} from '@/lib/format/bytes';
import type {ModelRow} from '@/lib/models/model-row';
import type {Model} from '@/lib/models/model-types';

/**
 * `tj copy` — move existing files between local storage, cold storage and peers
 * through `/api/v1/copy`.
 *
 * There is no `cold push` or `cold pull`: that endpoint already handles cold
 * storage and peers in one request, so `--from` and `--to` express both, the
 * way `ls --cold` replaced a `cold ls`.
 */
export async function copy(
  client: Client,
  inv: CliInvocation,
  ctx: TransferContext,
): Promise<CommandOutput> {
  const pattern = inv.positionals[0];
  if (!pattern) {
    throw new CliError('Usage: tj copy <model> --to cold|<peer>');
  }
  if (!inv.to) throw new CliError('tj copy needs --to cold or --to <peer>.');

  const [rows, peers] = await Promise.all([
    client.json<ModelRow[]>('/api/v1/models-table'),
    fetchPeers(client),
  ]);

  const matches = matchModels(rows, pattern);
  if (matches.length === 0)
    throw new CliError(`No model matches '${pattern}'.`);
  if (matches.length > 1) {
    throw new CliError(
      `'${pattern}' matches ${matches.length} models. Narrow it:\n` +
        matches.map((m) => `  ${m.name}`).join('\n'),
    );
  }
  const row = matches[0];

  const quants = selectQuants(row, inv.quant);
  if (quants.length === 0) {
    throw new CliError(
      `${row.name} has no quantization matching ${inv.quant.join(', ')}.\n` +
        `Available: ${row.quants.map((q) => q.label).join(', ')}`,
    );
  }

  const index = await sourceIndex(client, peers, inv.from);
  const files = planCopyFiles(row.name, quants, index);
  if (files.length === 0) {
    throw new CliError(
      `Nothing to copy: no source holds ${row.name}` +
        `${inv.quant.length > 0 ? ` (${inv.quant.join(', ')})` : ''}` +
        `${inv.from ? ` on ${inv.from}` : ''}.`,
    );
  }

  const dest = resolveDestination(inv.to, peers);
  const total = files.reduce((s, f) => s + f.size, 0);

  if (inv.dryRun) {
    return {
      json: {dryRun: true, model: row.name, files, to: inv.to, total},
      table: renderPlan(row.name, files, total, inv.to, inv.deleteAfter),
      quiet: files.map((f) => f.path),
    };
  }

  // No `skip` list, and no `/api/v1/copy/check` first. That endpoint exists to
  // find files that differ at the destination and ask a human which to
  // overwrite — a question a CLI with no prompts cannot delegate — and it hashes
  // both copies to do it. The copy itself already resumes from whatever prefix
  // matches, so a file that is already there transfers almost nothing; running
  // the check would add a full read of every byte to save that same read.
  const result = await runTransfer({
    client,
    path: '/api/v1/copy',
    body: {
      files,
      toColdStorage: dest.toColdStorage,
      toPeers: dest.toPeers,
      deleteAfterCopy: inv.deleteAfter,
    },
    format: 'json',
    expectedFiles: files.length,
    showProgress: ctx.showProgress,
    isTty: ctx.isTty,
    write: ctx.write,
  });

  if (result.errors.length > 0) {
    throw new CliError(
      `${summarise('copied', result)}\nFailed:\n` +
        result.errors.map((e) => `  ${e}`).join('\n'),
    );
  }

  return {
    json: {
      model: row.name,
      files,
      to: inv.to,
      total,
      elapsedMs: result.elapsedMs,
    },
    table: summarise('copied', result),
    quiet: [],
  };
}

/**
 * Where files may be read from. With `--from` the search is restricted to that
 * one origin; without it every tier is indexed and the largest copy of each
 * file wins (see `lib/copy/source-files`).
 */
async function sourceIndex(
  client: Client,
  peers: PeerConfig[],
  from: string | undefined,
) {
  const local = peers.find((p) => p.isLocal);
  const remotes = peers.filter((p) => !p.isLocal);

  const cold = () => client.json<Model[]>('/api/v1/cold-storage');
  const localModels = () => client.json<Model[]>('/api/v1/local-models');
  const peerModels = (p: PeerConfig) =>
    client.json<Model[]>(`/api/v1/peers/${peerSlug(p)}/models`);

  if (from === 'cold') return resolveSources({cold: await cold()});

  if (from === 'local') {
    if (!local) throw new CliError('This server has no local peer configured.');
    return resolveSources({
      local: {address: local.address, models: await localModels()},
    });
  }

  if (from) {
    const peer = remotes.find((p) => peerSlug(p) === from);
    if (!peer) {
      throw new CliError(
        `Unknown source '${from}'. Try local, cold, or a peer slug: ` +
          `${remotes.map(peerSlug).join(', ') || '(none configured)'}`,
      );
    }
    return resolveSources({
      peers: [{address: peer.address, models: await peerModels(peer)}],
    });
  }

  const [coldModels, localList, remoteLists] = await Promise.all([
    cold(),
    local ? localModels() : Promise.resolve([]),
    Promise.all(
      remotes.map(async (p) => ({
        address: p.address,
        models:
          (await client.tryJson<Model[]>(
            `/api/v1/peers/${peerSlug(p)}/models`,
          )) ?? [],
      })),
    ),
  ]);
  return resolveSources({
    cold: coldModels,
    local: local ? {address: local.address, models: localList} : undefined,
    peers: remoteLists,
  });
}

interface Destination {
  toColdStorage: boolean;
  toPeers: string[];
}

/** `/api/v1/copy` addresses peers by address, so a slug is translated here. */
function resolveDestination(to: string, peers: PeerConfig[]): Destination {
  if (to === 'cold') return {toColdStorage: true, toPeers: []};
  const peer = peers.find((p) => peerSlug(p) === to);
  if (!peer) {
    throw new CliError(
      `Unknown destination '${to}'. Try cold, or a peer slug: ` +
        `${peers.map(peerSlug).join(', ')}`,
    );
  }
  return {toColdStorage: false, toPeers: [peer.address]};
}

function renderPlan(
  model: string,
  files: SourceFile[],
  total: number,
  to: string,
  deleteAfter: boolean,
): string {
  const columns: Column<SourceFile>[] = [
    {header: 'FILE', value: (f) => f.path},
    {header: 'FROM', value: (f) => f.from},
    {header: 'SIZE', value: (f) => formatSize(f.size), align: 'right'},
  ];
  return [
    `Would copy ${files.length} file(s) of ${model} to ${to}:`,
    '',
    renderTable(columns, files),
    '',
    `total ${formatSize(total)}${deleteAfter ? ' · sources removed after copying' : ''}`,
  ].join('\n');
}
