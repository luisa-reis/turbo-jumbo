import {config, lemonadeApiKey} from '@/lib/config';
import {
  lemonadeApiBase,
  lemonadeHeaders,
  lemonadeStatusMessage,
  parseFlmModels,
} from '@/lib/lemonade/flm';
import {cachedFlmRegistry} from '@/lib/lemonade/flm-registry';
import {peerSlug} from '@/lib/peers/peer-slug';
import {logger} from '@/lib/util/logger';

// The FLM (NPU) models of the named peer's Lemonade server, live. FLM models
// exist only inside a running Lemonade instance (discovered from its flm
// binary), so peers without a configured `lemonade_url` report unconfigured
// rather than empty — the UI can then hide the section instead of implying
// the server has no FLM models. Each model additionally carries the HF
// source its tag resolves to in FastFlowLM's public registry, when known.
export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get('peer') ?? '';
  const peer = config.peers.find((p) => peerSlug(p) === slug);
  if (!peer) return new Response('Unknown peer', {status: 404});
  if (!peer.lemonade_url) return Response.json({configured: false, models: []});
  const base = lemonadeApiBase(peer.lemonade_url);
  try {
    const res = await fetch(`${base}/models?show_all=true`, {
      headers: lemonadeHeaders(lemonadeApiKey(peer)),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok)
      return new Response(lemonadeStatusMessage(res.status), {status: 502});
    // A model without a registry source falls back to a Lemonade-server pull.
    const registry = await cachedFlmRegistry();
    const models = parseFlmModels(await res.json()).map((m) => {
      const source = registry.get(m.checkpoint);
      return source ? {...m, source} : m;
    });
    logger.trace(`[flm] ${peer.name}: ${models.length} FLM model(s)`);
    return Response.json({configured: true, server: base, models});
  } catch (e) {
    logger.warn(`[flm] ${peer.name} (${base}) unreachable: ${String(e)}`);
    return new Response(
      `Lemonade server unreachable: ${e instanceof Error ? e.message : String(e)}`,
      {status: 502},
    );
  }
}
