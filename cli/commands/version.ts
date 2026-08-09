import type {Client} from '@/cli/client';
import type {CommandOutput} from '@/cli/output';
import {renderTable, type Column} from '@/lib/cli/format';

interface VersionRow {
  component: string;
  version: string;
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

  const rows: VersionRow[] = [
    {component: 'server', version: `${v.version}${v.dev ? ' (dev)' : ''}`},
    ...(v.commit ? [{component: 'commit', version: v.commit}] : []),
    {component: 'url', version: client.baseUrl},
  ];

  const columns: Column<VersionRow>[] = [
    {header: 'COMPONENT', value: (r) => r.component},
    {header: 'VERSION', value: (r) => r.version},
  ];

  return {
    json: {...v, url: client.baseUrl},
    table: renderTable(columns, rows, color),
    lines: [v.version],
  };
}
