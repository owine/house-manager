import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkHealth, isReady } from '@/lib/health';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

// This file's own database on the shared server, not a Postgres container of its
// own: probing a server that has just booted against lib/health's 2s budget, on
// a runner busy starting every other file, was racing the budget for nothing.
let ctx: IntegrationContext;
let stack: IntegrationContext['stack'];

beforeAll(async () => {
  ctx = await setupIntegration();
  stack = ctx.stack;
}, 120_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

describe('readiness check', () => {
  it('returns ready when db and meilisearch reachable', async () => {
    const result = await isReady({ databaseUrl: stack.databaseUrl, meiliUrl: stack.meiliUrl });
    expect(result.ready).toBe(true);
    expect(result.checks.database).toBe('ok');
    expect(result.checks.meilisearch).toBe('ok');
  });

  it('returns not ready when db is unreachable', async () => {
    const result = await isReady({
      databaseUrl: 'postgresql://nope:nope@127.0.0.1:1/nope',
      meiliUrl: stack.meiliUrl,
    });
    expect(result.ready).toBe(false);
    expect(result.checks.database).not.toBe('ok');
  });
});

describe('container health check', () => {
  it('is ok when db and meilisearch reachable', async () => {
    const result = await checkHealth({
      databaseUrl: stack.databaseUrl,
      meiliUrl: stack.meiliUrl,
    });
    expect(result.status).toBe('ok');
  });

  it('is down when db is unreachable', async () => {
    const result = await checkHealth({
      databaseUrl: 'postgresql://nope:nope@127.0.0.1:1/nope',
      meiliUrl: stack.meiliUrl,
    });
    expect(result.status).toBe('down');
  });

  it('stays ok when only meilisearch is unreachable', async () => {
    const result = await checkHealth({
      databaseUrl: stack.databaseUrl,
      meiliUrl: 'http://127.0.0.1:1',
    });
    expect(result.status).toBe('ok');
    expect(result.checks.meilisearch).not.toBe('ok');
  });
});
