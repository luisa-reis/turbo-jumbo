import {NextResponse} from 'next/server';
import {lemonadeBuiltinDir, lemonadeExtraDir} from '@/lib/config';
import {logger} from '@/lib/util/logger';
import {scanLemonadeCache} from '@/lib/lemonade/lemonade-cache-scan';

// Lemonade keeps its own hub-cache of models it has pulled, separate from the
// turbo-jumbo storage the rest of the app manages. scanModels normally skips
// this directory; here we scan both halves of it directly so the Lemonade
// browser can flag catalog entries that live in that cache, and say which half
// each was found on.
export function GET() {
  if (!lemonadeBuiltinDir || !lemonadeExtraDir) return NextResponse.json([]);
  const models = scanLemonadeCache({
    builtin: lemonadeBuiltinDir,
    extra: lemonadeExtraDir,
  });
  logger.trace(`[lemonade-cache] scan: ${models.length} model(s)`);
  return NextResponse.json(models);
}
