import {config, localPeer, type Peer} from '@/lib/config';
import {scanModels, type Model} from '@/lib/models/models';
import {storageForPeer} from '@/lib/storage/peer-storage';
import {publishPeerEvent} from './peer-event-hub';
import {logger} from '@/lib/util/logger';

const peerStatus = new Map<string, 'up' | 'down'>();

/** How long a failed check waits before asking the peer once more. */
const RETRY_DELAY_MS = 2000;

/** Whether the peer answers: its agent's liveness, or its app's model list
 *  (returned, since the event carries it). Throws when it doesn't. */
async function probe(peer: Peer): Promise<Model[] | null> {
  if (peer.agent_address) {
    const res = await fetch(`http://${peer.agent_address}/`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return null;
  }
  const res = await fetch(`http://${peer.address}/api/v1/local-models`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Model[];
}

/** A failed check's reason, with the network error fetch wraps in `cause`
 *  (a reset, a refused connection, a failed lookup): "fetch failed" alone
 *  says nothing. */
function reason(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  if (!(e.cause instanceof Error)) return e.message;
  const code = (e.cause as Error & {code?: string}).code;
  return `${e.message}: ${e.cause.message}${code ? ` [${code}]` : ''}`;
}

async function checkPeer(peer: Peer): Promise<void> {
  const address = peer.address;
  try {
    let models: Model[] | null;
    try {
      models = await probe(peer);
    } catch (e) {
      // A peer that was up gets one more chance before it is reported down:
      // a single missed check (a stalled connection, a slow lookup) would
      // otherwise blank its tab in every open browser for a whole interval.
      if (peerStatus.get(address) !== 'up') throw e;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      models = await probe(peer);
      logger.info(`[monitor] peer ${address} answered on retry (${reason(e)})`);
    }
    // An agent answers liveness for almost nothing; the scan — a remote
    // walk — runs only on the transition to up, when the event needs it.
    if (peer.agent_address && peerStatus.get(address) !== 'up') {
      models = await scanModels({
        storage: storageForPeer(address),
        root: 'models',
      });
    }

    const prev = peerStatus.get(address);
    peerStatus.set(address, 'up');

    if (prev !== 'up') {
      logger.info(`[monitor] peer up: ${address}`);
      publishPeerEvent({type: 'peer-up', address, models: models ?? []});
    }
  } catch (e) {
    const prev = peerStatus.get(address);
    peerStatus.set(address, 'down');

    if (prev === 'up') {
      logger.info(`[monitor] peer down: ${address} (${reason(e)})`);
      publishPeerEvent({type: 'peer-down', address});
    }
  }
}

// Guard against a second monitor loop if instrumentation ever re-runs in the
// same process (e.g. across dev-server reloads).
const STARTED_KEY = Symbol.for('turbo-jumbo.peer-monitor-started');

// Poll each remote peer's /api/v1/local-models and publish peer-up/peer-down
// events (fanned out to browsers by /api/v1/events), so the UI tracks
// reachability live.
export function startPeerMonitor(): void {
  const remotePeers = config.peers.filter((p) => p !== localPeer);
  if (remotePeers.length === 0) return;

  const g = globalThis as {[STARTED_KEY]?: boolean};
  if (g[STARTED_KEY]) return;
  g[STARTED_KEY] = true;

  const poll = () => {
    for (const peer of remotePeers) void checkPeer(peer);
  };

  poll();
  setInterval(poll, (config.peer_check_interval ?? 5) * 1000);
}
