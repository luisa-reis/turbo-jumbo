import {config, localPeer, type Peer} from '@/lib/config';
import {scanModels, type Model} from '@/lib/models/models';
import {storageForPeer} from '@/lib/storage/peer-storage';
import {publishPeerEvent} from './peer-event-hub';
import {logger} from '@/lib/util/logger';

const peerStatus = new Map<string, 'up' | 'down'>();

async function checkPeer(peer: Peer): Promise<void> {
  const address = peer.address;
  try {
    let models: Model[] | null = null;
    if (peer.agent_address) {
      // An agent answers liveness for almost nothing; the scan — a remote
      // walk — runs only on the transition to up, when the event needs it.
      const res = await fetch(`http://${peer.agent_address}/`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (peerStatus.get(address) !== 'up') {
        models = await scanModels({
          storage: storageForPeer(address),
          root: 'models',
        });
      }
    } else {
      const res = await fetch(`http://${address}/api/v1/local-models`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      models = await res.json();
    }

    const prev = peerStatus.get(address);
    peerStatus.set(address, 'up');

    if (prev !== 'up') {
      logger.info(`[monitor] peer up: ${address}`);
      publishPeerEvent({type: 'peer-up', address, models: models ?? []});
    }
  } catch {
    const prev = peerStatus.get(address);
    peerStatus.set(address, 'down');

    if (prev === 'up') {
      logger.info(`[monitor] peer down: ${address}`);
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
