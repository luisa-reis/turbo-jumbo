import {coldStorageSite, localModelsSite} from '@/lib/storage/storage-instance';
import {
  lemonadeDir,
  lemonadeBuiltinDir,
  lemonadeExtraDir,
  hasColdStorage,
  localModelsPeer,
  modelPeers,
} from '@/lib/config';
import {scanModels} from '@/lib/models/models';
import {scanLemonadeCache} from '@/lib/lemonade/lemonade-cache-scan';
import {LemonadeModal} from '@/components/lemonade/lemonade-modal';

// Server side of the Lemonade download modal: scans the stores the modal
// needs and renders it. Shared by the intercepted (soft-nav) pages in the
// @modal slot and the real (hard-nav) pages, so the route files stay thin.
export async function LemonadeModalRoute({location}: {location: string}) {
  const coldModels = await scanModels(coldStorageSite);
  const localModels = await scanModels(localModelsSite, lemonadeDir);
  // Lemonade's own model cache lives outside the managed storage; scan both
  // halves so the Lemonade browser can flag catalog entries already present
  // there, whichever side they sit on.
  const lemonadeCacheModels =
    lemonadeBuiltinDir && lemonadeExtraDir
      ? await scanLemonadeCache({
          builtin: lemonadeBuiltinDir,
          extra: lemonadeExtraDir,
        })
      : [];
  return (
    <LemonadeModal
      activeLocation={location}
      coldModels={coldModels}
      hasColdStorage={hasColdStorage}
      hfTokenSet={!!process.env.HF_TOKEN}
      peerConfigs={modelPeers}
      localPeerAddress={localModelsPeer?.address ?? null}
      localPeerModels={localModels}
      lemonadeCacheModels={lemonadeCacheModels}
    />
  );
}
