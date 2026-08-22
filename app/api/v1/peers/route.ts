import {NextResponse} from 'next/server';
import {config, hasColdStorage, modelPeers} from '@/lib/config';

// Expose the peers that hold models to the browser in config-file order,
// flagging the one that is this machine so the UI can show it as "— local".
// A viewer (this machine without model storage) is left out: it is nowhere
// to put a model. `coldStorage` says whether this host has an archive, the
// other destination the UI may offer.
export function GET() {
  return NextResponse.json({
    peers: modelPeers,
    coldStorage: hasColdStorage,
    interval: config.peer_check_interval ?? 5,
  });
}
