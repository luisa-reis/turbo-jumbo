import {CliError, type Client} from '@/cli/client';
import type {CommandOutput} from '@/cli/output';
import {
  deletePath,
  describeLocation,
  modelsPath,
  resolveLocationName,
} from '@/cli/location';
import type {CliInvocation} from '@/lib/cli/args';
import {renderTable, type Column} from '@/lib/cli/format';
import {auditTargets, type AuditTarget} from '@/lib/cli/audit-plan';
import {formatSize} from '@/lib/format/bytes';
import type {Model} from '@/lib/models/model-types';

/**
 * `tj rm` — delete a model's files from one storage tier.
 *
 * The only irreversible command here, so both halves of the intent have to be
 * typed: `--from`, because a defaulted tier is exactly how someone removes the
 * archived copy while meaning the local one, and `--yes`, matching the `hf`
 * CLI's convention for destructive commands. `--dry-run` lists what would go.
 *
 * An ambiguous model pattern is refused rather than resolved — deleting the
 * wrong hundred gigabytes is not something to guess at.
 */
export async function rm(
  client: Client,
  inv: CliInvocation,
): Promise<CommandOutput> {
  const pattern = inv.positionals[0];
  if (!pattern) throw new CliError('Usage: tj rm <model> --from <where> --yes');
  if (!inv.from) {
    throw new CliError(
      'tj rm needs --from local|cold|<peer>: which copy should go?\n' +
        'Try --dry-run first to see what would be deleted.',
    );
  }
  if (!inv.yes && !inv.dryRun) {
    throw new CliError(
      'tj rm needs --yes to confirm, since it deletes files.\n' +
        'Try --dry-run first to see what would go.',
    );
  }

  const location = await resolveLocationName(client, inv.from);
  const models = await client.json<Model[]>(modelsPath(location));

  const names = [
    ...new Set(
      models
        .filter((m) => m.name.toLowerCase().includes(pattern.toLowerCase()))
        .map((m) => m.name),
    ),
  ];
  if (names.length === 0) {
    throw new CliError(
      `No model matches '${pattern}' on ${describeLocation(location)}.`,
    );
  }
  if (names.length > 1) {
    throw new CliError(
      `'${pattern}' matches ${names.length} models. Narrow it:\n` +
        names.map((n) => `  ${n}`).join('\n'),
    );
  }

  const targets = filterQuants(auditTargets(models, pattern), inv.quant);
  if (targets.length === 0) {
    throw new CliError(
      `${names[0]} has no files matching ${inv.quant.join(', ')} on ` +
        `${describeLocation(location)}.`,
    );
  }
  const total = targets.reduce((s, t) => s + t.size, 0);

  const res = await fetch(`${client.baseUrl}${deletePath(location)}`, {
    method: 'DELETE',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      files: targets.map((t) => t.path),
      dryRun: inv.dryRun,
    }),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).trim();
    throw new CliError(
      `Delete failed: ${res.status} ${res.statusText}${body ? `: ${body}` : ''}`,
    );
  }

  const columns: Column<AuditTarget>[] = [
    {header: 'FILE', value: (t) => t.path},
    {header: 'SIZE', value: (t) => formatSize(t.size), align: 'right'},
  ];
  const where = describeLocation(location);
  return {
    json: {
      dryRun: inv.dryRun,
      model: names[0],
      from: where,
      files: targets,
      totalBytes: total,
    },
    table: inv.dryRun
      ? [
          `Would delete ${targets.length} file(s) of ${names[0]} from ${where}:`,
          '',
          renderTable(columns, targets),
          '',
          `total ${formatSize(total)}`,
        ].join('\n')
      : `deleted ${targets.length} file(s) of ${names[0]} from ${where} · ${formatSize(total)}`,
    quiet: targets.map((t) => t.path),
  };
}

/**
 * Narrow to the named quantizations. The tier's own model list has no quant
 * labels on it — those are derived in the models table — so the filter matches
 * the label against the filename, which is where the label came from.
 */
function filterQuants(targets: AuditTarget[], quants: string[]): AuditTarget[] {
  if (quants.length === 0) return targets;
  const wanted = quants.map((q) => q.toLowerCase());
  return targets.filter((t) => {
    const name = (t.path.split('/').pop() ?? '').toLowerCase();
    return wanted.some((q) => name.includes(q));
  });
}
