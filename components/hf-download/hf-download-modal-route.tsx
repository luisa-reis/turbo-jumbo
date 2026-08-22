import {modelPeers} from '@/lib/config';
import {HfDownloadModal} from '@/components/hf-download/hf-download-modal';

// Server side of the HF download modal. Unlike Lemonade it needs no
// filesystem scans — only config. Shared by the intercepted (soft-nav) pages
// in the @modal slot and the real (hard-nav) pages.
export function HfDownloadModalRoute({location}: {location: string}) {
  return (
    <HfDownloadModal
      activeLocation={location}
      hfTokenSet={!!process.env.HF_TOKEN}
      peerConfigs={modelPeers}
    />
  );
}
