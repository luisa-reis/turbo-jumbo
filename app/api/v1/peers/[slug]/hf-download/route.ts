import {config, localPeer} from '@/lib/config';
import {peerSlug} from '@/lib/peers/peer-slug';
import {logger} from '@/lib/util/logger';
import {isObject, readJsonBody} from '@/lib/util/request';
import {streamHfDownload} from '@/lib/hf/hf-download-stream';
import {stat} from 'node:fs/promises';
import {
  isUnconfiguredRoot,
  mountStorageFor,
  storageForPeer,
} from '@/lib/storage/peer-storage';
import type {Storage} from '@/lib/storage/storage';

// Run an HF download on a specific peer. The local peer runs it directly via
// the shared streamer. A peer whose models root is mounted here (`models_mount`)
// runs it here too, writing into the mount; an agent peer runs it on the
// agent's machine; a full-app peer runs it on itself — we forward the request
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

  const mounted = mountStorageFor(peer);
  if (mounted) {
    // The peer's models root is mounted here: run `hf` on this machine and
    // write straight into the share — the progress poll, the sidecar pass and
    // the verification all read the same mount. Sending to cold storage
    // afterwards is still the peer's to do (see DownloadTarget.coldVia).
    logger.debug(
      `[peers] hf-download on ${peer.name} (via mount ${peer.models_mount})`,
    );
    if (!(await isDirectory(peer.models_mount!)))
      return new Response(
        `${peer.name}'s models mount (${peer.models_mount}) isn't available on this machine`,
        {status: 502},
      );
    const remote = storageForPeer(peer.address);
    // Unreachable, or without cold storage, the peer just can't take the cold
    // step: the download itself needs nothing from it.
    const hasCold = await hasRoot(remote, 'cold').catch(() => false);
    const coldVia = {
      storage: remote,
      local: {storage: remote, root: 'models' as const},
      cold: {storage: remote, root: 'cold' as const},
    };
    return streamHfDownload(body, req.signal, {
      storage: mounted,
      local: {storage: mounted, root: 'models'},
      cold: coldVia.cold,
      hasModels: true,
      hasCold,
      coldVia,
    });
  }

  if (peer.agent_address) {
    // Agent-only peer: the same streamer, aimed at the agent's storage. The
    // download job spawns hf on the agent's machine; the progress poll, the
    // sidecar pass and the optional cold transfer all follow through the
    // same storage. Which roots the agent has is probed, as everywhere.
    logger.debug(`[peers] hf-download on ${peer.name} (agent)`);
    const agent = storageForPeer(peer.address);
    try {
      const [hasModels, hasCold] = await Promise.all([
        hasRoot(agent, 'models'),
        hasRoot(agent, 'cold'),
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

/** Whether a storage has `root` at all — a root it was never configured with
 *  answers false; any other failure (unreachable, say) is thrown. */
async function hasRoot(s: Storage, root: 'models' | 'cold'): Promise<boolean> {
  try {
    await s.usage(root);
    return true;
  } catch (e) {
    if (isUnconfiguredRoot(e)) return false;
    throw e;
  }
}

/** Whether `dir` is a directory here. Reaching into it also triggers an
 *  automount, so an idle share is mounted before `hf` writes beneath it. */
async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
