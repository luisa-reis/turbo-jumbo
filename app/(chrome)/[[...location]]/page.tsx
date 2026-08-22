import type {Metadata} from 'next';
import {notFound} from 'next/navigation';
import {hasColdStorage, modelPeers, localPeer} from '@/lib/config';
import {COLD_STORAGE_LOCATION, parseRoute} from '@/lib/storage/locations';
import {HomeView} from '@/components/home/home-view';

export function generateMetadata(): Metadata {
  return {title: localPeer ? `Turbo Jumbo - ${localPeer.name}` : 'Turbo Jumbo'};
}

// Reads the live filesystem (local + cold storage), so render per-request
// rather than prerendering at build time.
export const dynamic = 'force-dynamic';

export default async function Home({
  params,
}: {
  params: Promise<{location?: string[]}>;
}) {
  const {location} = await params;
  const route = parseRoute(location, modelPeers);
  if (route === null) notFound();
  // No archive, no Cold Storage tab — nor its page.
  if (route.location === COLD_STORAGE_LOCATION && !hasColdStorage) notFound();
  // Both download views live on explicit /download/* routes (with @modal
  // interceptors), so this page only ever renders the table. parseRoute
  // stays for validation and for AppChrome's active-location parsing.
  return <HomeView location={route.location} />;
}
