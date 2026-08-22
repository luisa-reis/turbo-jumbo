import {isObject, readJsonBody} from '@/lib/util/request';
import {streamHfDownload} from '@/lib/hf/hf-download-stream';

// Download onto this machine. The streamer itself refuses on a host without
// model storage, so the peer proxy that also calls it needs no guard of its own.
export async function POST(req: Request) {
  const body = await readJsonBody<{
    repoId?: unknown;
    branch?: unknown;
    filePaths?: unknown;
    fileScope?: unknown;
    sendToCold?: unknown;
    deleteAfterTransfer?: unknown;
  }>(req, isObject);
  if (body instanceof Response) return body;
  return streamHfDownload(body, req.signal);
}
