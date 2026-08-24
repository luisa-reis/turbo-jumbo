import {coldStorageSite} from '@/lib/storage/storage-instance';
import {config, localPeer, coldStorageDir} from '@/lib/config';
import {peerSlug} from '@/lib/peers/peer-slug';
import {logger} from '@/lib/util/logger';
import {scanModels} from '@/lib/models/models';
import {isUnconfiguredRoot, storageForPeer} from '@/lib/storage/peer-storage';

// Proxy a peer's cold storage through the local server: scan locally for the
// local peer, or forward to the named remote peer. The download picker uses
// this to mark files the target machine has already archived, which it can only
// do same-origin — and which must answer for the machine being downloaded to,
// not whichever one happens to be serving the UI.
export async function GET(
  _req: Request,
  {params}: {params: Promise<{slug: string}>},
) {
  const {slug} = await params;

  const peer = config.peers.find((p) => peerSlug(p) === slug);
  if (!peer) return new Response('Unknown peer', {status: 404});

  if (peer === localPeer) {
    logger.debug(`[peers] fetch cold storage from ${peer.name} (local)`);
    if (!coldStorageDir) return new Response('No cold storage', {status: 400});
    return Response.json(await scanModels(coldStorageSite));
  }

  if (peer.agent_address) {
    logger.debug(`[peers] scan cold storage from ${peer.name} (agent)`);
    try {
      const models = await scanModels({
        storage: storageForPeer(peer.address),
        root: 'cold',
      });
      return Response.json(models);
    } catch (e) {
      if (isUnconfiguredRoot(e))
        return new Response('No cold storage', {status: 400});
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[peers] agent cold scan for ${peer.name} failed: ${msg}`);
      return new Response(msg, {status: 502});
    }
  }

  logger.debug(
    `[peers] fetch cold storage from ${peer.name} (${peer.address})`,
  );
  try {
    const res = await fetch(`http://${peer.address}/api/v1/cold-storage`);
    if (!res.ok)
      return new Response(`Peer returned ${res.status}`, {status: 502});
    const models = await res.json();
    logger.debug(`[peers] ${peer.name} returned ${models.length} model(s)`);
    return Response.json(models);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(
      `[peers] failed to fetch cold storage from ${peer.name}: ${msg}`,
    );
    return new Response(msg, {status: 502});
  }
}
