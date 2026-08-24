/// <reference types="bun" />

/**
 * The standalone storage agent: the same handlers the full app mounts at
 * /api/v1/storage, behind a bare Bun server instead of Next — no UI, no
 * build, no fleet knowledge. A machine that only holds models runs this
 * (plus the `hf` CLI for downloads) and nothing else; an `HttpStorage`
 * caller cannot tell it from a peer running all of Turbo Jumbo, which is
 * what lets the fleet mix the two while the cutover runs.
 *
 * Auth is one bearer token from the agent's own config. The control host
 * stores it beside the peer entry (`agent_token`) and presents it on every
 * request — including inside the `send` specs it hands other agents, so
 * tokens travel from config, never from agent to agent.
 */

import {
  handleAgentRequest,
  type AgentContext,
} from '@/lib/storage/agent-handlers';
import {createLocalStorage, type Roots} from '@/lib/storage/local-storage';

export interface AgentServerConfig {
  /** 0 picks a free port (tests); a real agent names one. */
  port: number;
  /** Required on anything but a loopback experiment. */
  token?: string;
  /** The directories behind the roots; at least one. */
  roots: Roots;
}

export interface RunningAgent {
  port: number;
  stop: () => void;
}

const PROTOCOL_PATH = /^\/api\/v1\/storage\/([^/]+)$/;

export function startAgent(config: AgentServerConfig): RunningAgent {
  const storage = createLocalStorage(config.roots);
  const ctx: AgentContext = {storage, roots: config.roots};

  const server = Bun.serve({
    port: config.port,
    // Job streams can sit quiet for minutes (hf prints nothing until it is
    // done); an idle timeout would cut them off mid-download.
    idleTimeout: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === 'GET' && url.pathname === '/') {
        // A liveness answer, deliberately content-free.
        return new Response('turbo-jumbo agent\n');
      }
      const match = url.pathname.match(PROTOCOL_PATH);
      if (!match || req.method !== 'POST') {
        return new Response('Not found', {status: 404});
      }
      if (config.token !== undefined) {
        const auth = req.headers.get('authorization');
        if (auth !== `Bearer ${config.token}`) {
          return new Response('Unauthorized', {status: 401});
        }
      }
      return handleAgentRequest(ctx, match[1], req);
    },
  });

  return {
    port: server.port ?? config.port,
    stop: () => void server.stop(true),
  };
}
