import {CliError, type Client} from '@/cli/client';
import type {CommandOutput} from '@/cli/output';
import type {TransferContext} from '@/cli/commands/get';
import {fetchPeers} from '@/cli/fetch-peers';
import {peerSlug} from '@/lib/peers/peer-slug';
import type {CliInvocation} from '@/lib/cli/args';
import {renderTable, type Column} from '@/lib/cli/format';
import {
  auditExitCode,
  auditTargets,
  createAuditAggregator,
  findings,
  fixable,
  unresolvedFindings,
  type AuditTarget,
} from '@/lib/cli/audit-plan';
import {
  createLineSplitter,
  createMilestoneEmitter,
  renderBar,
} from '@/lib/cli/progress';
import {formatSize} from '@/lib/format/bytes';
import type {AuditResult} from '@/lib/audit/audit';
import type {Model} from '@/lib/models/model-types';

/** Thrown when the audit ran fine but found something. Carries exit code 2. */
export class AuditFindings extends Error {
  constructor(readonly output: CommandOutput) {
    super('audit findings');
  }
}

/**
 * `tj audit` — verify files against Hugging Face and report what doesn't match.
 *
 * A fresh audit reads every selected byte to hash it, which is why a bare
 * `tj audit` with no model and no `--all` is refused: on an archive this is
 * hours of disk. `--cached` answers instantly from what the last real audit
 * recorded, at the cost of reporting history rather than truth.
 */
export async function audit(
  client: Client,
  inv: CliInvocation,
  ctx: TransferContext,
): Promise<CommandOutput> {
  const pattern = inv.positionals[0];
  if (!pattern && !inv.all) {
    throw new CliError(
      'Name a model to audit, or pass --all.\n' +
        'A fresh audit reads every byte of every file it checks.',
    );
  }

  const location = await resolveLocation(client, inv);
  const models = await client.json<Model[]>(modelsPath(location));
  const targets = auditTargets(models, pattern);
  if (targets.length === 0) {
    throw new CliError(
      `Nothing to audit${pattern ? ` matching '${pattern}'` : ''} on ${describe(location)}.`,
    );
  }

  if (inv.dryRun) return dryRun(targets, location, inv.cached);

  const results = inv.cached
    ? await cachedResults(client, location, targets)
    : await freshAudit(client, location, targets, ctx);

  const found = findings(results);
  const fixes = inv.fix ? await applyFixes(client, location, results, inv) : [];
  // What is still wrong once the repairs have run. A run that fixed everything
  // it found is a clean machine, and `tj audit --fix || alert` should not page
  // anyone about a problem that no longer exists.
  const unresolved = unresolvedFindings(found, fixes);

  const output: CommandOutput = {
    json: {
      location: describe(location),
      checked: results.length,
      findings: found,
      unresolved,
      fixes,
    },
    table: renderResults(results, found, unresolved, fixes, inv),
    quiet: unresolved.map((r) => r.file),
  };

  // Findings are not a command failure, so they leave by their own door: the
  // entry point turns this into exit 2 while still printing the report.
  if (auditExitCode(unresolved) === 2) throw new AuditFindings(output);
  return output;
}

type Location =
  | {kind: 'local'}
  | {kind: 'cold'}
  | {kind: 'peer'; slug: string; address: string};

async function resolveLocation(
  client: Client,
  inv: CliInvocation,
): Promise<Location> {
  if (inv.cold) return {kind: 'cold'};
  if (!inv.peer) return {kind: 'local'};
  const peers = await fetchPeers(client);
  const peer = peers.find((p) => peerSlug(p) === inv.peer);
  if (!peer) {
    throw new CliError(
      `Unknown peer '${inv.peer}'. Try: ${peers.map(peerSlug).join(', ')}`,
    );
  }
  return {kind: 'peer', slug: inv.peer, address: peer.address};
}

// `/api/v1/audit` names a peer by address, not slug.
const locationParam = (l: Location) =>
  l.kind === 'cold' ? 'cold-storage' : l.kind === 'local' ? 'local' : l.address;

const modelsPath = (l: Location) =>
  l.kind === 'cold'
    ? '/api/v1/cold-storage'
    : l.kind === 'local'
      ? '/api/v1/local-models'
      : `/api/v1/peers/${l.slug}/models`;

const describe = (l: Location) =>
  l.kind === 'cold' ? 'cold storage' : l.kind === 'local' ? 'local' : l.slug;

/** Stream `/api/v1/audit`, rendering progress as the hashes come in. */
async function freshAudit(
  client: Client,
  location: Location,
  targets: AuditTarget[],
  ctx: TransferContext,
): Promise<AuditResult[]> {
  const agg = createAuditAggregator(targets);
  const started = Date.now();

  const res = await fetch(`${client.baseUrl}/api/v1/audit`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      location: locationParam(location),
      files: targets.map((t) => t.path),
    }),
  });
  if (!res.ok || !res.body) {
    throw new CliError(
      `/api/v1/audit returned ${res.status} ${res.statusText}`,
    );
  }

  const splitter = createLineSplitter();
  const milestone = createMilestoneEmitter();
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let barDrawn = false;

  const showLine = () => {
    if (!ctx.showProgress) return;
    const p = agg.progress();
    if (ctx.isTty) {
      ctx.write(`\r${renderBar(p, Date.now() - started)}`);
      barDrawn = true;
    } else {
      const line = milestone(p);
      if (line) ctx.write(`${line}\n`);
    }
  };

  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    for (const line of splitter.push(decoder.decode(value, {stream: true}))) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        agg.push(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        continue; // a frame we don't understand is not a reason to stop
      }
      showLine();
    }
  }
  if (barDrawn) ctx.write('\n');
  return agg.results();
}

async function cachedResults(
  client: Client,
  location: Location,
  targets: AuditTarget[],
): Promise<AuditResult[]> {
  const res = await fetch(`${client.baseUrl}/api/v1/audit/cached`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({location: locationParam(location)}),
  });
  if (!res.ok) {
    throw new CliError(
      `/api/v1/audit/cached returned ${res.status} ${res.statusText}`,
    );
  }
  const {results} = (await res.json()) as {results: AuditResult[]};
  // The cached endpoint answers for a whole location; narrow it to the ask.
  const wanted = new Set(targets.map((t) => t.path));
  return results.filter((r) => wanted.has(r.file));
}

interface FixOutcome {
  file: string;
  status: string;
  to?: string;
  message?: string;
}

/**
 * Apply the repairs `--fix` covers. Relocating a misplaced file loses nothing,
 * so it needs no extra permission. Resolving duplicates *deletes* copies, so it
 * happens only when `--allow-delete` is typed — nothing here prompts, and a
 * general-purpose flag must not quietly remove files.
 */
async function applyFixes(
  client: Client,
  location: Location,
  results: AuditResult[],
  inv: CliInvocation,
): Promise<FixOutcome[]> {
  const {misplaced, duplicate} = fixable(results);
  const out: FixOutcome[] = [];
  const post = async (path: string, files: string[]) => {
    const res = await fetch(`${client.baseUrl}${path}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({location: locationParam(location), files}),
    });
    if (!res.ok) {
      throw new CliError(`${path} returned ${res.status} ${res.statusText}`);
    }
    const {results: fixed} = (await res.json()) as {results: FixOutcome[]};
    out.push(...fixed);
  };

  if (misplaced.length > 0) await post('/api/v1/audit/fix', misplaced);
  if (duplicate.length > 0 && inv.allowDelete)
    await post('/api/v1/audit/fix-duplicate', duplicate);
  return out;
}

function dryRun(
  targets: AuditTarget[],
  location: Location,
  cached: boolean,
): CommandOutput {
  const total = targets.reduce((s, t) => s + t.size, 0);
  const columns: Column<AuditTarget>[] = [
    {header: 'FILE', value: (t) => t.path},
    {header: 'SIZE', value: (t) => formatSize(t.size), align: 'right'},
  ];
  return {
    json: {dryRun: true, location: describe(location), targets, total},
    table: [
      `Would ${cached ? 'report cached verdicts for' : 'hash'} ` +
        `${targets.length} file(s) on ${describe(location)}:`,
      '',
      renderTable(columns, targets),
      '',
      `total ${formatSize(total)}`,
    ].join('\n'),
    quiet: targets.map((t) => t.path),
  };
}

function renderResults(
  results: AuditResult[],
  found: AuditResult[],
  unresolved: AuditResult[],
  fixes: FixOutcome[],
  inv: CliInvocation,
): string {
  const fixByFile = new Map(fixes.map((f) => [f.file, f]));
  const rows = found.length > 0 ? found : [];
  const columns: Column<AuditResult>[] = [
    {header: 'FILE', value: (r) => r.file},
    {header: 'STATUS', value: (r) => r.status},
    {
      header: 'ACTION',
      value: (r) => {
        const f = fixByFile.get(r.file);
        if (!f) return inv.fix ? 'not fixed' : '';
        return f.status === 'moved' && f.to ? `moved to ${f.to}` : f.status;
      },
    },
    {header: 'DETAIL', value: (r) => r.message ?? ''},
  ];

  const lines: string[] = [];
  if (rows.length > 0) lines.push(renderTable(columns, rows), '');

  const fixed = found.length - unresolved.length;
  const summary =
    `${results.length} file(s) checked · ${found.length} finding(s)` +
    (inv.fix ? ` · ${fixed} fixed · ${unresolved.length} remaining` : '');
  lines.push(summary);

  // Say what could have been repaired but wasn't, and exactly how to do it.
  const {duplicate, unfixable} = fixable(found);
  if (duplicate.length > 0 && !inv.allowDelete) {
    lines.push(
      `\n${duplicate.length} duplicate(s) left alone: resolving them deletes copies.`,
      `Re-run with --fix --allow-delete to keep one verified copy of each.`,
    );
  }
  if (unfixable.length > 0 && inv.fix) {
    lines.push(
      `\n${unfixable.length} finding(s) have no automatic repair; audit them in the web UI.`,
    );
  }
  return lines.join('\n');
}
