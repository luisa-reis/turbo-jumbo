import {localModelsPeer} from '@/lib/config';
import {ALL_LOCATION} from '@/lib/storage/locations';
import {HfDownloadModalRoute} from '@/components/hf-download/hf-download-modal-route';

// Soft navigation to /download/hf: fill the @modal slot with the download
// modal over whatever page is currently rendered. A viewer has no All
// download (the app never links to it; a hard navigation 404s).
export const dynamic = 'force-dynamic';

export default function InterceptedHfPage() {
  if (!localModelsPeer) return null;
  return <HfDownloadModalRoute location={ALL_LOCATION} />;
}
