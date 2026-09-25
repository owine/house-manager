import { describe, expect, it } from 'vitest';
import { scrubSecrets } from '@/lib/log-scrub';
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

  // Lows: the relative-path strip (no host) was previously breadcrumb-only.
  // Now linear-time, it also runs over an exception's own `.value` text, a
  // logged `message`/`logentry`, and `contexts.nextjs`'s sibling path fields
  // (request_path already had bespoke handling; router_path only reaches
  // this generic pass). Mutation-checked: narrowing RELATIVE_STRIP_SECTIONS
  // back to breadcrumbs-only fails the first assertion here.
  it('strips a relative-path query from exception.value, message/logentry and contexts.nextjs', () => {
    const out = scrubEvent({
      exception: { values: [{ type: 'Error', value: 'fetch failed for /search?q=RELCANARY' }] },
      message: 'redirecting to /items?q=RELCANARY2',
      logentry: { formatted: 'see /search?q=RELCANARY3 for details' },
      contexts: { nextjs: { router_path: '/search?q=RELCANARY4' } },
    });
    const s = JSON.stringify(out);
    expect(s).not.toContain('RELCANARY');
  });

  // Lows: ABS_URL_RE used to exclude `)'"<>` from the WHOLE match, so it
  // stopped matching (and stripping) at the first such character even inside
  // the query itself — "?q=(my)medication" left the match at "?q=(my" and
  // the untouched ")medication" leaked straight through. It now strips
  // everything from the query marker to the next whitespace instead.
  // Mutation-checked: reverting ABS_URL_RE to the old "exclude from the whole
  // match" shape fails this.
  it('does not leak the tail of a query string that contains a paren, quote or angle bracket', () => {
    const out = scrubEvent({
      exception: {
        values: [{ type: 'Error', value: 'GET https://h/search?q=(my)medication tail' }],
      },
    });
    expect(out.exception.values[0].value).not.toContain('medication');
    expect(out.exception.values[0].value).toContain('https://h/search');
  });

  // H1' round 3 (a): a path segment containing `(`, `)` or `'` before the `?`
  // used to shield the query entirely — the base class excluded those
  // characters, so the match stopped short of the `?` and nothing was
  // stripped. A wiki-style path is a real shape this hits. Mutation-checked:
  // reverting ABS_URL_RE to the round-2 shape fails this (it leaves the
  // token in place instead of stripping it).
  it('strips the query from a URL whose path contains parens (wiki-style paths)', () => {
    const secretToken = ['tok', 'SECRET', '123'].join('');
    const out = scrubEvent({
      exception: {
        values: [{ type: 'Error', value: `GET https://h/wiki/Foo_(bar)?token=${secretToken}` }],
      },
    });
    expect(out.exception.values[0].value).not.toContain(secretToken);
    expect(out.exception.values[0].value).toBe('GET https://h/wiki/Foo_(bar)');
  });

  // H1' round 3 (b): the round-2 query group (`\S*`) swallowed everything up
  // to the next whitespace, which is right for free text but wrong for a URL
  // embedded in JSON — it ate the closing quote and every sibling field after
  // it. The query group now stops at a quote/angle-bracket too, so only the
  // query itself is removed. Mutation-checked: reverting ABS_URL_RE to the
  // round-2 shape fails this (it drops `,"other":"keep"}` entirely).
  it('strips a URL query embedded in JSON without eating the rest of the JSON', () => {
    const secretToken = ['t', 'SECRET', 'val'].join('');
    const json = `{"url":"https://h/p?t=${secretToken}","other":"keep"}`;
    const out = scrubEvent({ extra: { raw: json } }) as { extra: { raw: string } };
    expect(out.extra.raw).not.toContain(secretToken);
    expect(out.extra.raw).toBe('{"url":"https://h/p","other":"keep"}');
  });

  // H1' round 3 (c): ABS_URL_RE only matched `https?://`, so a password or
  // token on any OTHER scheme's URL (a raw DB connection string that isn't
  // shaped like log-scrub's userinfo pattern, a WebSocket URL) passed
  // straight through. It now matches any scheme. Mutation-checked: reverting
  // ABS_URL_RE to the round-2 (https-only) shape fails this.
  it('strips the query from a non-http(s) scheme URL (postgresql, wss)', () => {
    const dbSecret = ['db', 'SECRET', '456'].join('');
    const dbQueryUrl = `postgresql://db-host/housemanager?auth=${dbSecret}`;
    const wsToken = ['ws', 'SECRET', 'tok'].join('');
    const wsUrl = `wss://h/p?t=${wsToken}`;

    const out = scrubEvent({ extra: { db: dbQueryUrl, ws: wsUrl } }) as {
      extra: { db: string; ws: string };
    };
    expect(out.extra.db).not.toContain(dbSecret);
    expect(out.extra.db).toBe('postgresql://db-host/housemanager');
    expect(out.extra.ws).not.toContain(wsToken);
    expect(out.extra.ws).toBe('wss://h/p');
  });

  // Regression guard: a file: frame (no query at all) must be completely
  // unaffected by ABS_URL_RE now matching every scheme, not just http(s).
  it('leaves a file: URL with no query unchanged', () => {
    const value = 'file:///app/x.js:1:2';
    const out = scrubEvent({ exception: { values: [{ type: 'Error', value }] } });
    expect(out.exception.values[0].value).toBe(value);
  });

  // Nits: a negative over-strip test. None of these contain a query string
  // that should be touched — a bare '?', a slash that isn't a path start, a
  // file:// or absolute path with no query, or an absolute URL with no query
  // at all. All must survive byte-for-byte.
  it('does not over-strip text that only looks like a URL or path', () => {
    const unchanged = [
      'a?b',
      'Is this ok? yes',
      'ratio 1/2?',
      'file:///app/x.js:1:2',
      '/app/x.js:1:2',
      'https://h/app.js:10:5',
    ];
    for (const value of unchanged) {
      const out = scrubEvent({
        exception: { values: [{ type: 'Error', value }] },
        breadcrumbs: [{ category: 'console', message: value }],
      });
      expect(out.exception.values[0].value).toBe(value);
      expect(out.breadcrumbs[0].message).toBe(value);
    }
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

    // Lows: the fallback keeps a handful of harmless scalar top-level fields
    // (useful for GlitchTip grouping/sorting) alongside the redacted
    // exception. Mutation-checked: removing the scalar-field copy loop fails
    // this.
    it('preserves scalar top-level fields (event_id, level, release, ...) in the fallback', () => {
      const event = {
        event_id: 'abc123',
        timestamp: 1700000000,
        level: 'error',
        platform: 'node',
        release: 'abcdef1',
        environment: 'production',
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
        event_id: 'abc123',
        timestamp: 1700000000,
        level: 'error',
        platform: 'node',
        release: 'abcdef1',
        environment: 'production',
        exception: { values: [{ type: 'RangeError', value: '[scrub failed]' }] },
      });
    });

    // Lows: scrubFailureFallback runs only after the primary scrub already
    // threw, so it must not be able to throw itself — a throwing getter on
    // `exception` (the very thing the fallback tries to read) must still
    // produce the constant fallback event rather than escaping uncaught.
    it('never throws even when the exception it tries to preserve also throws', () => {
      const event = {
        get exception(): never {
          throw new Error('exception getter blew up');
        },
        extra: Object.defineProperty({}, 'boom', {
          enumerable: true,
          get(): never {
            throw new Error('extra getter blew up');
          },
        }),
      };
      expect(() => scrubEvent(event)).not.toThrow();
      const out = scrubEvent(event);
      expect(out).toEqual({ exception: { values: [{ type: 'Error', value: '[scrub failed]' }] } });
    });

    // Lows: a malformed breadcrumb entry (null, or any non-object) must be
    // dropped, not sent through dropNetworkBreadcrumb (which reads
    // `.category` and would throw) and take the whole event down the
    // fallback path over one bad array entry. Mutation-checked: removing the
    // non-object filter before the map fails this.
    it('filters out a null or non-object breadcrumb entry instead of throwing', () => {
      expect(() =>
        scrubEvent({
          breadcrumbs: [null, 'not an object', { category: 'console', message: 'hi' }],
        }),
      ).not.toThrow();
      const out = scrubEvent({
        breadcrumbs: [null, 'not an object', { category: 'console', message: 'hi' }],
      });
      expect(out.breadcrumbs).toEqual([{ category: 'console', message: 'hi' }]);
    });
  });

  // M1': the ancestor-only `seen` tracking in deepStripUrls (sentry-options.ts's
  // own URL-stripping walk, separate from lib/log-scrub.ts's deepScrubStrings)
  // needed the same fix — a shared, non-cyclic array reachable twice from
  // unrelated branches must not collapse to "[Circular]" the second time.
  it('walks a shared (non-cyclic) array twice in extra, keeping its content both times', () => {
    const ids = ['a', 'b'];
    const out = scrubEvent({ extra: { ids, again: ids } }) as {
      extra: { ids: unknown; again: unknown };
    };
    expect(out.extra.again).toEqual(['a', 'b']);
    expect(out.extra.ids).toEqual(['a', 'b']);
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

// H1': two regexes were quadratic on adversarial input that never resolves to
// a match: lib/log-scrub.ts's userinfo-password pattern (a long run of
// scheme-charset characters with no "://"), and sentry-options.ts's
// REL_PATH_WITH_QUERY_RE (a long run of relative-path-shaped characters with
// no final "?"). Both ran on every request/log line in production. Each
// adversarial string is run through scrubSecrets directly, and through
// scrubEvent with the string in both an exception's `.value` and a
// breadcrumb's `data` — the two paths the review's probe used to reproduce
// the multi-second stalls (8s / ~5.8s at 100KB, pre-fix). 250ms (not 100ms)
// to absorb CI variance; still three orders of magnitude below the old cost.
// Mutation-checked: reverting either widened lookbehind fails this.
describe('scrubSecrets and scrubEvent stay linear-time on adversarial input', () => {
  const ADVERSARIAL: Record<string, string> = {
    'userinfo pattern (a. repeated)': 'a.'.repeat(50_000),
    'userinfo pattern (a+ repeated)': 'a+'.repeat(50_000),
    'userinfo pattern (a- repeated)': 'a-'.repeat(50_000),
    'relative-path pattern (/a. repeated)': '/a.'.repeat(33_000),
    'relative-path pattern (/a- repeated)': '/a-'.repeat(33_000),
  };
  const BUDGET_MS = 250;

  for (const [label, s] of Object.entries(ADVERSARIAL)) {
    it(`scrubSecrets: ${label}`, () => {
      const t0 = performance.now();
      scrubSecrets(s);
      expect(performance.now() - t0).toBeLessThan(BUDGET_MS);
    });

    it(`scrubEvent exception.value: ${label}`, () => {
      const t0 = performance.now();
      scrubEvent({ exception: { values: [{ type: 'Error', value: s }] } });
      expect(performance.now() - t0).toBeLessThan(BUDGET_MS);
    });

    it(`scrubEvent breadcrumb data: ${label}`, () => {
      const t0 = performance.now();
      scrubEvent({ breadcrumbs: [{ category: 'console', message: 'x', data: { raw: s } }] });
      expect(performance.now() - t0).toBeLessThan(BUDGET_MS);
    });
  }
});
