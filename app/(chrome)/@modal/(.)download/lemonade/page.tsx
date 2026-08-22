import {localModelsPeer} from '@/lib/config';
import {ALL_LOCATION} from '@/lib/storage/locations';
import {LemonadeModalRoute} from '@/components/lemonade/lemonade-modal-route';

// Soft navigation to /download/lemonade: fill the @modal slot with the
// download modal over whatever page is currently rendered. A viewer has no
// All download (the app never links to it; a hard navigation 404s).
export const dynamic = 'force-dynamic';

export default function InterceptedLemonadePage() {
  if (!localModelsPeer) return null;
  return <LemonadeModalRoute location={ALL_LOCATION} />;
}
