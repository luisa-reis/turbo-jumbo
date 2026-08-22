import {test, expect, afterEach} from 'bun:test';
import {refreshLemonadeFlm} from '@/lib/lemonade/lemonade-flm-refresh';

// A stand-in Lemonade server whose /pull streams the given SSE frames.
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function lemonade(frames: string[], seen: {body?: unknown; auth?: string}) {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/api/v1/pull' || req.method !== 'POST')
        return new Response('not found', {status: 404});
      seen.body = await req.json();
      seen.auth = req.headers.get('authorization') ?? undefined;
      const stream = new ReadableStream({
        async start(c) {
          for (const f of frames) {
            c.enqueue(new TextEncoder().encode(f));
            await new Promise((r) => setTimeout(r, 5));
          }
          c.close();
        },
      });
      return new Response(stream, {
        headers: {'Content-Type': 'text/event-stream'},
      });
    },
  });
  servers.push(server);
  return `http://localhost:${server.port}/api/v1`;
}

const complete = (bytes: number) =>
  `event: complete\ndata: ${JSON.stringify({bytes_downloaded: bytes, bytes_total: bytes, total_download_size: bytes, percent: 100})}\n\n`;

test('a no-op pull of a linked model counts as a refresh', async () => {
  const seen: {body?: unknown; auth?: string} = {};
  const base = lemonade([complete(0)], seen);
  const out = await refreshLemonadeFlm(
    base,
    {Authorization: 'Bearer k'},
    'qwen3.6-moe-35b-a3b-FLM',
  );
  expect(out).toEqual({ok: true});
  expect(seen.body).toEqual({model: 'qwen3.6-moe-35b-a3b-FLM', stream: true});
  expect(seen.auth).toBe('Bearer k');
});

test('a pull that starts downloading is aborted and reported, not allowed to run', async () => {
  // flm not accepting the link would mean writing through it into Turbo
  // Jumbo's copy — stop at the first byte it asks for.
  const seen = {};
  const base = lemonade(
    [
      `event: progress\ndata: ${JSON.stringify({bytes_downloaded: 1024, bytes_total: 9999, total_download_size: 9999, percent: 1, file: 'model.q4nx'})}\n\n`,
      complete(9999),
    ],
    seen,
  );
  const out = await refreshLemonadeFlm(base, {}, 'x-FLM');
  expect(out.ok).toBe(false);
  expect(out.message).toMatch(/download/);
});

test('an unreachable server is reported, not thrown', async () => {
  const out = await refreshLemonadeFlm(
    'http://127.0.0.1:9/api/v1',
    {},
    'x-FLM',
    {timeoutMs: 500},
  );
  expect(out.ok).toBe(false);
  expect(out.message).toBeTruthy();
});
