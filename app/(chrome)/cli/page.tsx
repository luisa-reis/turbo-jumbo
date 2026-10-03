import type {Metadata} from 'next';
import {headers} from 'next/headers';
import {servedBinaries} from '@/lib/cli/served-binaries';
import {CliInstall} from '@/components/cli/cli-install';

export function generateMetadata(): Metadata {
  return {title: 'Turbo Jumbo - Command-line tool'};
}

// Lists the binaries on disk now, and names this server by the address the
// request came in on — both per request.
export const dynamic = 'force-dynamic';

// A static segment, so it wins over the [[...location]] catch-all: a peer
// whose slug is "cli" would lose its tab URL to this page.
export default async function CliPage() {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? 'http';
  return (
    <CliInstall
      origin={`${proto}://${host}`}
      binaries={await servedBinaries()}
    />
  );
}
