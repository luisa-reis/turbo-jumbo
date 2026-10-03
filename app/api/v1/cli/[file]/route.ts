import {createReadStream, promises as fsp} from 'fs';
import path from 'path';
import {Readable} from 'stream';
import {cliDir, isServedFile} from '@/lib/cli/binaries';

// One standalone `tj` binary (or SHA256SUMS), built into this deploy by
// bin/build-cli.sh and so stamped with the commit this server runs:
//
//   curl -fLo ~/bin/tj http://<server>/api/v1/cli/tj-darwin-arm64
export async function GET(
  _req: Request,
  {params}: {params: Promise<{file: string}>},
) {
  const {file} = await params;
  if (!isServedFile(file)) {
    return new Response(
      `No such file: ${file}. GET /api/v1/cli lists what this server has.\n`,
      {status: 404},
    );
  }
  const full = path.join(cliDir(), file);
  let size: number;
  try {
    size = (await fsp.stat(full)).size;
  } catch {
    return new Response(
      `This server has no ${file}: bin/build-cli.sh didn't build it into ` +
        `this deploy. GET /api/v1/cli lists what it has.\n`,
      {status: 404},
    );
  }
  return new Response(
    Readable.toWeb(createReadStream(full)) as ReadableStream<Uint8Array>,
    {
      headers: {
        'Content-Type':
          file === 'SHA256SUMS'
            ? 'text/plain; charset=utf-8'
            : 'application/octet-stream',
        'Content-Length': String(size),
        'Content-Disposition': `attachment; filename="${file}"`,
        // A redeploy replaces the file under the same name.
        'Cache-Control': 'no-cache',
      },
    },
  );
}
