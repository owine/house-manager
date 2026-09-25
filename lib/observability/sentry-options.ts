import { APP_GIT_SHA } from '@/lib/git-sha';
import { deepScrubStrings } from '@/lib/log-scrub';

// The one Sentry.init() option set, shared by all four inits: web server
// (instrumentation.ts, nodejs + edge), browser (instrumentation-client.ts) and
// worker (worker/sentry.ts). SDK-free on purpose (no @sentry/* import, types
// included) so the browser bundle doesn't pull @sentry/node and the worker
// doesn't pull @sentry/nextjs. The shapes below are structural subsets of the
// SDK's own option types; tsc checks them at each Sentry.init() call site.

/**
 * Event sections that can carry user data or secrets. Only these are walked;
 * the rest of the event (sdkProcessingMetadata in particular, which holds live
 * Scope objects the SDK still needs) is passed through untouched.
 *
 * `transaction` is on the list because the SDK's HTTP server instrumentation
 * names each request's scope `${method} ${raw path}` (server-subscription.js
 * in @sentry/core 10.75), so any event captured inside a request, such as a
 * bridged log line from app/api/inbound-email/[token]/route.ts, carries the
 * real token there.
 */
const SCRUBBED_SECTIONS = [
  'message',
  'logentry',
  'exception',
  'extra',
  'contexts',
  'breadcrumbs',
  'request',
  'tags',
  'transaction',
] as const;

/** Drop a URL's query string and fragment. Query strings carry search terms. */
function stripQuery(url: string): string {
  return url.replace(/[?#].*$/s, '');
}

/**
 * Browser stack frames name their script by full URL (`abs_path`, `filename`),
 * which is the page URL for inline code, query included. Strip it. Server and
 * worker frames are file paths and pass through unchanged.
 */
function stripFrameQueries(exception: unknown): unknown {
  const values = (exception as { values?: unknown } | null)?.values;
  if (!Array.isArray(values)) return exception;
  return {
    ...(exception as object),
    values: values.map((value) => {
      const frames = (value as { stacktrace?: { frames?: unknown } })?.stacktrace?.frames;
      if (!Array.isArray(frames)) return value;
      return {
        ...value,
        stacktrace: {
          ...value.stacktrace,
          frames: frames.map((frame: Record<string, unknown>) => ({
            ...frame,
            ...(typeof frame.abs_path === 'string' && { abs_path: stripQuery(frame.abs_path) }),
            ...(typeof frame.filename === 'string' && { filename: stripQuery(frame.filename) }),
          })),
        },
      };
    }),
  };
}

/**
 * Keep only what locates an error in the request: method, the URL without its
 * query, and the browser's User-Agent (Sentry derives browser and OS from it).
 * Everything else goes: body (`data`: in 10.75 the HTTP integration captures
 * incoming bodies regardless of `dataCollection.httpBodies`), cookies, other
 * headers (Referer is a full URL), `query_string`, `env`.
 */
function scrubRequest(request: unknown): unknown {
  if (request === null || typeof request !== 'object') return request;
  const { method, url, headers } = request as {
    method?: unknown;
    url?: unknown;
    headers?: Record<string, unknown>;
  };
  const out: Record<string, unknown> = {};
  if (typeof method === 'string') out.method = method;
  if (typeof url === 'string') out.url = stripQuery(url);
  const userAgent = Object.entries(headers ?? {}).find(
    ([name]) => name.toLowerCase() === 'user-agent',
  )?.[1];
  if (typeof userAgent === 'string') out.headers = { 'User-Agent': userAgent };
  return out;
}

/**
 * beforeSend: reduce `request` to an allowlist, strip query strings from the
 * two other places a request URL lands, then apply lib/log-scrub.ts's patterns
 * to every string in the sections above. That is the same scrubbing the logs
 * get, so a DB password in an Error's message, a Bearer token in a breadcrumb
 * or a calendar token in a URL is masked in Sentry exactly as it is in
 * `docker logs`.
 */
export function scrubEvent<T extends object>(event: T): T {
  const out: Record<string, unknown> = { ...(event as Record<string, unknown>) };
  if (out.request !== undefined) out.request = scrubRequest(out.request);
  if (typeof out.transaction === 'string') out.transaction = stripQuery(out.transaction);
  if (out.exception !== undefined) out.exception = stripFrameQueries(out.exception);
  const nextjs = (out.contexts as { nextjs?: Record<string, unknown> } | undefined)?.nextjs;
  if (typeof nextjs?.request_path === 'string') {
    out.contexts = {
      ...(out.contexts as object),
      nextjs: { ...nextjs, request_path: stripQuery(nextjs.request_path) },
    };
  }
  for (const key of SCRUBBED_SECTIONS) {
    if (out[key] !== undefined) out[key] = deepScrubStrings(out[key]);
  }
  return out as T;
}

const NETWORK_CATEGORIES = new Set(['http', 'fetch', 'xhr']);

/**
 * beforeBreadcrumb: drop outgoing-request breadcrumbs, and strip the query
 * from navigation ones.
 *
 * Outgoing-request breadcrumbs carry the full URL in `data.url`, and several
 * carry a credential in the path or query that no pattern can recognise: the
 * dead-man push tokens (lib/heartbeat-ping.ts), Web Push endpoints, the
 * calendar feed. The browser's `navigation` breadcrumbs carry path + query in
 * `data.from`/`data.to` (@sentry/browser breadcrumbs.js), and search terms
 * travel in the query (`?q=`, lib/url-params.ts). What remains (console, the
 * query-less navigation trail, UI clicks) is enough context for an error.
 */
export function dropNetworkBreadcrumb<T extends { category?: string; data?: unknown }>(
  breadcrumb: T,
): T | null {
  if (breadcrumb.category && NETWORK_CATEGORIES.has(breadcrumb.category)) return null;
  if (
    breadcrumb.category === 'navigation' &&
    breadcrumb.data &&
    typeof breadcrumb.data === 'object'
  ) {
    // Two explicit assignments, not a loop over a ['from', 'to'] literal:
    // scripts/worker-graph.mjs finds imports with a regex, and a string
    // literal right after the word `from` reads to it as an import specifier.
    const data = { ...(breadcrumb.data as { from?: unknown; to?: unknown }) };
    if (typeof data.from === 'string') data.from = stripQuery(data.from);
    if (typeof data.to === 'string') data.to = stripQuery(data.to);
    return { ...breadcrumb, data };
  }
  return breadcrumb;
}

/**
 * Collect nothing about the user or the request beyond what an error needs.
 *
 * Set explicitly rather than relying on `sendDefaultPii: false`: that option
 * is deprecated in 10.x and REMOVED in @sentry/* 11, and 11's defaults with
 * no `dataCollection` turn every category ON (cookies, headers, IP, bodies:
 * `resolveDataCollectionOptions` in @sentry/core 11.0.0). Setting it now means
 * the Renovate major bump cannot quietly start shipping session cookies.
 * In 10.75 a set `dataCollection` already takes precedence over sendDefaultPii.
 * A fresh object per call: the SDK keeps a reference.
 */
function dataCollection() {
  return {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    graphQL: { document: false, variables: false },
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    stackFrameVariables: false,
  };
}

export function sentryOptions(dsn: string) {
  return {
    dsn,
    release: APP_GIT_SHA,
    environment: process.env.NODE_ENV,
    // Errors only. No performance tracing.
    tracesSampleRate: 0,
    // Never attach sentry-trace / baggage headers to outgoing requests. The
    // HTTP integration propagates them even at tracesSampleRate 0, and baggage
    // carries the DSN's public key to every API this app calls (Voyage,
    // Anthropic, ForwardEmail, Web Push, the dead-man monitors).
    tracePropagationTargets: [],
    dataCollection: dataCollection(),
    beforeSend: scrubEvent,
    beforeBreadcrumb: dropNetworkBreadcrumb,
  };
}

/** `<meta name>` the root layout uses to hand the browser its DSN at runtime. */
export const BROWSER_DSN_META = 'sentry-browser-dsn';
