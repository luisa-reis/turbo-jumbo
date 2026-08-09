import {CliError, UsageError, type Client} from '@/cli/client';
import type {CommandOutput} from '@/cli/output';
import {runTransfer, summarise} from '@/cli/transfer';
import type {CliInvocation} from '@/lib/cli/args';
import {renderTable, type Column} from '@/lib/cli/format';
import {parseHfUrl} from '@/lib/hf/hf-url';
import {defaultDownloadSelection, repoDownloadKind} from '@/lib/hf/hf-download';
import {quantGroups, type QuantGroup} from '@/lib/hf/quant-groups';
import {formatSize} from '@/lib/format/bytes';

type HfFile = {path: string; size: number};

export interface TransferContext {
  isTty: boolean;
  /** Live progress is for humans; json and quiet runs stay silent. */
  showProgress: boolean;
  write: (s: string) => void;
}

/**
 * `tj get` — download from Hugging Face through `/api/v1/hf-download`.
 *
 * Selection mirrors the download picker because it reuses the picker's own
 * functions: `parseHfUrl` for the reference, `/api/v1/hf-files` for the listing,
 * `repoDownloadKind` for the repo's shape and `quantGroups` for its
 * quantizations. What the CLI offers and what the modal offers cannot drift.
 *
 * Downloads run on the server the CLI is pointed at. To fetch onto another
 * machine, point at it: `tj --url http://<peer>:3000 get …`.
 */
export async function get(
  client: Client,
  inv: CliInvocation,
  ctx: TransferContext,
): Promise<CommandOutput> {
  const ref = inv.positionals[0];
  if (!ref) throw new UsageError('Usage: tj get <repo|url> [--quant <label>]');

  const parsed = parseHfUrl(ref);
  if (!parsed) {
    throw new CliError(
      `'${ref}' is not a Hugging Face reference. Try org/repo, or a repo, folder or file URL.`,
    );
  }

  const params = new URLSearchParams({
    repoId: parsed.repoId,
    branch: parsed.branch,
  });
  if (parsed.folder) params.set('folder', parsed.folder);
  const files = await client.json<HfFile[]>(`/api/v1/hf-files?${params}`);
  if (files.length === 0) {
    throw new CliError(`${parsed.repoId} has no downloadable files.`);
  }

  const groups = quantGroups(files);
  const selection = selectFiles(inv, parsed, files, groups);

  // Nothing named, and the repo is a menu of alternatives: print the menu.
  // Guessing which quantization someone wanted is worse than asking again.
  if (selection === 'menu') return listQuantizations(parsed.repoId, groups);

  const chosen = files.filter((f) => selection.has(f.path));
  const total = chosen.reduce((s, f) => s + f.size, 0);

  if (inv.deleteAfter && inv.to !== 'cold') {
    throw new CliError(
      '--delete-after only makes sense with --to cold: it removes the local copy after archiving it.',
    );
  }

  // `--exact` records the files it names as the model's whole set, so it needs
  // them named. A quantization is already a complete unit, and a bare repo is
  // the whole repo — neither leaves anything for a scope to say.
  if (inv.exact && inv.file.length === 0) {
    throw new CliError(
      '--exact needs --file: it records the files you name as the model’s complete set.',
    );
  }

  // The named files ARE the model: completeness checks judge it against them
  // rather than the repo, so the repo's other files aren't counted as missing.
  const fileScope = inv.exact ? chosen.map((f) => f.path) : undefined;

  const plan = {
    repo: parsed.repoId,
    revision: parsed.branch,
    files: chosen.map((f) => ({path: f.path, size: f.size})),
    totalBytes: total,
    ...(fileScope ? {fileScope} : {}),
    toColdStorage: inv.to === 'cold',
    deleteAfterTransfer: inv.deleteAfter,
  };

  if (inv.dryRun) {
    return {
      json: {dryRun: true, ...plan},
      table: renderPlan(parsed.repoId, chosen, total, inv),
      quiet: chosen.map((f) => f.path),
    };
  }

  const result = await runTransfer({
    client,
    path: '/api/v1/hf-download',
    body: {
      repoId: parsed.repoId,
      branch: parsed.branch,
      filePaths: chosen.map((f) => f.path),
      ...(fileScope ? {fileScope} : {}),
      sendToCold: inv.to === 'cold',
      deleteAfterTransfer: inv.deleteAfter,
    },
    format: 'text',
    expectedFiles: chosen.length,
    showProgress: ctx.showProgress,
    isTty: ctx.isTty,
    write: ctx.write,
  });

  if (result.errors.length > 0) {
    throw new CliError(
      `Download failed:\n${result.errors.map((e) => `  ${e}`).join('\n')}`,
    );
  }

  return {
    json: {...plan, elapsedMs: result.elapsedMs},
    table: summarise('downloaded', result),
    quiet: [],
  };
}

/**
 * The files a run should fetch, or `'menu'` when the request names nothing and
 * the repo is a set of alternatives to choose between.
 */
function selectFiles(
  inv: CliInvocation,
  parsed: ReturnType<typeof parseHfUrl> & object,
  files: HfFile[],
  groups: QuantGroup[],
): Set<string> | 'menu' {
  if (inv.file.length > 0) {
    const known = new Set(files.map((f) => f.path));
    const missing = inv.file.filter((f) => !known.has(f));
    if (missing.length > 0) {
      throw new CliError(
        `Not in ${parsed.repoId}: ${missing.join(', ')}.\n` +
          `Run 'tj get ${parsed.repoId}' to see what it holds.`,
      );
    }
    return new Set(inv.file);
  }

  if (inv.quant.length > 0) {
    const wanted = new Set(inv.quant.map((q) => q.toLowerCase()));
    const hits = groups.filter((g) => wanted.has(g.label.toLowerCase()));
    if (hits.length === 0) {
      throw new CliError(
        `No quantization matches ${inv.quant.join(', ')}.\n` +
          `Available: ${groups.map((g) => g.label).join(', ')}`,
      );
    }
    return new Set(hits.flatMap((g) => g.paths));
  }

  // A folder or file URL is already a choice; a whole-repo model has no
  // alternatives to choose between. Both resolve without asking.
  const byDefault = defaultDownloadSelection(
    files,
    parsed.filename,
    parsed.folder,
  );
  if (byDefault.size > 0) return byDefault;

  return repoDownloadKind(files.map((f) => f.path)) === 'pick-one'
    ? 'menu'
    : new Set(files.map((f) => f.path));
}

function listQuantizations(
  repoId: string,
  groups: QuantGroup[],
): CommandOutput {
  const columns: Column<QuantGroup>[] = [
    {header: 'QUANT', value: (g) => g.label},
    {header: 'FILES', value: (g) => String(g.fileCount), align: 'right'},
    {header: 'SIZE', value: (g) => formatSize(g.size), align: 'right'},
    {header: 'FOLDER', value: (g) => g.folder ?? ''},
  ];
  return {
    json: groups,
    table:
      `${repoId} offers these quantizations. Choose one with --quant:\n\n` +
      renderTable(columns, groups),
    quiet: groups.map((g) => g.label),
  };
}

function renderPlan(
  repoId: string,
  chosen: HfFile[],
  total: number,
  inv: CliInvocation,
): string {
  const columns: Column<HfFile>[] = [
    {header: 'FILE', value: (f) => f.path},
    {header: 'SIZE', value: (f) => formatSize(f.size), align: 'right'},
  ];
  const dest = inv.to === 'cold' ? 'local storage, then cold' : 'local storage';
  return [
    `Would download ${chosen.length} file(s) from ${repoId} to ${dest}:`,
    '',
    renderTable(columns, chosen),
    '',
    `total ${formatSize(total)}${inv.deleteAfter ? ' · local copy removed after archiving' : ''}`,
    ...(inv.exact
      ? ['', 'These files would be recorded as the model’s complete set.']
      : []),
  ].join('\n');
}
