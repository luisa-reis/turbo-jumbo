import {coldStorageSite, localModelsSite} from '@/lib/storage/storage-instance';
import {
  lemonadeDir,
  hasColdStorage,
  localModelsPeer,
  modelPeers,
} from '@/lib/config';
import {scanModels} from '@/lib/models/models';
import {getModelsTableData} from '@/components/models/models-table';
import {HomeClient} from '@/components/home/home-client';

// Server-rendered models table for one location tab. Shared by the catch-all
// page and the hard-navigation Lemonade pages (which render it under the
// already-open download modal).
export async function HomeView({location}: {location: string}) {
  const coldModels = await scanModels(coldStorageSite);
  const localModels = await scanModels(localModelsSite, lemonadeDir);
  const modelsTableData = getModelsTableData(localModels, coldModels);
  return (
    <HomeClient
      activeLocation={location}
      coldModels={coldModels}
      hasColdStorage={hasColdStorage}
      hfTokenSet={!!process.env.HF_TOKEN}
      modelsTableData={modelsTableData}
      peerConfigs={modelPeers}
      localPeerAddress={localModelsPeer?.address ?? null}
      localPeerModels={localModels}
    />
  );
}
