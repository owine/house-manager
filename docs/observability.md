# Observability

Three signals, all optional. The app runs fine with none of them configured.

1. **Structured logs**: Pino, JSON to stdout, from both web and worker.
2. **Error reports**: a Sentry-compatible endpoint (GlitchTip here), from the web server, the browser and the worker.
3. **Dead-man pings**: the three scheduled jobs that matter GET a HetrixTools Cron Job monitor URL after each run that completes. Silence is the alarm.

Error reports tell you *what* broke. Dead-man pings tell you that *something* stopped, including the failures that never throw: a worker that is down, wedged, or whose cron stopped creating jobs.

## Environment variables

All optional. All read at **runtime** from the container environment. Nothing observability-related is baked into the image, so one image serves every deployment.

| Var | Read by | Purpose | Default |
|---|---|---|---|
| `LOG_LEVEL` | web, worker | Pino level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`). | `info` in prod, `debug` in dev |
| `SENTRY_DSN` | web server, worker | Server-side error reporting. With it unset the SDK is never initialised and every capture is a no-op. | unset |
| `SENTRY_BROWSER_DSN` | web (rendered into the page) | Browser error reporting. The root layout renders it into `<meta name="sentry-browser-dsn">` on each request and `instrumentation-client.ts` reads it. Unset or not an http(s) URL: no browser SDK. May be the same DSN as `SENTRY_DSN`, or a separate browser project. | unset |
| `BACKUP_HEARTBEAT_URL` | worker | Dead-man ping for the nightly backup. See [backups.md § Monitoring](backups.md#monitoring). | unset |
| `REMINDERS_TICK_HEARTBEAT_URL` | worker | Dead-man ping for `reminders.tick`. See [Dead-man monitors](#dead-man-monitors). | unset |
| `SEARCH_REINDEX_HEARTBEAT_URL` | worker | Dead-man ping for `search.reindex`. See [Dead-man monitors](#dead-man-monitors). | unset |

Source-map upload has its own **build-time** settings; see [Source maps](#source-maps-optional).

`NEXT_PUBLIC_SENTRY_DSN` is gone. It was inlined into the bundle at build time, CI never passed it, and the file that read it (`sentry.client.config.ts`) never ran under Turbopack anyway.

## What reaches Sentry

| Source | How | Covers |
|---|---|---|
| Web server | `onRequestError` in `instrumentation.ts` → `Sentry.captureRequestError` | Every error Next.js catches while serving a request: Server Components, route handlers, server actions. Under Turbopack (the default `next build`) this hook is the **only** path for those errors. |
| Browser | `instrumentation-client.ts` | Uncaught errors and unhandled rejections, plus navigation breadcrumbs (`onRouterTransitionStart`). |
| Browser error boundaries | `app/error.tsx`, `app/global-error.tsx` | Errors thrown in the browser. A server-thrown error arrives with a `digest` and is skipped, because `onRequestError` already sent the original. |
| Worker, explicit | `Sentry.captureException` | pg_dump failure, pg-boss `error` events (`lib/queue.ts`), startup failures, inbound-email classify/auto-stub failures. |
| Web + worker, logs | the Pino → Sentry bridge (`lib/observability/error-reporter.ts`) | Any `logger.error(...)` / `logger.fatal(...)` call that carries an `Error`, either `{ err }` or the Error as the first argument. |

**The bridge's rules**, so you can decide what a log line does:

- `error` or `fatal` **with an Error** → one Sentry event, tagged `module` (the child logger's name) and `event` (the line's `event` field), with the message in `extra.logMessage`.
- `warn` and below → never sent. Use `warn` for expected or retryable failures: a Voyage 429 that pg-boss will retry is a blip, not an incident.
- `error` **without an Error** → never sent. `pg-dump` logs safe fields at error level and captures the Error separately; bridging the log line would double-report it.
- An Error that Sentry already captured (the call site did `Sentry.captureException(err)` first) → not sent again. The SDK marks captured errors, and the bridge honours the mark in either order.

**What is not reported:** a pg-boss job handler that throws is retried and then marked `failed` in `pgboss.job`, and nothing reads that state. The dead-man monitors are the backstop for the three jobs where that matters.

## What never reaches Sentry

- **Almost nothing about the request.** `beforeSend` (`scrubEvent` in `lib/observability/sentry-options.ts`) cuts `request` down to an allowlist: the method, the URL **without its query string**, and the browser's `User-Agent` (kept because Sentry derives the browser and OS from it). The body, cookies, every other header (including `Referer`, a full URL) and `query_string` are dropped. Query strings are also stripped from the transaction name and from `contexts.nextjs.request_path`.
- **No transactions, ever.** `tracesSampleRate: 0` alone does not stop one: the HTTP server instrumentation honours a remote `sentry-trace` header whose sampled flag is already `1` and creates a transaction regardless of the configured rate, and `beforeSend` never even runs for transaction events. `tracesSampler: () => 0` plus `beforeSendTransaction: () => null` close both paths, so a sampled header from any caller can't force an unscrubbed transaction through.
- **Incoming bodies are not even buffered.** In 10.75 the HTTP server integration captures incoming request bodies regardless of `dataCollection.httpBodies`, so both server inits pass `httpIntegration({ maxIncomingRequestBodySize: 'none' })`. The `request` allowlist above would drop a body anyway.
- **No user data.** Every `Sentry.init` shares `dataCollection` turned off: no cookies, headers, IP, user info, bodies, query params or local variables. It is set explicitly because `sendDefaultPii` is removed in `@sentry/*` 11, whose default with no `dataCollection` collects all of it. Where a `user` object does reach `beforeSend` it is reduced to `{ id }`: no email, username or IP.
- **No secrets in event text.** `beforeSend` applies the same pattern scrubbing the logs get (`lib/log-scrub.ts`) to the message, exception, extra, contexts, breadcrumbs, request, tags and **transaction**. That masks DB passwords in connection strings, Bearer/Basic tokens, `sk-` API keys, and the capability token in `/api/calendar/<token>` and `/api/inbound-email/<token>`. The transaction matters: the SDK names each request `${method} ${raw path}`, so an error logged inside the inbound webhook would otherwise carry the real token. A second pass strips the query string and fragment off every URL found in those sections' free text, for **any** scheme, not just `http(s)` (a `postgresql://` password, a `wss://` token), and off a bare relative `/path?…` too, in breadcrumbs, exception values, the message and `contexts` — the shape Next's own console messages use ("Failed to fetch RSC payload for /search?q=…"). Neither pattern is named-secret scrubbing: it strips by position (anything after `?`/`#`), not by shape, so it catches query strings that don't look like a known secret pattern.
- **`beforeSend`/`scrubEvent` never throws.** A scrubber crash must not drop the event or crash the request it's reporting on. On any failure it sends a minimal fallback event instead: exception type(s) plus a few scalar fields (`event_id`, `timestamp`, `level`, `platform`, `release`, `environment`), and a `[scrub failed]` placeholder value — nothing that risks carrying a secret through an unanticipated shape.
- **No outgoing-request breadcrumbs, and query-less navigation ones.** `beforeBreadcrumb` drops `http`/`fetch`/`xhr` breadcrumbs, whose URLs carry credentials no pattern can recognise (dead-man tokens, Web Push endpoints). It keeps the browser's `navigation` breadcrumbs but strips the query from their `from`/`to`: search terms travel as `?q=`.
- **No query strings in browser stack frames.** Inline browser code is attributed to the page URL; `scrubEvent` strips the query from each frame's `abs_path`/`filename`.
- **No trace headers on outgoing requests.** `tracePropagationTargets: []`. Without it the SDK adds `sentry-trace` and `baggage` (which includes the DSN's public key) to every outgoing call, to Voyage, Anthropic, ForwardEmail, Web Push and the monitors, even at `tracesSampleRate: 0`.

**What does still reach Sentry: PII embedded in an error's own message.** Scrubbing here is the same posture as the logs (`lib/log-scrub.ts`): it masks secret-*shaped* strings (tokens, connection-string passwords, API keys) and query strings, not arbitrary personal data. A Prisma validation error, for example, prints the call's arguments in its message — names, IDs, whatever was passed — and none of that is scrubbed, because it isn't secret-shaped. Don't rely on this pipeline to keep PII out of GlitchTip; keep it out of error messages instead.

## Dead-man monitors

A job with a heartbeat URL GETs it after every run that **completes**. A run that throws sends nothing (pg-boss retries it), so the monitor goes down by silence. The ping itself is fail-soft: a monitor outage never fails the job. It logs `<job>.heartbeat.failed` with the HTTP status, or the error's name and cause code, and never the URL. The URL's `?s=` token is the secret: anyone holding it can mark the job healthy.

The monitors are HetrixTools **Cron Job monitors** (its heartbeat type). Each generates a unique URL of the form `https://sm.hetrixtools.net/hb/?s=<token>` and goes DOWN, and notifies, when that URL isn't accessed within its **Timeout** (advanced settings, in minutes). HetrixTools' own examples ping with `curl`/`wget`; the jobs send a plain GET with a 10-second timeout.

| Job | Env var | Runs | HetrixTools Timeout |
|---|---|---|---|
| `pg-dump` | `BACKUP_HEARTBEAT_URL` | daily 03:00 UTC | 1 day + 60 min grace |
| `reminders.tick` | `REMINDERS_TICK_HEARTBEAT_URL` | every 5 min | ≈15 min total, smallest Timeout + grace (three missed ticks) |
| `search.reindex` | `SEARCH_REINDEX_HEARTBEAT_URL` | daily 03:00 UTC | 1 day + 60 min grace |

The monitor form offers a preset **Timeout** plus a **Grace period**; the column above is their sum. Never total less than 24 hours on a daily job, or it pages every day.

What a ping proves: for `pg-dump`, a dump that passed validation; for `reminders.tick`, a tick that ran to the end; for `search.reindex`, a rebuild **submitted** to Meilisearch without throwing. The job returns once Meilisearch has accepted its tasks and does not wait for them to be processed, so a green monitor does not mean the index is populated.

Only the scheduled runs ping. The worker's startup missed-tick recovery calls the reminders tick directly and does **not** ping, so a cron that has stopped firing cannot be hidden by the worker restarting.

To add one: in HetrixTools add a **Cron Job monitor**, set its Timeout per the table, copy its URL, set it on the **worker** container, and recreate the worker. HetrixTools is a hosted service, so the worker needs outbound HTTPS to `sm.hetrixtools.net`.

The monitors a deployment should have:

- web: a HetrixTools HTTP monitor on the public `/api/health`
- worker: the three Cron Job monitors above. They double as the worker's liveness signal: a dead, wedged or crash-looping worker stops every ping, and `reminders.tick` goes DOWN within 15 minutes. (Docker only probes running containers, so a crash loop never reports `unhealthy`; an outside monitor that waits for a ping is what catches it.)

## Setting up GlitchTip

1. Run GlitchTip (`glitchtip/glitchtip` plus a Postgres sidecar).
2. Create a project for the server side (web server + worker) and, if you want browser errors grouped separately, a second one for the browser. Copy the DSNs.
3. Set `SENTRY_DSN` on **both** web and worker, and `SENTRY_BROWSER_DSN` on **web**. The same DSN works for both if you only made one project.
4. Recreate the containers (`docker compose up -d`; `docker restart` keeps the old environment).
5. Check the worker end to end (it sends one event, then exits):

   ```bash
   docker exec housemanager-worker node_modules/.bin/tsx -e "import('./worker/sentry').then(async (s) => { s.initWorkerSentry(); const { getLogger } = await import('./lib/logger'); getLogger('smoke').error({ err: new Error('house-manager worker Sentry smoke test') }, 'sentry smoke'); await s.flushSentry(); })"
   ```

6. Check the browser: sign in, confirm the page source has `<meta name="sentry-browser-dsn" …>`, then run `setTimeout(() => { throw new Error('house-manager browser Sentry smoke test') })` in the devtools console. A throw typed straight into the console is not reported; one from a timer is.

## Browser bundle cost

`instrumentation-client.ts` imports `@sentry/nextjs` statically, as Sentry documents. That is roughly a 370 KB (uncompressed) chunk on every full page load, **even with no DSN set**. `tracesSampleRate: 0` turns tracing off at runtime but does not remove `browserTracingIntegration` from the bundle. A dynamic import only when the meta is present would avoid the cost, but the Next docs make async work in this file fire-and-forget, so errors during hydration would be lost. Revisit if page weight matters more than early errors.

The release comes from `lib/git-sha.ts`, not `lib/version.ts`, so the browser bundle never depends on `package.json`.

## Source maps (optional)

Without source maps, browser stack traces point into minified chunks. Server and worker traces are already readable.

Upload runs inside `next build`, and only when a token is present:

| Build input | Kind | Purpose |
|---|---|---|
| `SENTRY_AUTH_TOKEN` | buildkit **secret** (`--secret id=sentry_auth_token,…`) | Write token. Never an ARG, so never in image history. |
| `SENTRY_ORG`, `SENTRY_PROJECT` | build-arg | Where to upload (the browser project). |
| `SENTRY_URL` | build-arg | GlitchTip's base URL. Unset means sentry.io. |

CI passes the three identifiers from repository **variables** and the token from the repository **secret** `SENTRY_AUTH_TOKEN`, on `main` only. Any of them unset → no upload, and the build is otherwise unchanged. Either way the maps are deleted after the upload step, so none ship in the image (`scripts/smoke-image.sh` checks).

Local equivalent:

```bash
docker build --secret id=sentry_auth_token,src=/path/to/token \
  --build-arg SENTRY_ORG=… --build-arg SENTRY_PROJECT=… --build-arg SENTRY_URL=https://glitchtip.example .
```

## Reading logs in dev

`pnpm dev` emits raw JSON. For human-readable colors:

```bash
pnpm dev | pnpm exec pino-pretty
```

(Don't bake this into `pnpm dev` itself — it breaks `pnpm dev | grep ...` patterns and adds a process to manage.)

## Reading logs in prod

```bash
docker logs <container>           # all logs
docker logs <container> --since 1h # recent logs
docker logs <container> | jq .    # parse JSON
```

Logs live only as long as the container: every deploy recreates it. For querying and retention, ship `docker logs` to Loki via Promtail. That's homelab work, separate from this app.

## Naming conventions

Each module gets a child logger with a dot-separated module name mirroring its file location (dropping the `lib/` prefix):

| File | Logger module |
|---|---|
| `lib/ai/suggest/reminders.ts` | `ai.suggest.reminders` |
| `lib/ai/suggest/checklist.ts` | `ai.suggest.checklist` |
| `lib/queue.ts` | `queue` |
| `lib/search/client.ts` | `search.client` |
| `lib/attachments/actions.ts` | `attachments.actions` |
| `worker/index.ts` | `worker.lifecycle` |
| `worker/jobs/thumbnail.ts` | `worker.thumbnail` |

This makes Loki/Grafana queries trivial later: `{module=~"ai.suggest.*"}` returns every Suggest event. The same name is the `module` tag on bridged Sentry events.

## Redaction

Two layers, both in `lib/logger.ts`:

- `redact` blanks known sensitive **keys** (`apiKey`, `token`, `secret`, `password`, `databaseUrl`, `connectionString`, the access/refresh/session tokens, `DATABASE_URL`, and the cookie and authorization request headers), top level and one level nested.
- `lib/log-scrub.ts` masks secrets embedded in string **values** anywhere in the line, including an Error's message and stack.

A logged `err` keeps its `type`, `message`, `stack`, `cause` and custom fields (scrubbed), and when a call passes no message (`logger.error({ err })`), the `msg` pino derives from `err.message` is scrubbed too. Add new sensitive key names to `lib/logger.ts` and new value patterns to `lib/log-scrub.ts` — a new pattern must stay linear-time (a naive character-class-plus-lookbehind combination can go quadratic on adversarial input; the timing tests in `lib/log-scrub.test.ts` guard this). Sentry's `beforeSend` uses the same patterns, so both outputs stay in step.

## Upgrading to `@sentry/*` 11

Checked against the 11.0.0 tarballs:

- `withSentryConfig` is imported from `@sentry/nextjs/config` (the bare import is removed in 11).
- `sendDefaultPii` is not used. The explicit `dataCollection` keeps 11's collect-everything default out.
- `worker/sentry.test.ts` asserts the `__sentry_captured__` flag the bridge relies on, so a rename fails CI rather than doubling events.
- `buildTimeInstrumentation` defaults to `true` in 11 (build-time instrumentation of server dependencies). Run `pnpm build` and the image smoke test on the bump PR before merging.
- `httpIntegration({ maxIncomingRequestBodySize: 'none' })` stops type-checking: 11 renames the option (`maxRequestBodySize`) and gates body capture on `dataCollection.httpBodies`, which is already `[]`. Delete the option (or rename it) on the bump PR; `scrubEvent` drops `request.data` either way.
