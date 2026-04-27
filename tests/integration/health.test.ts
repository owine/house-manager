import { isReady } from '@/lib/health';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestStack, startStack, stopStack } from './setup';

let stack: TestStack;

beforeAll(async () => {
  stack = await startStack();
}, 120_000);

afterAll(async () => {
  await stopStack(stack);
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
