import { createServer, type Server } from 'node:http';

import type { HealthResult } from '@/lib/health';
import { getLogger } from '@/lib/logger';
import type { Heartbeat } from './heartbeat';

const log = getLogger('worker.health');

/**
 * The worker deliberately serves the same port and path as the web app.
 * Containers get separate network namespaces, so there is no collision, and
 * it lets one HEALTHCHECK line in the Dockerfile be correct for both roles
 * without role detection or an extra env var.
 */
export const WORKER_HEALTH_PORT = 3000;
export const WORKER_HEALTH_PATH = '/api/health';

export type WorkerHealthStatus = 'ok' | 'starting' | 'stale' | 'down';

export function resolveStatus(
  depsOk: boolean,
  ageMs: number | null,
  fresh: boolean,
): WorkerHealthStatus {
  if (!depsOk) return 'down';
  if (ageMs === null) return 'starting';
  if (!fresh) return 'stale';
  return 'ok';
}

export type HealthServerOptions = {
  heartbeat: Heartbeat;
  checkDeps: () => Promise<HealthResult>;
};

export function createHealthServer(opts: HealthServerOptions): Server {
  return createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (path !== WORKER_HEALTH_PATH) {
      send(404, { status: 'not_found' });
      return;
    }

    void opts
      .checkDeps()
      .then((deps) => {
        const ageMs = opts.heartbeat.ageMs();
        const status = resolveStatus(deps.status === 'ok', ageMs, opts.heartbeat.isFresh());
        send(status === 'ok' ? 200 : 503, {
          status,
          role: 'worker',
          checks: deps.checks,
          heartbeat: { ageMs },
        });
      })
      .catch((e) => {
        log.error({ err: e }, 'health request failed');
        send(503, { status: 'down', role: 'worker', error: (e as Error).message });
      });
  });
}
