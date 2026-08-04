import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import type { HealthResult } from '@/lib/health';
import {
  createHealthServer,
  DEFAULT_WORKER_HEALTH_PORT,
  resolveStatus,
  resolveWorkerHealthPort,
} from './health-server';
import type { Heartbeat } from './heartbeat';

describe('resolveWorkerHealthPort', () => {
  it('defaults to 3000 so containers and the Dockerfile need no env var', () => {
    expect(resolveWorkerHealthPort({})).toBe(DEFAULT_WORKER_HEALTH_PORT);
    expect(DEFAULT_WORKER_HEALTH_PORT).toBe(3000);
  });

  // The documented local workflow runs `pnpm dev` (Next on 3000) alongside
  // `pnpm worker:dev` on one host, where they would otherwise collide.
  it('honours an override for local dev', () => {
    expect(resolveWorkerHealthPort({ WORKER_HEALTH_PORT: '3001' })).toBe(3001);
  });

  it('falls back to the default rather than crashing on garbage', () => {
    for (const value of ['', 'abc', '0', '-1', '70000', '3000.5']) {
      expect(resolveWorkerHealthPort({ WORKER_HEALTH_PORT: value })).toBe(
        DEFAULT_WORKER_HEALTH_PORT,
      );
    }
  });
});

function stubHeartbeat(over: Partial<Heartbeat> = {}): Heartbeat {
  return {
    start: () => {},
    stop: () => {},
    beat: async () => {},
    ageMs: () => 0,
    isFresh: () => true,
    ...over,
  };
}

const OK: HealthResult = { status: 'ok', checks: { database: 'ok', meilisearch: 'ok' } };
const DOWN: HealthResult = {
  status: 'down',
  checks: { database: 'error: ECONNREFUSED', meilisearch: 'ok' },
};

describe('resolveStatus', () => {
  it('is ok when deps are ok and the heartbeat is fresh', () => {
    expect(resolveStatus(true, 0, true)).toBe('ok');
  });

  it('is starting before the first beat', () => {
    expect(resolveStatus(true, null, false)).toBe('starting');
  });

  it('is stale when a beat landed but has aged out', () => {
    expect(resolveStatus(true, 999_999, false)).toBe('stale');
  });

  // Dependency failure outranks "starting": when Postgres is gone the
  // heartbeat cannot beat either, and `down` is the more useful report.
  it('is down when deps fail, even before the first beat', () => {
    expect(resolveStatus(false, null, false)).toBe('down');
  });
});

let close: (() => Promise<void>) | null = null;

afterEach(async () => {
  await close?.();
  close = null;
});

async function serve(heartbeat: Heartbeat, deps: HealthResult) {
  const server = createHealthServer({ heartbeat, checkDeps: async () => deps });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

describe('createHealthServer', () => {
  it('answers 200 on /api/health when healthy', async () => {
    const base = await serve(stubHeartbeat(), OK);
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: 'ok',
      checks: { database: 'ok' },
    });
  });

  it('answers 503 when the heartbeat is stale', async () => {
    const base = await serve(stubHeartbeat({ isFresh: () => false, ageMs: () => 500_000 }), OK);
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ status: 'stale' });
  });

  it('answers 503 when a dependency is down', async () => {
    const base = await serve(stubHeartbeat(), DOWN);
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ status: 'down' });
  });

  it('404s any other path', async () => {
    const base = await serve(stubHeartbeat(), OK);
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
  });

  it('ignores the query string when matching the path', async () => {
    const base = await serve(stubHeartbeat(), OK);
    expect((await fetch(`${base}/api/health?verbose=1`)).status).toBe(200);
  });
});
