import {NextResponse} from 'next/server';
import {config, localPeer, type Peer} from '@/lib/config';
import {peerSlug} from '@/lib/peers/peer-slug';
import {logger} from '@/lib/util/logger';
import {
  previewSync,
  runSync,
  type SyncTarget,
} from '@/lib/lemonade/lemonade-sync-run';
import {isUnconfiguredRoot, storageForPeer} from '@/lib/storage/peer-storage';

/** An agent peer as a sync target: the moves and links run on the agent's
 *  disks, the catalog and registry reads stay the host's, and the peer's
 *  own Lemonade server (config's lemonade_url) gets the flm refresh. */
async function agentTarget(peer: Peer): Promise<SyncTarget> {
  const agent = storageForPeer(peer.address);
  const probe = async (root: 'models' | 'lemonade') => {
    try {
      await agent.usage(root);
      return true;
    } catch (e) {
      if (isUnconfiguredRoot(e)) return false;
      throw e;
    }
  };
  const [hasModels, hasLemonade] = await Promise.all([
    probe('models'),
    probe('lemonade'),
  ]);
  return {
    storage: agent,
    models: {storage: agent, root: 'models'},
    hasModels,
    hasLemonade,
    peer,
  };
}

// Consolidate Lemonade into Turbo Jumbo on a specific peer. The local peer runs
// it directly against its own config; a remote peer runs it on itself — we
// forward to its own /api/v1/lemonade/sync so the work uses that machine's
// stores. GET previews (read-only); POST executes.

export async function GET(
  _req: Request,
  {params}: {params: Promise<{slug: string}>},
) {
  const {slug} = await params;
  const peer = config.peers.find((p) => peerSlug(p) === slug);
  if (!peer) return new Response('Unknown peer', {status: 404});

  if (peer === localPeer) {
    logger.debug(`[peers] lemonade sync preview on ${peer.name} (local)`);
    return NextResponse.json(await previewSync());
  }

  if (peer.agent_address) {
    logger.debug(`[peers] lemonade sync preview on ${peer.name} (agent)`);
    try {
      return NextResponse.json(await previewSync(await agentTarget(peer)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[peers] agent sync preview on ${peer.name} failed: ${msg}`);
      return new Response(msg, {status: 502});
    }
  }

  logger.debug(
    `[peers] lemonade sync preview on ${peer.name} (${peer.address})`,
  );
  try {
    const res = await fetch(`http://${peer.address}/api/v1/lemonade/sync`);
    if (!res.ok)
      return new Response(`Peer returned ${res.status}`, {status: 502});
    return NextResponse.json(await res.json());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[peers] lemonade sync preview on ${peer.name} failed: ${msg}`);
    return new Response(msg, {status: 502});
  }
}

export async function POST(
  _req: Request,
  {params}: {params: Promise<{slug: string}>},
) {
  const {slug} = await params;
  const peer = config.peers.find((p) => peerSlug(p) === slug);
  if (!peer) return new Response('Unknown peer', {status: 404});

  if (peer === localPeer) {
    logger.debug(`[peers] lemonade sync on ${peer.name} (local)`);
    const out = await runSync();
    if (!out) return new Response('Lemonade is not configured', {status: 400});
    return NextResponse.json(out);
  }

  if (peer.agent_address) {
    logger.debug(`[peers] lemonade sync on ${peer.name} (agent)`);
    try {
      const out = await runSync(await agentTarget(peer));
      if (!out)
        return new Response('Lemonade is not configured', {status: 400});
      return NextResponse.json(out);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[peers] agent sync on ${peer.name} failed: ${msg}`);
      return new Response(msg, {status: 502});
    }
  }

  logger.debug(`[peers] lemonade sync on ${peer.name} (${peer.address})`);
  try {
    const res = await fetch(`http://${peer.address}/api/v1/lemonade/sync`, {
      method: 'POST',
    });
    if (!res.ok)
      return new Response(`Peer returned ${res.status}`, {status: 502});
    return NextResponse.json(await res.json());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[peers] lemonade sync on ${peer.name} failed: ${msg}`);
    return new Response(msg, {status: 502});
  }
}
