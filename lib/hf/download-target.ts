import {ALL_LOCATION} from '@/lib/storage/locations';
import {peerSlug} from '@/lib/peers/peer-slug';
import type {Peer} from '@/lib/config';

export interface DownloadTarget {
  url: string;
  // The machine the download runs on, as `tj --url` takes it, when that isn't
  // the one serving this UI. Absent for a local download, which is what `tj get`
  // does by default. Feeds only the disclosed command.
  cliUrl?: string;
  // Endpoint reporting free/total disk bytes at the target, to warn before a
  // download that wouldn't fit.
  diskUsageUrl: string;
  // Endpoint listing the target machine's cold storage, to mark files it has
  // already archived. Must answer for the machine being downloaded to, not
  // whichever one is serving the UI.
  coldStorageUrl: string;
}

// Where a download initiated from `activeLocation` runs. The All tab and the
// local peer download on this machine; a remote peer downloads on itself via
// the peer proxy.
export function downloadTarget(
  activeLocation: string,
  peers: Peer[],
): DownloadTarget {
  const peer = peers.find((p) => p.address === activeLocation);
  if (activeLocation === ALL_LOCATION || !peer || peer.isLocal) {
    return {
      url: '/api/v1/hf-download',
      diskUsageUrl: '/api/v1/disk-usage',
      coldStorageUrl: '/api/v1/cold-storage',
    };
  }
  const slug = peerSlug(peer);
  return {
    url: `/api/v1/peers/${slug}/hf-download`,
    cliUrl: peer.address,
    diskUsageUrl: `/api/v1/peers/${slug}/disk-usage`,
    coldStorageUrl: `/api/v1/peers/${slug}/cold-storage`,
  };
}
