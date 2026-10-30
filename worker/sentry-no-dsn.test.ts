import * as Sentry from '@sentry/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getErrorReporter } from '@/lib/observability/error-reporter';
import { initWorkerSentry } from './sentry';

// Its own file, not a first test in ./sentry.test.ts: Sentry state is global,
// so "no client" only holds in a process where nothing has inited the SDK yet.
// As the first of a sequence it failed under --sequence.shuffle and under any
// `-t` filter that ran the DSN tests without it. Vitest isolates files, so here
// it holds regardless of order.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('worker Sentry without a DSN', () => {
  it('inits no client and installs no bridge', () => {
    // The default argument reads process.env.SENTRY_DSN, so keep it stubbed
    // empty for EVERY call. Unstubbing midway restored a developer's .env DSN,
    // which flipped the result to true and inited the real SDK against their
    // real GlitchTip.
    vi.stubEnv('SENTRY_DSN', '');
    expect(initWorkerSentry()).toBe(false);
    expect(initWorkerSentry(undefined)).toBe(false);
    expect(initWorkerSentry('')).toBe(false);
    expect(Sentry.getClient()).toBeUndefined();
    expect(getErrorReporter()).toBeUndefined();
  });
});
