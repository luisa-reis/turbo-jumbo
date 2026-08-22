import type {Metadata} from 'next';
import {notFound} from 'next/navigation';
import {localModelsPeer, localPeer} from '@/lib/config';
import {ALL_LOCATION} from '@/lib/storage/locations';
import {HomeView} from '@/components/home/home-view';
import {HfDownloadModalRoute} from '@/components/hf-download/hf-download-modal-route';

export function generateMetadata(): Metadata {
  return {title: localPeer ? `Turbo Jumbo - ${localPeer.name}` : 'Turbo Jumbo'};
}

// Hard navigation (refresh/deep link) to /download/hf: render the All table
// with the download modal already open. Soft navigation from within the app
// is intercepted into the @modal slot instead and never reaches this page.
// All's downloads land on this machine, so a viewer has no such page.
export const dynamic = 'force-dynamic';

export default function HfDownloadPage() {
  if (!localModelsPeer) notFound();
  return (
    <>
      <HomeView location={ALL_LOCATION} />
      <HfDownloadModalRoute location={ALL_LOCATION} />
    </>
  );
}
