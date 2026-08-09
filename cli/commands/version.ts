import type {Client} from '@/cli/client';
import type {CommandOutput} from '@/cli/output';
import {renderTable, type Column} from '@/lib/cli/format';
import {appVersion} from '@/lib/version/app-version';

interface VersionRow {
  component: string;
  version: string;
}

/**
 * `tj --version` — this CLI's own version, not the server's.
 *
 * Answered without reaching for the server, because "which tj is this?" is a
 * question you most want answered when the server is exactly what isn't
 * working. Build detail rides the verbosity dial rather than a second flag:
 * `tj --version -v`.
 */
export function cliVersion(verbose: boolean): string {
  const v = appVersion();
  const head = `tj ${v.version}${v.dev ? ' (dev)' : ''}`;
  if (!verbose) return head;
  // process.versions rather than the Bun global: the repo carries no Bun type
  // definitions, and this is the same number.
  const runtime = (process.versions as Record<string, string | undefined>).bun;
  const detail: [string, string][] = [
    ...(v.commit ? ([['commit', v.commit]] as [string, string][]) : []),
    ...(runtime ? ([['bun', runtime]] as [string, string][]) : []),
    ['platform', `${process.platform}-${process.arch}`],
  ];
  return [head, ...detail.map(([k, s]) => `  ${k.padEnd(9)}${s}`)].join('\n');
}

/**
 * `tj version` — the server's version identity, and where the CLI is pointed.
 *
 * The URL is part of the answer: the commonest confusion with a client tool is
 * being connected to a different machine than you assumed.
 */
export async function version(
  client: Client,
  color: boolean,
): Promise<CommandOutput> {
  const v = await client.json<{
    version: string;
    dev?: boolean;
    commit?: string;
  }>('/api/v1/version');

  const cli = appVersion();
  const rows: VersionRow[] = [
    {component: 'server', version: `${v.version}${v.dev ? ' (dev)' : ''}`},
    ...(v.commit ? [{component: 'commit', version: v.commit}] : []),
    // Both, labelled: a client and a server on different versions is exactly
    // the situation where you need to see the two side by side.
    {component: 'cli', version: `${cli.version}${cli.dev ? ' (dev)' : ''}`},
    {component: 'url', version: client.baseUrl},
  ];

  const columns: Column<VersionRow>[] = [
    {header: 'COMPONENT', value: (r) => r.component},
    {header: 'VERSION', value: (r) => r.version},
  ];

  return {
    json: {
      ...v,
      cli: {version: cli.version, dev: cli.dev},
      url: client.baseUrl,
    },
    table: renderTable(columns, rows, color),
    lines: [v.version],
  };
}
