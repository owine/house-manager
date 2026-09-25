import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLogger } from '@/lib/logger';
import { getErrorReporter, setErrorReporter } from '@/lib/observability/error-reporter';
import { scrubEvent } from '@/lib/observability/sentry-options';

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureRequestError: vi.fn(),
  httpIntegration: vi.fn((options: object) => ({ name: 'Http', options })),
}));
vi.mock('@sentry/nextjs', () => sentry);

import { onRequestError, register } from '@/instrumentation';

const DSN = 'https://publickey@glitchtip.example/1';
const REQUEST = { path: '/items/abc', method: 'GET', headers: {} };
const CONTEXT = {
  routerKind: 'App Router',
  routePath: '/items/[id]',
  routeType: 'render',
  renderSource: 'react-server-components',
  revalidateReason: undefined,
  renderType: 'dynamic',
} as const;

describe('instrumentation', () => {
  const saved = { dsn: process.env.SENTRY_DSN, runtime: process.env.NEXT_RUNTIME };

  beforeEach(() => {
    delete process.env.SENTRY_DSN;
    process.env.NEXT_RUNTIME = 'nodejs';
    setErrorReporter(undefined);
  });

  afterEach(() => {
    if (saved.dsn !== undefined) process.env.SENTRY_DSN = saved.dsn;
    else delete process.env.SENTRY_DSN;
    if (saved.runtime !== undefined) process.env.NEXT_RUNTIME = saved.runtime;
    else delete process.env.NEXT_RUNTIME;
    setErrorReporter(undefined);
  });

  it('register() without SENTRY_DSN inits nothing and installs no bridge', async () => {
    await expect(register()).resolves.toBeUndefined();
    expect(sentry.init).not.toHaveBeenCalled();
    expect(getErrorReporter()).toBeUndefined();
  });

  it('onRequestError without SENTRY_DSN reports nothing', async () => {
    await onRequestError(new Error('boom'), REQUEST, CONTEXT);
    expect(sentry.captureRequestError).not.toHaveBeenCalled();
  });

  it('onRequestError forwards the error, request and context to Sentry', async () => {
    process.env.SENTRY_DSN = DSN;
    const err = new Error('render failed');
    await onRequestError(err, REQUEST, CONTEXT);
    expect(sentry.captureRequestError).toHaveBeenCalledTimes(1);
    expect(sentry.captureRequestError).toHaveBeenCalledWith(err, REQUEST, CONTEXT);
  });

  it('register() inits with the shared scrubbing options', async () => {
    process.env.SENTRY_DSN = DSN;
    await register();
    expect(sentry.init).toHaveBeenCalledTimes(1);
    const options = sentry.init.mock.calls[0][0];
    expect(options).toMatchObject({ dsn: DSN, tracesSampleRate: 0, beforeSend: scrubEvent });
    expect(options.dataCollection).toMatchObject({ cookies: false, httpHeaders: false });
    expect(options).not.toHaveProperty('sendDefaultPii');
    // 10.75 buffers incoming request bodies unless the HTTP integration is told
    // not to. Mutation-checked: dropping the integration fails this.
    // Replacing @sentry/nextjs's default Http integration must keep its
    // disableIncomingRequestSpans. Mutation-checked: dropping either option fails.
    const http = { maxIncomingRequestBodySize: 'none', disableIncomingRequestSpans: true };
    expect(sentry.httpIntegration).toHaveBeenCalledWith(http);
    expect(options.integrations).toEqual([{ name: 'Http', options: http }]);
  });

  it('register() on nodejs bridges logger.error({ err }) to captureException', async () => {
    process.env.SENTRY_DSN = DSN;
    await register();
    const err = new Error('action failed');
    getLogger('items.actions').error({ err, event: 'item.create.failed' }, 'create failed');
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(err, {
      level: 'error',
      tags: { source: 'pino', module: 'items.actions', event: 'item.create.failed' },
      extra: { logMessage: 'create failed' },
    });
  });

  it('register() on edge inits but installs no bridge (no Pino there)', async () => {
    process.env.SENTRY_DSN = DSN;
    process.env.NEXT_RUNTIME = 'edge';
    await register();
    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect(sentry.httpIntegration).not.toHaveBeenCalled();
    expect(getErrorReporter()).toBeUndefined();
  });
});
