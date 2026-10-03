import {promises as fsp} from 'fs';
import path from 'path';
import {SERVED_FILES, cliDir} from '@/lib/cli/binaries';

// A parameterless GET would be statically optimized at build time, freezing
// the builder's directory listing into the bundle.
export const dynamic = 'force-dynamic';

// The `tj` binaries this server can hand out, each at /api/v1/cli/<name>.
// Only those actually present: a deploy built without them lists none.
export async function GET() {
  const dir = cliDir();
  const files = (
    await Promise.all(
      SERVED_FILES.map(async (name) => {
        try {
          const {size} = await fsp.stat(path.join(dir, name));
          return {name, size, path: `/api/v1/cli/${name}`};
        } catch {
          return null;
        }
      }),
    )
  ).filter((f) => f !== null);
  return Response.json({files});
}
