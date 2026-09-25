import { describe, expect, it } from 'vitest';
import { browserSentryDsn } from './browser-dsn';
import { dropNetworkBreadcrumb, scrubEvent, sentryOptions } from './sentry-options';

// Built from parts so no credentialed URL appears literally in the source.
const DB_USER = 'housemanager';
const DB_PW = 's3cr3tP%40ss';
const DB_URL = `postgresql://${DB_USER}:${DB_PW}@db-host:5432/housemanager`;

describe('scrubEvent (beforeSend)', () => {
  it('masks secrets in the exception, message, extra, breadcrumbs, request, tags and logentry', () => {
    const event = {
      message: `boom ${DB_URL}`,
      logentry: { formatted: `while dialing ${DB_URL}`, message: '%s', params: [DB_URL] },
      exception: { values: [{ type: 'Error', value: `cannot reach ${DB_URL}` }] },
      extra: { logMessage: ['Authorization: Bearer', 'abcdef123456789'].join(' ') },
      breadcrumbs: [{ category: 'console', message: `connecting ${DB_URL}` }],
      request: { url: 'https://hm.example/api/calendar/9f8e7d6c5b4a.ics' },
      contexts: { nextjs: { request_path: '/api/inbound-email/abcDEF123456?x=1' } },
      tags: { dsn: DB_URL },
    };

    const out = scrubEvent(event);

    expect(JSON.stringify(out)).not.toContain('s3cr3tP');
    expect(JSON.stringify(out)).not.toContain('abcdef123456789');
    expect(out.request).toEqual({ url: 'https://hm.example/api/calendar/***' });
    expect(out.contexts.nextjs.request_path).toBe('/api/inbound-email/***');
    expect(out.exception.values[0].type).toBe('Error');
    expect(out.tags.dsn).not.toContain('s3cr3tP');
    expect(out.logentry.formatted).not.toContain('s3cr3tP');
    expect(out.logentry.params[0]).not.toContain('s3cr3tP');
  });

  // Not vacuous: nested secrets several levels down, compared against a
  // structuredClone taken BEFORE the call, so any in-place mutation anywhere
  // in the walk (not just at the top level) would fail this.
  it('does not mutate the input event, including nested secrets', () => {
    const event = {
      request: {
        url: 'https://hm.example/search?q=x',
        headers: { cookie: 'authjs.session-token=abc123' },
      },
      exception: { values: [{ type: 'Error', value: `boom ${DB_URL}` }] },
      contexts: { nextjs: { request_path: '/api/inbound-email/abcDEF123456?x=1' } },
    };
    const before = structuredClone(event);

    scrubEvent(event);

    expect(event).toEqual(before);
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

  // threads[] carries the same { values: [{ stacktrace: { frames } }] }
  // shape as exception, for some non-Error captures, and was previously
  // unwalked entirely (no query strip, no pattern scrub).
  it('strips queries from stack-frame paths in threads too', () => {
    const out = scrubEvent({
      threads: {
        values: [
          {
            stacktrace: {
              frames: [{ abs_path: 'https://hm.example/search?q=secret+term' }],
            },
          },
        ],
      },
    });
    expect(out.threads.values[0].stacktrace.frames[0].abs_path).toBe('https://hm.example/search');
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

  // L2: user.id is the only field kept; email/IP/username are dropped, and a
  // user with no id is dropped entirely rather than sent as {}.
  it('reduces user to just an id, and drops it entirely when there is no id', () => {
    expect(
      scrubEvent({ user: { id: 'u1', email: 'me@example.com', ip_address: '10.0.0.9' } }),
    ).toEqual({ user: { id: 'u1' } });
    const out = scrubEvent({ user: { email: 'me@example.com' }, message: 'x' });
    expect(out).not.toHaveProperty('user');
  });

  // M1: an ordinary query string is not a named secret shape (no Bearer, no
  // DB password), so lib/log-scrub.ts's patterns alone leave it untouched.
  // This is the second, Sentry-local pass that strips it from free text.
  it('strips query strings from URLs embedded in free text (not just known secret shapes)', () => {
    // Next's own console message when an RSC fetch fails, arriving as a
    // breadcrumb: message plus the console call's raw arguments.
    const rscBreadcrumb = scrubEvent({
      breadcrumbs: [
        {
          category: 'console',
          message:
            'Failed to fetch RSC payload for https://hm.example/search?q=my+medication. Falling back to browser navigation.',
          data: { arguments: ['https://hm.example/search?q=my+medication'] },
        },
      ],
    });
    const rscOut = JSON.stringify(rscBreadcrumb);
    expect(rscOut).not.toContain('my+medication');
    expect(rscOut).toContain('https://hm.example/search');

    // A HetrixTools dead-man URL, whose token is the ?s= query value, inside
    // an exception's value string (not the message/frames paths above).
    const hetrix = scrubEvent({
      exception: {
        values: [
          { type: 'Error', value: 'GET https://sm.hetrixtools.net/hb/?s=t0kenValue failed' },
        ],
      },
    });
    const hetrixOut = JSON.stringify(hetrix);
    expect(hetrixOut).not.toContain('t0kenValue');
    expect(hetrixOut).toContain('https://sm.hetrixtools.net/hb/');

    // A Web Push endpoint URL surfacing in `extra` (e.g. a failed-delivery log).
    const push = scrubEvent({
      extra: { endpoint: 'https://push.example.com/send?token=pushSecretValue' },
    });
    const pushOut = JSON.stringify(push);
    expect(pushOut).not.toContain('pushSecretValue');
    expect(pushOut).toContain('https://push.example.com/send');
  });

  // M2: frame local variables are walked the same as everything else in
  // `exception` (defense in depth — stackFrameVariables is off in
  // dataCollection, but a captured event could still carry them).
  it('strips a query string from a URL inside a stack frame local variable', () => {
    const out = scrubEvent({
      exception: {
        values: [
          {
            stacktrace: {
              frames: [{ vars: { url: 'https://sm.hetrixtools.net/hb/?s=varSecretValue' } }],
            },
          },
        ],
      },
    });
    const s = JSON.stringify(out);
    expect(s).not.toContain('varSecretValue');
  });

  // M2: Node's child_process error carries the full argv, including a DB URL
  // passed as a --dbname flag (the pg_dump path). Same log-scrub pattern that
  // covers lib/logger.ts's spawnargs handling.
  it('masks a DB password inside contexts.node_system_error.spawnargs', () => {
    const out = scrubEvent({
      contexts: {
        node_system_error: { spawnargs: ['pg_dump', `--dbname=${DB_URL}`] },
      },
    });
    const s = JSON.stringify(out);
    expect(s).not.toContain('s3cr3tP');
    expect(out.contexts.node_system_error.spawnargs[1]).toContain('***');
  });

  // L3: event.breadcrumbs is filtered through the SAME policy as live
  // beforeBreadcrumb calls. This matters because a manually-built or
  // replayed event can arrive with breadcrumbs already attached, which never
  // goes through beforeBreadcrumb at all.
  it('applies the network-breadcrumb drop and navigation-query strip to event.breadcrumbs', () => {
    const out = scrubEvent({
      breadcrumbs: [
        { category: 'http', data: { url: 'https://sm.hetrixtools.net/hb/?s=t0ken' } },
        { category: 'navigation', data: { from: '/a', to: '/search?q=secret' } },
        { category: 'console', message: 'hello' },
      ],
    });
    expect(out.breadcrumbs).toEqual([
      { category: 'navigation', data: { from: '/a', to: '/search' } },
      { category: 'console', message: 'hello' },
    ]);
  });

  // L1: never throw. A malformed event must degrade to a minimal, safe event
  // rather than crash the process reporting on it.
  describe('never throws', () => {
    it('handles a null stack frame without throwing', () => {
      expect(() =>
        scrubEvent({ exception: { values: [{ stacktrace: { frames: [null] } }] } }),
      ).not.toThrow();
      const out = scrubEvent({ exception: { values: [{ stacktrace: { frames: [null] } }] } });
      expect(out.exception.values[0].stacktrace.frames[0]).toBeNull();
    });

    it('handles a cyclic array in extra without a RangeError', () => {
      const a: unknown[] = ['x'];
      a.push(a);
      expect(() => scrubEvent({ extra: { a } })).not.toThrow();
      const out = scrubEvent({ extra: { a } }) as { extra: { a: unknown[] } };
      expect(out.extra.a[0]).toBe('x');
    });

    it('falls back to a minimal event when a getter throws', () => {
      const event = {
        exception: { values: [{ type: 'RangeError', value: 'x' }] },
        extra: Object.defineProperty({}, 'boom', {
          enumerable: true,
          get(): never {
            throw new Error('getter blew up');
          },
        }),
      };
      const out = scrubEvent(event);
      expect(out).toEqual({
        exception: { values: [{ type: 'RangeError', value: '[scrub failed]' }] },
      });
    });

    it('falls back to a generic minimal event when there is no exception to preserve', () => {
      const event = {
        extra: Object.defineProperty({}, 'boom', {
          enumerable: true,
          get(): never {
            throw new Error('getter blew up');
          },
        }),
      };
      const out = scrubEvent(event);
      expect(out).toEqual({ exception: { values: [{ type: 'Error', value: '[scrub failed]' }] } });
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
      frameContextLines: 5,
    });
    // Deprecated in 10.x, removed in 11: must not be what privacy depends on.
    expect(o).not.toHaveProperty('sendDefaultPii');
    expect(typeof o.release).toBe('string');
  });

  // H1: tracesSampleRate: 0 alone does NOT stop a transaction when the
  // request carries a sampled remote `sentry-trace` header — reproduced
  // against the real SDK (probe-tx.cjs). tracesSampler always returning 0
  // takes precedence over tracesSampleRate for every span; beforeSendTransaction
  // is the backstop in case a transaction forms anyway. Mutation-checked:
  // removing either fails this.
  it('never samples or sends a transaction, regardless of tracesSampleRate', () => {
    const o = sentryOptions('https://publickey@glitchtip.example/1');
    expect(o.tracesSampler({})).toBe(0);
    expect(o.beforeSendTransaction({ type: 'transaction' }, {})).toBeNull();
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

  // A real Sentry/GlitchTip DSN's userinfo is a public key only. Built from
  // parts, not a literal credentialed URL, per repo convention (ggshield).
  it('rejects a DSN that carries a password', () => {
    const user = 'pub';
    const pass = 'secretValue';
    const dsn = `https://${user}:${pass}@glitchtip.example/1`;
    expect(browserSentryDsn({ SENTRY_BROWSER_DSN: dsn })).toBeUndefined();
  });
});
