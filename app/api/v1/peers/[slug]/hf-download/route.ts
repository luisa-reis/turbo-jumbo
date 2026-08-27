import {config, localPeer} from '@/lib/config';
import {peerSlug} from '@/lib/peers/peer-slug';
import {logger} from '@/lib/util/logger';
import {isObject, readJsonBody} from '@/lib/util/request';
import {streamHfDownload} from '@/lib/hf/hf-download-stream';
import {isUnconfiguredRoot, storageForPeer} from '@/lib/storage/peer-storage';

// Run an HF download on a specific peer. The local peer runs it directly via
// the shared streamer; a remote peer runs it on itself — we forward the request
// to its own /api/v1/hf-download and pipe the streamed output straight back.
export async function POST(
  req: Request,
  {params}: {params: Promise<{slug: string}>},
) {
  const {slug} = await params;
  const peer = config.peers.find((p) => peerSlug(p) === slug);
  if (!peer) return new Response('Unknown peer', {status: 404});

  const body = await readJsonBody<Record<string, unknown>>(req, isObject);
  if (body instanceof Response) return body;

  if (peer === localPeer) {
    logger.debug(`[peers] hf-download on ${peer.name} (local)`);
    return streamHfDownload(body, req.signal);
  }

  if (peer.agent_address) {
    // Agent-only peer: the same streamer, aimed at the agent's storage. The
    // download job spawns hf on the agent's machine; the progress poll, the
    // sidecar pass and the optional cold transfer all follow through the
    // same storage. Which roots the agent has is probed, as everywhere.
    logger.debug(`[peers] hf-download on ${peer.name} (agent)`);
    const agent = storageForPeer(peer.address);
    const probe = async (root: 'models' | 'cold') => {
      try {
        await agent.usage(root);
        return true;
      } catch (e) {
        if (isUnconfiguredRoot(e)) return false;
        throw e;
      }
    };
    try {
      const [hasModels, hasCold] = await Promise.all([
        probe('models'),
        probe('cold'),
      ]);
      return streamHfDownload(body, req.signal, {
        storage: agent,
        local: {storage: agent, root: 'models'},
        cold: {storage: agent, root: 'cold'},
        hasModels,
        hasCold,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[peers] agent hf-download on ${peer.name} failed: ${msg}`);
      return new Response(msg, {status: 502});
    }
  }

  logger.debug(`[peers] hf-download on ${peer.name} (${peer.address})`);
  try {
    const res = await fetch(`http://${peer.address}/api/v1/hf-download`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      // `proxied`: our UI's HF_TOKEN banner reflects our environment, not this
      // peer's, so have the peer self-report a missing token into the stream.
      body: JSON.stringify({...body, proxied: true}),
      signal: req.signal,
    });
    if (!res.ok || !res.body)
      return new Response(`Peer returned ${res.status}`, {status: 502});
    return new Response(res.body, {
      headers: {'Content-Type': 'text/plain; charset=utf-8'},
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[peers] hf-download to ${peer.name} failed: ${msg}`);
    return new Response(msg, {status: 502});
  }
}
