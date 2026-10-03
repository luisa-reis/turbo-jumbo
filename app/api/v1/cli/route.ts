import {servedBinaries} from '@/lib/cli/served-binaries';

// A parameterless GET would be statically optimized at build time, freezing
// the builder's directory listing into the bundle.
export const dynamic = 'force-dynamic';

// The `tj` binaries this server can hand out, each at /api/v1/cli/<name>,
// with their SHA256 when SHA256SUMS lists them. Only those actually present: a
// deploy built without them lists none. The page at /cli renders the same.
export async function GET() {
  return Response.json({binaries: await servedBinaries()});
}
