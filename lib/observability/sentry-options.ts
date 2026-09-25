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
 * real token there. `threads` gets the same treatment as `exception`: it is
 * the same `{ values: [{ stacktrace: { frames } }] }` shape, used instead of
 * `exception` for some non-Error captures.
 */
const SCRUBBED_SECTIONS = [
  'message',
  'logentry',
  'exception',
  'threads',
  'extra',
  'contexts',
  'breadcrumbs',
  'request',
  'tags',
  'transaction',
] as const;

/**
 * Sections where a bare relative path with a query (`/search?q=…`, no host)
 * is also worth stripping, not just an absolute URL: a console breadcrumb
 * ("Failed to fetch RSC payload for /search?q=…"), an exception's own
 * `.value` text, a logged message, and `contexts.nextjs`'s own path fields
 * (`request_path` is already handled explicitly above; `router_path` and any
 * sibling only reach this generic pass). Left off `extra`/`tags`: those carry
 * more varied, less path-shaped content where the pattern is more likely to
 * misfire on something that only looks like a relative path.
 */
const RELATIVE_STRIP_SECTIONS = new Set<(typeof SCRUBBED_SECTIONS)[number]>([
  'message',
  'logentry',
  'exception',
  'threads',
  'contexts',
  'breadcrumbs',
]);

/** Drop a URL's query string and fragment. Query strings carry search terms. */
function stripQuery(url: string): string {
  return url.replace(/[?#].*$/s, '');
}

/**
 * Browser stack frames name their script by full URL (`abs_path`, `filename`),
 * which is the page URL for inline code, query included. Strip it. Server and
 * worker frames are file paths and pass through unchanged. Shared by
 * `exception` and `threads`, which have the same `{ values: [...] }` shape.
 *
 * Frames and values are guarded against `null`/non-object entries: a
 * malformed event must never make this throw (see the try/catch in
 * `scrubEvent` — this is the inner defense, the outer one is the backstop).
 */
function stripFrameQueries(exceptionOrThreads: unknown): unknown {
  const values = (exceptionOrThreads as { values?: unknown } | null)?.values;
  if (!Array.isArray(values)) return exceptionOrThreads;
  return {
    ...(exceptionOrThreads as object),
    values: values.map((value) => {
      if (!value || typeof value !== 'object') return value;
      const frames = (value as { stacktrace?: { frames?: unknown } }).stacktrace?.frames;
      if (!Array.isArray(frames)) return value;
      return {
        ...value,
        stacktrace: {
          ...(value as { stacktrace: object }).stacktrace,
          frames: frames.map((frame: unknown) => {
            if (!frame || typeof frame !== 'object') return frame;
            const f = frame as Record<string, unknown>;
            return {
              ...f,
              ...(typeof f.abs_path === 'string' && { abs_path: stripQuery(f.abs_path) }),
              ...(typeof f.filename === 'string' && { filename: stripQuery(f.filename) }),
            };
          }),
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

/** Keep only `user.id`; drop everything else (email, IP, username). */
function reduceUser(user: unknown): unknown {
  const id = (user as { id?: unknown } | null)?.id;
  return typeof id === 'string' || typeof id === 'number' ? { id } : undefined;
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
 *
 * Also reused inside `scrubEvent` on `event.breadcrumbs`: `beforeBreadcrumb`
 * only runs for breadcrumbs the SDK records live via `addBreadcrumb`. A
 * manually-built or replayed event can arrive with `breadcrumbs` already
 * attached, which skips it entirely.
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
 * lib/log-scrub.ts's PATTERNS mask named secret *shapes* (a Bearer token, a DB
 * password, the two capability-token routes) but say nothing about an
 * ordinary query string: a search term (`?q=my+medication`), a HetrixTools
 * dead-man token (`?s=…`), a Web Push subscription id, a DB password on a
 * `postgresql://`/`wss://`/any-other-scheme URL that isn't the specific
 * userinfo-password shape log-scrub already covers. Those only look like
 * secrets by position, not by shape, so a second pass strips the query and
 * fragment from every URL found in free text, wherever `scrubEvent` walks. In
 * several sections (`stripRelative`), it does the same for a bare relative
 * path with a query — the shape Next's own console messages use ("Failed to
 * fetch RSC payload for /search?q=…").
 *
 * Both patterns are hand-checked for linear-time behaviour (see
 * `scripts`-adjacent probes in the PR that added this comment): a naive
 * `[^\s"'<>)]+`-style class combined with a negative lookbehind of `\w` alone
 * is quadratic on adversarial input (`'a.'.repeat(50_000)` took ~8s against
 * the equivalent shape in lib/log-scrub.ts's userinfo pattern) because the
 * engine retries the lookbehind at every position inside a long run of
 * lookbehind-excluded characters. Widening the lookbehind to also exclude
 * `.`/`-` (the characters that actually appear in the adversarial runs) cuts
 * that retry chain to O(n). ABS_URL_RE separately avoids the same trap by
 * keeping the "does this look like a query" decision unambiguous: the base
 * class excludes `?`/`#` so it can never itself be re-tried as part of the
 * optional query group.
 *
 * ABS_URL_RE's history, in the order these bugs were found and fixed:
 *
 * 1. It once excluded `)'"<>` from the ENTIRE match, which stopped the match
 *    (and therefore the query strip) at the first such character even inside
 *    the query — `?q=(my)medication` left `)medication` after the `(my`
 *    prefix was stripped.
 * 2. Excluding those only from the pre-query part (running the strip to the
 *    next whitespace once a `?`/`#` is seen) fixed that, but went too far the
 *    other way: `\S*` for the query also swallows quotes and brackets that
 *    are structural, not part of the URL — `{"url":"https://h/p?t=SECRET",
 *    "other":"keep"}` lost everything from the `?` to the end of the string,
 *    taking `"other":"keep"}` with it.
 * 3. It also only matched `https?://`, so a `postgresql://`, `ws://`/`wss://`
 *    or any other scheme's query (a password, a token) passed straight
 *    through un-stripped, and a URL inside a wiki-style path with a `(`/`)`
 *    (`https://h/wiki/Foo_(bar)?token=SECRET`) matched nothing at all: the
 *    base class excluded `(` too, so the match stopped short of the `?`.
 *
 * The current shape fixes all three without reopening the quadratic hole:
 * any scheme (`[a-z][a-z0-9+.-]*:\/\/`, guarded by the same widened
 * lookbehind as the userinfo pattern), a base path that excludes only
 * whitespace/`?`/`#` (so parens and quotes in the PATH survive and don't
 * shield a later query), and a query part that excludes whitespace AND
 * `"'<>` (so the query strip stops at the first character that structurally
 * can't be part of a bare URL — closing a quoted JSON string, say — instead
 * of running to the next whitespace regardless).
 */
const ABS_URL_RE = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s?#]*(?:[?#][^\s"'<>]*)?/gi;
const REL_PATH_WITH_QUERY_RE = /(?<![\w:/.-])\/[\w][\w./-]*\?[^\s"'<>)]*/g;

function stripUrlsInText(text: string, stripRelative: boolean): string {
  let out = text.replace(ABS_URL_RE, (m) => stripQuery(m));
  if (stripRelative) out = out.replace(REL_PATH_WITH_QUERY_RE, (m) => stripQuery(m));
  return out;
}

/**
 * Recursively applies `stripUrlsInText` to every string in a value. A
 * separate walk from `lib/log-scrub.ts`'s `deepScrubStrings` (run first, in
 * `scrubEvent`) rather than folded into it: log-scrub's patterns are shared
 * with the Pino path, and an embedded-URL query is a Sentry-event-shape
 * concern, not a log-line one.
 *
 * `seen` tracks the current recursion ANCESTRY, not "every object visited
 * ever": a value is added right before recursing into its children and
 * removed right after, so a true cycle (a value that is its own ancestor)
 * still resolves to `[Circular]`, but the same array or object reachable
 * twice from unrelated branches (`{ ids, again: ids }`) is walked twice and
 * keeps its content both times.
 */
function deepStripUrls(
  value: unknown,
  stripRelative: boolean,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') return stripUrlsInText(value, stripRelative);
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
      return value.map((v) => deepStripUrls(v, stripRelative, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = deepStripUrls(v, stripRelative, seen);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }
  return value;
}

/** Scalar top-level fields worth keeping in the fallback event: none of them
 * carry request/user content, and GlitchTip groups/sorts by several of them. */
const FALLBACK_SCALAR_FIELDS = [
  'event_id',
  'timestamp',
  'level',
  'platform',
  'release',
  'environment',
] as const;

/**
 * scrubEvent must never throw: a scrubber that crashes drops the event (and,
 * worse, could crash the request it was reporting on). On any failure, this
 * is what goes instead — enough to know an error happened and what kind,
 * nothing that risks carrying a secret through an unanticipated shape.
 *
 * `sdk` is deliberately left out rather than validated: it's metadata about
 * the SDK itself, never worth the extra shape-checking to preserve.
 *
 * Wrapped in its own try/catch: this only runs after the primary scrub
 * already threw, so it must not be able to throw itself (a getter on one of
 * the scalar fields, say) and take down the caller a second time.
 */
function scrubFailureFallback(event: unknown): object {
  try {
    const e = event as Record<string, unknown> | null;
    const values = (e?.exception as { values?: unknown } | undefined)?.values;
    const types =
      Array.isArray(values) && values.length > 0
        ? values.map((v) =>
            v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string'
              ? (v as { type: string }).type
              : 'Error',
          )
        : ['Error'];
    const out: Record<string, unknown> = {
      exception: { values: types.map((type) => ({ type, value: '[scrub failed]' })) },
    };
    for (const key of FALLBACK_SCALAR_FIELDS) {
      const v = e?.[key];
      if (typeof v === 'string' || typeof v === 'number') out[key] = v;
    }
    return out;
  } catch {
    return { exception: { values: [{ type: 'Error', value: '[scrub failed]' }] } };
  }
}

function doScrubEvent(event: object): object {
  const out: Record<string, unknown> = { ...(event as Record<string, unknown>) };
  if (out.request !== undefined) out.request = scrubRequest(out.request);
  if (typeof out.transaction === 'string') out.transaction = stripQuery(out.transaction);
  if (out.exception !== undefined) out.exception = stripFrameQueries(out.exception);
  if (out.threads !== undefined) out.threads = stripFrameQueries(out.threads);
  if (out.user !== undefined) {
    const reduced = reduceUser(out.user);
    if (reduced === undefined) delete out.user;
    else out.user = reduced;
  }
  const nextjs = (out.contexts as { nextjs?: Record<string, unknown> } | undefined)?.nextjs;
  if (typeof nextjs?.request_path === 'string') {
    out.contexts = {
      ...(out.contexts as object),
      nextjs: { ...nextjs, request_path: stripQuery(nextjs.request_path) },
    };
  }
  if (Array.isArray(out.breadcrumbs)) {
    out.breadcrumbs = out.breadcrumbs
      // A malformed breadcrumb (null, a string, ...) has no `.category` to
      // read; dropNetworkBreadcrumb would throw on it and send the whole
      // event down the fallback path over one bad array entry.
      .filter((b): b is object => b !== null && typeof b === 'object')
      .map((b) => dropNetworkBreadcrumb(b as { category?: string; data?: unknown }))
      .filter((b): b is NonNullable<typeof b> => b !== null);
  }
  for (const key of SCRUBBED_SECTIONS) {
    if (out[key] === undefined) continue;
    const patternScrubbed = deepScrubStrings(out[key]);
    out[key] = deepStripUrls(patternScrubbed, RELATIVE_STRIP_SECTIONS.has(key));
  }
  return out;
}

/**
 * beforeSend: reduce `request` and `user` to an allowlist, strip query
 * strings from every other place a URL lands (transaction name, nextjs
 * request_path, browser stack frames, free text), drop or de-query embedded
 * breadcrumbs, then apply lib/log-scrub.ts's patterns to every string in the
 * sections above. That is the same scrubbing the logs get, so a DB password
 * in an Error's message, a Bearer token in a breadcrumb or a calendar token
 * in a URL is masked in Sentry exactly as it is in `docker logs`. Never
 * throws: see scrubFailureFallback.
 */
export function scrubEvent<T extends object>(event: T): T {
  try {
    return doScrubEvent(event) as T;
  } catch {
    return scrubFailureFallback(event) as T;
  }
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
 *
 * `frameContextLines` is left at the SDK's own default (5) but stated
 * explicitly, so nothing here is "whatever the SDK currently defaults to".
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
    frameContextLines: 5,
  };
}

export function sentryOptions(dsn: string) {
  return {
    dsn,
    release: APP_GIT_SHA,
    environment: process.env.NODE_ENV,
    // Errors only. No performance tracing.
    tracesSampleRate: 0,
    // Belt and suspenders with beforeSendTransaction below: tracesSampleRate:
    // 0 alone does NOT stop a transaction. The HTTP server instrumentation's
    // sampler honours a remote `sentry-trace: <trace>-<span>-1` parent (an
    // inbound request whose sampled flag is already 1) and creates + sends a
    // transaction regardless of our rate. Reproduced with the real SDK: a
    // request carrying that header produced a transaction envelope with the
    // calendar token in `transaction` and the query in `contexts.trace.data`
    // ("url.full", "http.target", "http.query") — and beforeSend was never
    // called, because it only runs for error events. tracesSampler always
    // returning 0 closes this: it takes precedence over tracesSampleRate
    // (@sentry/core 10.75 options.d.ts) for every span, remote-parent or not.
    tracesSampler: (_samplingContext: unknown) => 0,
    // Backstop in case some future SDK path still forms a transaction despite
    // tracesSampler: transaction events carry the same request/url shape as
    // errors but never reach beforeSend, so drop them outright instead of
    // trying to scrub a shape this module doesn't otherwise handle.
    beforeSendTransaction: (_event: unknown, _hint: unknown) => null,
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
