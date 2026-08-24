import {handleAgentRequest} from '@/lib/storage/agent-handlers';
import {storage, storageRoots} from '@/lib/storage/storage-instance';

// The agent protocol, served by the full app: a peer running the whole of
// Turbo Jumbo and a thin agent answer an `HttpStorage` identically, which is
// what lets the fleet mix the two while the Storage migration runs (see
// docs/specs/2026-08-10-storage-interface-design.md). The handlers are
// framework-free; this route only wires them to this server's storage.
export async function POST(
  req: Request,
  {params}: {params: Promise<{op: string}>},
) {
  const {op} = await params;
  return handleAgentRequest({storage, roots: storageRoots}, op, req);
}
