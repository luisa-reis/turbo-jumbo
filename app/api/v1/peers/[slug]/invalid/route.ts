import {localModelsSite} from '@/lib/storage/storage-instance';
import {config, localPeer, lemonadeDir} from '@/lib/config';
import {peerSlug} from '@/lib/peers/peer-slug';
import {logger} from '@/lib/util/logger';
import {findReposWithInvalidFiles} from '@/lib/audit/incomplete-models';
import {storageForPeer} from '@/lib/storage/peer-storage';

// Repo ids with at least one invalid local file on the given peer. The local
// peer is computed directly; a remote peer is proxied to its own endpoint (peers
// run the same code), mirroring the models and incomplete routes.
export async function GET(
  _req: Request,
  {params}: {params: Promise<{slug: string}>},
) {
  const {slug} = await params;
  const peer = config.peers.find((p) => peerSlug(p) === slug);
  if (!peer) return new Response('Unknown peer', {status: 404});

  if (peer === localPeer) {
    if (!localModelsSite) return Response.json({invalid: []});
    const invalid = await findReposWithInvalidFiles(
      localModelsSite,
      lemonadeDir,
    );
    return Response.json({invalid});
  }

  if (peer.agent_address) {
    try {
      const invalid = await findReposWithInvalidFiles({
        storage: storageForPeer(peer.address),
        root: 'models',
      });
      return Response.json({invalid});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[peers] agent invalid for ${peer.name} failed: ${msg}`);
      return new Response(msg, {status: 502});
    }
  }

  try {
    const res = await fetch(
      `http://${peer.address}/api/v1/local-models/invalid`,
    );
    if (!res.ok)
      return new Response(`Peer returned ${res.status}`, {status: 502});
    return Response.json(await res.json());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[peers] failed to fetch invalid from ${peer.name}: ${msg}`);
    return new Response(msg, {status: 502});
  }
}
