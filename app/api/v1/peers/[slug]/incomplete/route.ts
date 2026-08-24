import {localModelsSite} from '@/lib/storage/storage-instance';
import {config, localPeer, lemonadeDir} from '@/lib/config';
import {peerSlug} from '@/lib/peers/peer-slug';
import {logger} from '@/lib/util/logger';
import {findIncompleteRepos} from '@/lib/audit/incomplete-models';
import {storageForPeer} from '@/lib/storage/peer-storage';

// Repo ids with an incomplete local copy on the given peer. The local peer is
// computed directly; a remote peer is proxied to its own endpoint (peers run
// the same code), mirroring the models route.
export async function GET(
  _req: Request,
  {params}: {params: Promise<{slug: string}>},
) {
  const {slug} = await params;
  const peer = config.peers.find((p) => peerSlug(p) === slug);
  if (!peer) return new Response('Unknown peer', {status: 404});

  if (peer === localPeer) {
    if (!localModelsSite) return Response.json({incomplete: []});
    const incomplete = await findIncompleteRepos(localModelsSite, lemonadeDir);
    return Response.json({incomplete});
  }

  if (peer.agent_address) {
    // Agent-only peer: the presence checks run here, over its storage; the
    // Hugging Face reads were always the host's own.
    try {
      const incomplete = await findIncompleteRepos({
        storage: storageForPeer(peer.address),
        root: 'models',
      });
      return Response.json({incomplete});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[peers] agent incomplete for ${peer.name} failed: ${msg}`);
      return new Response(msg, {status: 502});
    }
  }

  try {
    const res = await fetch(
      `http://${peer.address}/api/v1/local-models/incomplete`,
    );
    if (!res.ok)
      return new Response(`Peer returned ${res.status}`, {status: 502});
    return Response.json(await res.json());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[peers] failed to fetch incomplete from ${peer.name}: ${msg}`);
    return new Response(msg, {status: 502});
  }
}
