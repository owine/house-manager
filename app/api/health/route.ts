import { getEnv } from '@/lib/env';
import { checkHealth } from '@/lib/health';
import { APP_GIT_SHA, APP_VERSION } from '@/lib/version';

export const dynamic = 'force-dynamic';

/**
 * Container health for the web role. Deliberately DB-backed rather than a
 * static 200: this is what the Dockerfile HEALTHCHECK probes, and a web
 * container that cannot reach Postgres is not healthy in any useful sense.
 *
 * Note this makes `/api/health` a readiness-flavoured probe rather than a
 * pure liveness one. That is safe here because Docker restarts *exited*
 * containers, not `unhealthy` ones, so a Postgres outage cannot induce a
 * restart loop. Revisit if this ever runs under an orchestrator that
 * restarts on liveness failure.
 *
 * `/api/health/ready` keeps the stricter contract where Meilisearch is fatal.
 */
export async function GET() {
  const env = getEnv();
  const result = await checkHealth({
    databaseUrl: env.DATABASE_URL,
    meiliUrl: env.MEILI_HOST,
  });
  return Response.json(
    {
      status: result.status,
      version: APP_VERSION,
      sha: APP_GIT_SHA,
      checks: result.checks,
    },
    { status: result.status === 'ok' ? 200 : 503 },
  );
}
