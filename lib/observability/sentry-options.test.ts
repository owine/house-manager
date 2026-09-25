import { describe, expect, it } from 'vitest';
import { browserSentryDsn } from './browser-dsn';
import { dropNetworkBreadcrumb, scrubEvent, sentryOptions } from './sentry-options';

// Built from parts so no credentialed URL appears literally in the source.
const DB_USER = 'housemanager';
const DB_PW = 's3cr3tP%40ss';
const DB_URL = `postgresql://${DB_USER}:${DB_PW}@db-host:5432/housemanager`;

describe('scrubEvent (beforeSend)', () => {
  it('masks secrets in the exception, message, extra, breadcrumbs and request', () => {
    const event = {
      message: `boom ${DB_URL}`,
      exception: { values: [{ type: 'Error', value: `cannot reach ${DB_URL}` }] },
      extra: { logMessage: ['Authorization: Bearer', 'abcdef123456789'].join(' ') },
      breadcrumbs: [{ category: 'console', message: `connecting ${DB_URL}` }],
      request: { url: 'https://hm.example/api/calendar/9f8e7d6c5b4a.ics' },
      contexts: { nextjs: { request_path: '/api/inbound-email/abcDEF123456?x=1' } },
    };

    const out = scrubEvent(event);

    expect(JSON.stringify(out)).not.toContain('s3cr3tP');
    expect(JSON.stringify(out)).not.toContain('abcdef123456789');
    expect(out.request).toEqual({ url: 'https://hm.example/api/calendar/***' });
    expect(out.contexts.nextjs.request_path).toBe('/api/inbound-email/***');
    expect(out.exception.values[0].type).toBe('Error');
  });

  // The HTTP integration names a request's scope `${method} ${raw path}`, so a
  // bridged log line inside the inbound webhook carried the real token here.
  // Mutation-checked: dropping 'transaction' from SCRUBBED_SECTIONS fails this.
  it('masks the token in the transaction name and drops its query string', () => {
    const out = scrubEvent({ transaction: 'POST /api/inbound-email/inboxTok3nValue?x=1' });
    expect(out.transaction).toBe('POST /api/inbound-email/***');
  });

  // Inline browser code is attributed to the page URL, query included.
  // Mutation-checked: skipping stripFrameQueries fails this.
  it('strips queries from browser stack-frame paths, leaving server paths alone', () => {
    const out = scrubEvent({
      exception: {
        values: [
          {
            type: 'Error',
            stacktrace: {
              frames: [
                {
                  abs_path: 'https://hm.example/search?q=secret+term',
                  filename: 'https://hm.example/search?q=secret+term',
                },
                { abs_path: '/app/web/.next/server/chunks/x.js', filename: 'app:///x.js' },
              ],
            },
          },
        ],
      },
    });
    expect(out.exception.values[0].stacktrace.frames).toEqual([
      { abs_path: 'https://hm.example/search', filename: 'https://hm.example/search' },
      { abs_path: '/app/web/.next/server/chunks/x.js', filename: 'app:///x.js' },
    ]);
  });

  // Mutation-checked: passing `request` through (no allowlist) fails this.
  it('reduces request to method, query-less url and User-Agent', () => {
    const out = scrubEvent({
      request: {
        method: 'POST',
        url: 'https://hm.example/search?q=my+medication',
        query_string: 'q=my+medication',
        data: '{"text":"private email body"}',
        cookies: { 'authjs.session-token': 'abc' },
        headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://hm.example/items?q=x' },
        env: { REMOTE_ADDR: '10.0.0.9' },
      },
    });
    expect(out.request).toEqual({
      method: 'POST',
      url: 'https://hm.example/search',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
  });

  it('passes other sections through by reference (SDK internals stay live)', () => {
    const scope = new (class Scope {
      tag = `leave ${DB_URL} alone`;
    })();
    const event = { sdkProcessingMetadata: { capturedSpanScope: scope }, message: 'x' };
    const out = scrubEvent(event);
    expect(out.sdkProcessingMetadata.capturedSpanScope).toBe(scope);
    expect(event.message).toBe('x'); // input not mutated
  });
});

describe('dropNetworkBreadcrumb (beforeBreadcrumb)', () => {
  it('drops outgoing request breadcrumbs, whose URLs can carry tokens', () => {
    for (const category of ['http', 'fetch', 'xhr']) {
      expect(
        dropNetworkBreadcrumb({
          category,
          data: { url: 'https://sm.hetrixtools.net/hb/?s=t0ken' },
        }),
      ).toBeNull();
    }
  });

  // Search terms travel in the query (?q=), and the browser records every
  // navigation as { from, to } with path + query. Mutation-checked: returning
  // navigation breadcrumbs unchanged fails this.
  it('strips the query from navigation breadcrumbs, keeping the path', () => {
    const crumb = {
      category: 'navigation',
      data: { from: '/search?q=my+medication', to: '/items/abc?tab=notes#top' },
    };
    expect(dropNetworkBreadcrumb(crumb)).toEqual({
      category: 'navigation',
      data: { from: '/search', to: '/items/abc' },
    });
    expect(crumb.data.from).toBe('/search?q=my+medication'); // input not mutated
  });

  it('keeps everything else', () => {
    const crumb = { category: 'console', message: 'hello' };
    expect(dropNetworkBreadcrumb(crumb)).toBe(crumb);
    const bare: { category?: string; message: string } = { message: 'no category' };
    expect(dropNetworkBreadcrumb(bare)).toBe(bare);
  });
});

describe('sentryOptions', () => {
  it('collects no user data, sets no tracing, and wires the scrubbers', () => {
    const o = sentryOptions('https://publickey@glitchtip.example/1');
    expect(o).toMatchObject({
      dsn: 'https://publickey@glitchtip.example/1',
      tracesSampleRate: 0,
      tracePropagationTargets: [],
      beforeSend: scrubEvent,
      beforeBreadcrumb: dropNetworkBreadcrumb,
    });
    expect(o.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
    });
    // Deprecated in 10.x, removed in 11: must not be what privacy depends on.
    expect(o).not.toHaveProperty('sendDefaultPii');
    expect(typeof o.release).toBe('string');
  });
});

describe('browserSentryDsn', () => {
  it('returns an http(s) DSN, and undefined for unset, empty or malformed', () => {
    const dsn = 'https://publickey@glitchtip.example/2';
    expect(browserSentryDsn({ SENTRY_BROWSER_DSN: dsn })).toBe(dsn);
    expect(browserSentryDsn({})).toBeUndefined();
    expect(browserSentryDsn({ SENTRY_BROWSER_DSN: '' })).toBeUndefined();
    expect(browserSentryDsn({ SENTRY_BROWSER_DSN: 'not a url' })).toBeUndefined();
    expect(browserSentryDsn({ SENTRY_BROWSER_DSN: 'javascript:alert(1)' })).toBeUndefined();
  });
});
