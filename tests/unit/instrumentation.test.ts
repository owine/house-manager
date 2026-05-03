import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('instrumentation', () => {
  const originalDsn = process.env.SENTRY_DSN;

  beforeEach(() => {
    delete process.env.SENTRY_DSN;
  });

  afterEach(() => {
    if (originalDsn !== undefined) process.env.SENTRY_DSN = originalDsn;
    else delete process.env.SENTRY_DSN;
  });

  it('register() is a no-op when SENTRY_DSN is unset', async () => {
    const mod = await import('@/instrumentation');
    expect(typeof mod.register).toBe('function');
    // Should not throw, should not init Sentry.
    await expect(mod.register()).resolves.toBeUndefined();
  });
});
