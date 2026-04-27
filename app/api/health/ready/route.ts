import { getEnv } from '@/lib/env';
import { isReady } from '@/lib/health';

export const dynamic = 'force-dynamic';

export async function GET() {
  const env = getEnv();
  const result = await isReady({ databaseUrl: env.DATABASE_URL, meiliUrl: env.MEILI_HOST });
  return Response.json(result, { status: result.ready ? 200 : 503 });
}
