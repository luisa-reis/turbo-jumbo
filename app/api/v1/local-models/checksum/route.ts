import {localModelsDir} from '@/lib/config';
import {recordedSha256} from '@/lib/storage/recorded-digest';
import {localSha256} from '@/lib/storage/file-transfer';
import nodePath from 'path';
import {promises as fsp} from 'fs';

// Report a local model file's size and its SHA256, so another peer can compare
// it against its own copy before a transfer overwrites anything.
//
// `recorded=1` asks for the SHA256 the file's sidecar already recorded and
// never reads the file's bytes: `sha256` is null when no trustworthy record
// exists, and the caller decides whether the answer is worth a read. Without
// it the file is hashed, which on a large model means reading every byte.
// Both answers are the same digest of the same bytes, so a caller holding one
// can compare it against the other.
export async function GET(req: Request) {
  if (!localModelsDir) return new Response('No local storage', {status: 400});
  const url = new URL(req.url);
  const file = url.searchParams.get('file');
  if (!file) return new Response('Missing file parameter', {status: 400});
  const recordedOnly = url.searchParams.get('recorded') === '1';

  const base = nodePath.resolve(localModelsDir);
  const full = nodePath.resolve(base, file);
  if (!full.startsWith(base + nodePath.sep))
    return new Response('Invalid path', {status: 400});

  try {
    const {size} = await fsp.stat(full);
    if (recordedOnly) {
      return Response.json({size, sha256: await recordedSha256(base, file)});
    }
    return Response.json({size, sha256: await localSha256(full, req.signal)});
  } catch {
    return new Response('File not found', {status: 404});
  }
}
