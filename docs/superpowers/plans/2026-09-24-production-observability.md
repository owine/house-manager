# Production Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn production error reporting on, without leaking what it reports. Today a Server Component, route handler or server action error, every browser error, and every `logger.error({ err })` reaches nobody. After this PR: `onRequestError` reports server errors; the browser SDK actually starts (Turbopack-era `instrumentation-client.ts`, DSN read at runtime so one image serves every deployment); a Pino → Sentry bridge reports error-level logs that carry an Error, without double-reporting; and every event is cut down to an allowlist and scrubbed with the same patterns as the logs: no bodies, no query strings (request, transaction, navigation breadcrumbs, browser stack frames), no tokens in URLs or transaction names, no trace headers on outgoing calls. The dead-man monitors move from uptime-kuma to HetrixTools (owner decision, 2026-09-25).

**Architecture:** All Sentry option shape lives SDK-free in `lib/observability/`: `sentry-options.ts` (`dataCollection` off, `tracePropagationTargets: []`, `beforeSend` = request allowlist + query stripping incl. browser frame paths + `lib/log-scrub.ts` patterns, `beforeBreadcrumb` = drop network crumbs, strip navigation queries) and `error-reporter.ts` (the bridge). `lib/logger.ts`'s existing `hooks.logMethod` hands error/fatal calls to the bridge, which forwards the Error to a reporter that each SDK registers at init through a `globalThis` seam: `@sentry/node` in `worker/sentry.ts`, `@sentry/nextjs` in `instrumentation.ts`. Both server inits turn off incoming body capture in the HTTP integration (web also keeps `@sentry/nextjs`'s `disableIncomingRequestSpans`, which a custom `httpIntegration` would otherwise drop). The browser gets its DSN from a `<meta>` the root layout renders from the server's env per request, and its release from `lib/git-sha.ts` (no `package.json` in the client graph). Source maps upload only when CI has a token (main only), and never ship.

**Tech Stack:** Next.js 16.3.5 (App Router, Turbopack `next build`, `output: 'standalone'`), `@sentry/nextjs` 10.75.0 (web) + `@sentry/node` 10.75.0 (worker), Pino 10.3.1, pg-boss 12 worker under tsx, Zod, Vitest 5.0.1 (+ jsdom, Testing Library), Docker buildx + GitHub Actions, GlitchTip.

**Source findings:** `.full-review/05-final-report.md` (P1 "Production error reporting is effectively off"), `.full-review/04-best-practices.md` (cross-phase cluster), `.full-review/04a-best-practices.md` (BP-H1), `.full-review/04b-cicd-devops.md` (O-M6), `.full-review/03b-documentation.md` (DOC-M2, plus DOC-L2 in passing). **Built on** `2026-09-24-logging-and-heartbeats.md`, merged as #509 (`main` @ `60df852`). It fixed the logger (errors serialize, derived `msg` scrubbed, token routes masked), the `test:unit` scope and the dead-man pings.

---

> **Execution notes (2026-09-25).** Task 2 went through three Opus review rounds; the shipped
> `lib/observability/sentry-options.ts` does more than the Task 2 text below:
> - **Transactions are never sent** (`tracesSampler: () => 0` + `beforeSendTransaction: () => null`).
>   A sampled `sentry-trace` header from any caller forced an unscrubbed transaction (token, query,
>   client IP) even at `tracesSampleRate: 0`; reproduced with the real SDK. Task 10's envelope check
>   gained a sampled-parent request to prove it.
> - Query strings and fragments are stripped from URLs of **any scheme** inside free text
>   (exception values, messages, contexts, breadcrumbs), plus relative `/path?…`.
> - `user` is reduced to `{ id }`; breadcrumbs on the event are re-filtered; `threads` are scrubbed;
>   the scrubber never throws (minimal fallback event).
> - **Pre-existing ReDoS fixed** in `lib/log-scrub.ts`: the userinfo pattern was quadratic
>   (100 KB of `a.a.a…` blocked the event loop ~8 s per log line). Linear now, with timing tests.
> - `deepScrubStrings` tracks ancestors only, so a shared (non-cyclic) array or object keeps its
>   content instead of logging as `"[Circular]"`; true cycles still do.
> - HetrixTools' form is preset Timeout + Grace period; the text below was updated to match.
> - Task 11 row 7 (`stripFrameQueries`) went vacuous once the free-text pass existed; a scheme-less
>   frame now pins it.


## Background the implementer needs

**Findings verified against the code (`main` @ `60df852`, i.e. #509 merged):**

- **BP-H1 is correct.** `next build` is Turbopack (CI log: `▲ Next.js 16.3.5 (Turbopack)`; `package.json` has no `--webpack`). In `@sentry/nextjs` 10.75.0 only `build/cjs/config/webpack.js` loads `sentry.client.config.ts`; the Turbopack value-injection rule matches only `**/instrumentation-client.*` (`config/turbopack/generateValueInjectionRules.js:36`). So the browser SDK never starts and `app/global-error.tsx`'s `captureException` goes nowhere. `instrumentation.ts` exports no `onRequestError`, so Server Component, route handler and server action errors are unreported (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md`, "onRequestError"). `@sentry/nextjs` exports `captureRequestError` and `captureRouterTransitionStart` (`build/types/index.types.d.ts:99`, `build/types/client/index.d.ts:8`).
- **O-M6 is correct.** CI passes only `GIT_SHA` (`.github/workflows/ci.yml:548-549`, and again at `:569-570` for the smoke-test load). `withSentryConfig` is imported from `@sentry/nextjs`, which 10.75 already warns "will stop working in v11". `SENTRY_ORG`/`SENTRY_PROJECT` never reach the Docker build either, so a token alone would not have uploaded anything.
- **DOC-M2 is correct.** No Pino → Sentry path exists. The false claims are at `worker/jobs/embed-content.ts:22-24` and `:55-57`, `worker/index.ts:213-215`, `lib/observability/memory-watchdog.ts:15`.

**Privacy findings (the reason several pieces below exist):**

1. **Tokens in transaction names.** The SDK's HTTP server instrumentation names every request's isolation scope `${method} ${raw path}` (`@sentry/core` 10.75 `build/cjs/integrations/http/server-subscription.js`, `bestEffortTransactionName`). An error bridged from inside `app/api/inbound-email/[token]/route.ts` (`:95`, `:108`) therefore carried the real token in `transaction`. Reproduced end to end (see "How the code was checked"): `"transaction":"POST /api/inbound-email/<real token>"` before the fix, `…/***` after.
2. **Request bodies.** In 10.75 `dataCollection.httpBodies: []` does **not** stop incoming body capture: `server-subscription.js` gates on the HTTP integration's `maxRequestBodySize` (default `'medium'`), and `requestdata.js` attaches whatever was buffered at read time. (11 gates it on `dataCollection` instead.) The end-to-end run did not observe a body on the Next.js route path, but the source says it can happen, so both server inits pass `httpIntegration({ maxIncomingRequestBodySize: 'none' })` (the option name is from the installed `@sentry/node` types) and `scrubEvent` drops `request.data` regardless.
3. **Query strings.** `dataCollection.urlQueryParams: false` did not stop `request.url` and `contexts.nextjs.request_path` keeping `?q=…` (reproduced). `scrubEvent` strips the query and fragment from both, and from the transaction.
4. **Trace headers on outgoing calls.** Even at `tracesSampleRate: 0`, the SDK adds `sentry-trace` and `baggage` (with `sentry-public_key`) to outgoing `fetch` and `http` requests. Reproduced with the real SDK against a local echo server; `tracePropagationTargets: []` removes both (Task 10 Step 5 repeats the probe).
5. **Browser navigation breadcrumbs and stack frames carry query strings.** `@sentry/browser` 10.75 records every navigation as `data: { from, to }` with path + query (`build/npm/cjs/dev/integrations/breadcrumbs.js`, the `navigation` category), and search terms travel in the query (`components/search/SearchBar.tsx`, `lib/url-params.ts` `q`). Inline browser code is attributed to the page URL in `abs_path`/`filename`. `beforeBreadcrumb` and `scrubEvent` strip both.
6. **A custom web `httpIntegration` silently drops a `@sentry/nextjs` default.** `@sentry/nextjs`'s server init registers `httpIntegration({ disableIncomingRequestSpans: true })` (`build/cjs/server/index.js`), because Next creates its own request spans. Passing our own `httpIntegration` replaces it, so web passes `disableIncomingRequestSpans: true` itself. The worker has no Next spans and keeps the default.
7. **`@sentry/*` 11 would silently start collecting cookies, headers, IPs and bodies.** 11 removes `sendDefaultPii`, and its `resolveDataCollectionOptions` (`@sentry/core` 11.0.0) defaults every category to **on** when `dataCollection` is absent. In 10.75 a set `dataCollection` already takes precedence over `sendDefaultPii`, so this plan sets it explicitly and drops `sendDefaultPii`.

**Other findings made while planning (fixed here):**

- **`lint:worker-graph` finds imports with a regex** (`scripts/worker-graph.mjs`), and a string literal right after the word `from` reads to it as an import specifier. A first draft of the breadcrumb filter looped over `['from', 'to']` and failed the lint with `imports ,   (undeclared)`. The code below uses two explicit assignments and says why.

- **The worker reports `release: 'dev'` in production.** `lib/version.ts` reads `NEXT_PUBLIC_GIT_SHA`, which is a build-stage ENV that Next inlines into the web bundles. The worker runs source under tsx and only has the runtime stage's `GIT_SHA` (`Dockerfile:154-155`). New `lib/git-sha.ts` falls back to `GIT_SHA`. It lives in this plan because the release is only ever consumed by Sentry here. `lib/version.ts` keeps re-exporting it for the footer and `/api/health`.
- **The worker's fatal-startup and failed-shutdown events are dropped.** Both paths call `process.exit(1)` straight after capturing or logging. Capture only queues, so the event never leaves. Both now `await flushSentry()` first.
- **Error boundaries would double-report server errors.** A server-thrown error reaches `error.tsx`/`global-error.tsx` as a redacted copy with a `digest`. Once `onRequestError` exists, capturing that copy in the browser as well would be a second event.

**Corrections to the review's recommendations:**

- BP-H1's fix snippet keeps `sendDefaultPii: false`, which is deprecated in 10.75 and gone in 11 (privacy finding 5).
- BP-H1 suggests replacing `webpack.treeshake.removeDebugLogging` with "Sentry's bundler-agnostic option". `bundleSizeOptimizations.excludeDebugStatements` is **also** webpack-only in 10.75: only `config/webpack.js:571` defines `__SENTRY_DEBUG__`. The block is dropped.
- DOC-M2 option (b), `Sentry.pinoIntegration()`, is rejected. Per `@sentry/node-core/build/cjs/integrations/pino.js`, it `captureMessage`s every error-level line without an `err` (so `pg-dump`'s "log safe fields, capture the Error" becomes two events), it hands the SDK the raw log object, and it instruments every logger by default.
- BP-H1 rates the source-map deletion in token-less builds "PLAUSIBLE". Verified: the current `house-manager:dev` image has 0 `.map` files under `/app/web/.next/static`, and so does a token-less build of this plan. A smoke-test assertion now keeps it that way.
- The plan review's claim that `lib/version.ts` ships all of `package.json` to the browser does not hold for the production build: Turbopack tree-shakes it (`packageManager`, `engines`, script names: 0 hits in `.next/static`). The client still imports `lib/git-sha.ts` instead, so this doesn't rest on tree-shaking.

**How the code below was checked.** Everything was applied, as the "replace this" steps below describe, to a scratch copy of `main` @ `60df852` (`git archive`), with its **own** `pnpm install --frozen-lockfile` and `pnpm db:generate`:

- `tsc --noEmit` clean; `biome check .` clean (673 files); `lint:worker-graph`, `lint:tokens` OK; knip clean apart from one scratch-only artifact (`lefthook` "unused", because the copy has no `.git`).
- `vitest run tests/unit lib worker/ components app/`: 128 files, 1500 tests pass. Integration: `reminders-tick`, `search-reindex`, `missed-tick-recovery`, `pg-dump-restore`, `health` (5 files, 23 tests) pass. `actionlint` shows only the pre-existing `SC2016:info`.
- `next build` (Turbopack) succeeds, with no `turbopack.root` hack now that the copy has real `node_modules`. The page-loaded client chunk contains the `sentry-browser-dsn` reader, 0 `.map` files ship, `package.json` content appears in no client chunk, and a build with every `SENTRY_*` build input set to an empty string is also clean.
- **End to end** (Task 10 Step 4's script, verbatim): `next start` with `SENTRY_DSN` pointing at a local envelope listener and `DATABASE_URL` at a closed port.
  - A `GET /api/calendar/<token>.ics?q=…` with a session cookie and a Bearer header produced 1 event via `onRequestError`.
  - A signed `POST /api/inbound-email/<token>?q=…` with a canary in the body made the route log `{ err }`, which produced 1 event via the bridge (`tags.source: pino`, `module: inbound-email`).
  - Result: `transaction` `GET /api/calendar/***` and `POST /api/inbound-email/***`; `url` query-less and masked; **0** occurrences of either token, the cookie, the Bearer value, the query canary or the body canary.
  - Before the fixes, the inbound token appeared once (in `transaction`) and the query canary twice.
- Propagation probe (Task 10 Step 5): the default options sent `sentry-trace` + `baggage` on both `fetch` and `http.get`; with `tracePropagationTargets: []`, neither.
- **Mutation checks**, each against the named test file(s):

  | Mutation | Result |
  |---|---|
  | bridge ignores the `__sentry_captured__` mark | 1 fail (`error-reporter.test.ts`) |
  | bridge reports error lines without an Error | 2 fail (`error-reporter.test.ts`, `worker/sentry.test.ts`) |
  | bridge wraps the Error in a new one | 1 fail (`worker/sentry.test.ts`, log-then-capture order) |
  | `transaction` removed from `SCRUBBED_SECTIONS` | 1 fail (`sentry-options.test.ts`) |
  | no query stripping on `transaction` | 1 fail (`sentry-options.test.ts`) |
  | no `request` allowlist | 1 fail (`sentry-options.test.ts`) |
  | `tracePropagationTargets` removed | 1 fail (`sentry-options.test.ts`) |
  | navigation breadcrumbs passed through unchanged | 1 fail (`sentry-options.test.ts`) |
  | no query stripping on browser frame paths | 1 fail (`sentry-options.test.ts`) |
  | `graphQL` collection left on | 1 fail (`sentry-options.test.ts`) |
  | web `httpIntegration` without `disableIncomingRequestSpans` | 1 fail (`instrumentation.test.ts`) |
  | `sendDefaultPii` back in the options | 2 fail (`sentry-options.test.ts`, `instrumentation.test.ts`) |
  | web `httpIntegration` body option removed | 1 fail (`instrumentation.test.ts`) |
  | worker `httpIntegration` removed | 1 fail (`worker/sentry.test.ts`) |
  | `onRequestError` stops forwarding | 1 fail (`instrumentation.test.ts`) |
  | no `GIT_SHA` fallback | 1 fail (`lib/git-sha.test.ts`) |
  | embed retryable failure logged at error | 1 fail (`embed-content.test.ts`) |
  | error boundary without the digest check | 1 fail (`app/error.test.tsx`) |

**Design decisions (double-check these):**

1. **Browser DSN at runtime, not build time.** The root layout reads `SENTRY_BROWSER_DSN` from the server env on each request and renders `<meta name="sentry-browser-dsn">`; `instrumentation-client.ts` reads the meta before hydration. Why not a `NEXT_PUBLIC_` build-arg: one image then works for every deployment, PR smoke builds and local compose alike; rotating the DSN needs no rebuild; and the DSN stays out of public CI logs and repo config. It works with standalone output because every page under `(app)/` is dynamic (`auth()`), so the root layout renders per request. The cost: prerendered pages (not-found) are rendered at build time with no DSN, so they run without browser reporting. Next's own async `<script>` tags sit in `<head>` **before** the layout's head children (checked in the built HTML), so `instrumentation-client.ts` falls back to `DOMContentLoaded` if the meta isn't parsed yet.
2. **A separate `SENTRY_BROWSER_DSN`**, which may hold the same value as `SENTRY_DSN`. Handing a DSN to every browser should be a deliberate choice, and GlitchTip groups best with separate server and browser projects. It is **not** in the `lib/env.ts` schema. It is soft-validated (`lib/observability/browser-dsn.ts`), so a typo turns browser reporting off instead of failing `getEnv()` in every server action and in the worker.
3. **Custom bridge in `hooks.logMethod`, reporter on `globalThis`** (`Symbol.for('house-manager.error-reporter')`). Next bundles `instrumentation.ts` separately from route chunks, so a module-level variable would be invisible across copies. `lib/` imports no Sentry SDK.
4. **Bridge scope: `error`/`fatal` with an Error only.** `warn` is never bridged, so `embed-content`'s *retryable* failures move from `error` to `warn`. Error lines without an Error are not bridged (the `pg-dump` pattern).
5. **No double reports.** The SDK marks captured Errors (`__sentry_captured__`, `checkOrSetAlreadyCaught` in `@sentry/core` 10.75 and 11.0.0). The bridge skips marked errors and passes the **same** object on, so either order yields one event. `worker/sentry.test.ts` proves both orders with the real SDK and pins the flag.
6. **`beforeSend` is an allowlist for `request`, a pattern scrub for text.** `request` keeps only `method`, the query-less `url` and `User-Agent` (Sentry derives browser and OS from it; `Referer` is a full URL, so it goes). Query strings are stripped from `request.url`, `transaction` and `contexts.nextjs.request_path`. Then `lib/log-scrub.ts`'s patterns run over `message`, `logentry`, `exception`, `extra`, `contexts`, `breadcrumbs`, `request`, `tags` and `transaction`. Only those sections are walked, because a whole-event walk would clone `sdkProcessingMetadata`'s live Scope objects.
7. **Outgoing-request breadcrumbs are dropped** (`http`, `fetch`, `xhr`): their URLs carry dead-man tokens and Web Push endpoints. **Navigation breadcrumbs are kept, query-less.** **`tracePropagationTargets: []`** stops trace headers and `baggage` going to third parties. `dataCollection` also turns `graphQL` off (no GraphQL is used; it's there so nothing is left at a default).
8. **Source maps are optional, main-only, and uploaded from one matrix leg** (`linux/amd64`). Same source and same Turbopack build should give byte-identical browser chunks on both architectures, so a second upload of the release is redundant. That is an assumption: if the arm64 image's `.next/static/chunks` hashes ever differ from amd64's, drop the platform condition. The build-args `SENTRY_ORG`/`SENTRY_PROJECT`/`SENTRY_URL` come from repo variables and the token from the `SENTRY_AUTH_TOKEN` secret, on `main` only. Anything unset means no upload. `next.config.ts` deletes empty `SENTRY_*` values before `sentry-cli` inherits them. The release name is the same 7-char SHA the runtime reports. The bundler plugin's telemetry is off.
9. **`instrumentation-client.ts` imports `@sentry/nextjs` statically** (Sentry's documented shape). That is roughly a 370 KB raw chunk on every full page load, even with no DSN, and `tracesSampleRate: 0` still bundles `browserTracingIntegration`. A dynamic import is fire-and-forget per the Next docs, so errors during hydration would be lost. Documented in `docs/observability.md` § Browser bundle cost.
10. **`maxIncomingRequestBodySize` is a deliberate 11-bump tripwire.** 11 renames the option and moves the gate to `dataCollection`, so these two lines stop type-checking on the Renovate PR, which is the prompt to delete them.
11. **Dead-man monitors are HetrixTools Cron Job monitors** (owner decision, 2026-09-25; uptime-kuma is being removed). Each has a unique URL `https://sm.hetrixtools.net/hb/?s=<token>` and goes DOWN if it isn't accessed within its Timeout. HetrixTools' docs show `curl -I`/`wget --spider` examples and say that accessing the URL marks the target up, so the jobs' plain GET is enough. The monitor form has a preset Timeout plus a Grace period (owner-verified 2026-09-25). The daily jobs use 1 day + 60 min grace (25 h); `reminders.tick` uses the smallest Timeout + grace totalling about 15 min. The `?s=` token is the secret, and the jobs already never log the URL. `reminders.tick`'s monitor doubles as worker liveness: a dead or crash-looping worker stops pinging within 15 minutes. That replaces the uptime-kuma "Docker container monitor", which HetrixTools, being outside the host, cannot do.

**Repo rules that apply to every task:**

- `pnpm`, never `npx`/`npm`. Run one file with `pnpm exec vitest run <path>` (`pnpm test:unit`/`test:integration` *widen* when given a path).
- Never `--no-verify`. After **every** `git commit`, run `git log --oneline -1` and confirm HEAD moved: the Biome pre-commit hook can fail silently.
- Stage explicit paths only (`git add <paths>`), never `-A` or `.`.
- Run `pnpm lint:fix` before committing any file whose imports changed. The code below is already in Biome's order.
- **Vitest 5.0.1 defaults `clearMocks: true`**: call counts reset between tests, so call and assert in the same `it`.
- **Integration tests must `vi.mock('@/lib/env')` with only the fields read.** None change here.
- **Worker imports must stay inside `lib/`, `worker/` or `prisma/`** and be production dependencies (`pnpm lint:worker-graph`). This plan adds no dependency. `lib/observability/*` and `lib/git-sha.ts` import no Sentry SDK; `worker/sentry.ts` imports `@sentry/node` (already a prod dep). Never import `@sentry/nextjs` from `lib/` or `worker/`.
- Don't use git worktrees in this repo (knip hangs on pre-push, and there is no `.env`). Work in the main checkout.
- Don't create `proxy.ts`, and don't touch `next.config.ts`'s `headers()`.
- `.full-review/` is excluded via `.git/info/exclude`. Nothing there gets committed except the plan copy in Task 13.
- No literal credentialed URL (a user *and* password before the `@`) in new code. Build fixtures from parts, as the tests below do; Task 13 Step 2 checks the plan itself.

## File structure

| File | Responsibility |
|---|---|
| `lib/observability/error-reporter.ts` *(create)* | The bridge: `reportLoggedError`, `setErrorReporter`/`getErrorReporter` (globalThis seam), `sentryReporter`. SDK-free. |
| `lib/observability/error-reporter.test.ts` *(create)* | Bridge contract with a spy reporter and the app's real logger options. |
| `lib/logger.ts` *(modify)* | `logMethod` hands error/fatal calls to the bridge. |
| `lib/observability/sentry-options.ts` *(create)* | The one `Sentry.init` option set: `dataCollection` off, `tracePropagationTargets: []`, `scrubEvent` (request allowlist, query stripping, pattern scrub incl. `transaction`), `dropNetworkBreadcrumb`, `BROWSER_DSN_META`. SDK-free. |
| `lib/observability/browser-dsn.ts` *(create)* | Soft-validated `SENTRY_BROWSER_DSN` reader for the root layout. |
| `lib/observability/sentry-options.test.ts` *(create)* | Scrubbing, allowlist, breadcrumb filter, option shape, DSN reader. |
| `lib/git-sha.ts`, `lib/git-sha.test.ts` *(create)*; `lib/version.ts` *(modify)* | Release SHA with the worker's `GIT_SHA` fallback, importable without `package.json`. |
| `worker/sentry.ts`, `worker/sentry.test.ts` *(create)* | `initWorkerSentry()` (init + body capture off + bridge) and `flushSentry()`; tests with the real `@sentry/node` SDK. |
| `worker/index.ts` *(modify)* | `initWorkerSentry()`; flush before both fatal exits; corrected comments. |
| `instrumentation.ts` *(rewrite)*, `tests/unit/instrumentation.test.ts` *(rewrite)* | Shared options, body capture off (nodejs), bridge registration (nodejs), `onRequestError`. |
| `instrumentation-client.ts` *(create)* / `sentry.client.config.ts` *(delete)* | Browser SDK init from the meta DSN, `onRouterTransitionStart`. |
| `app/layout.tsx` *(modify)*, `app/layout.test.tsx` *(create)* | Render the DSN meta per request. |
| `app/error.tsx` *(rewrite)*, `app/global-error.tsx` *(modify)*, `app/error.test.tsx` *(create)* | Report browser-thrown errors only (skip `digest`). |
| `knip.json`, `lib/env.ts`, `tests/unit/env.test.ts` *(modify)* | `instrumentation-client.ts` entry; retire `NEXT_PUBLIC_SENTRY_DSN`. |
| `next.config.ts`, `Dockerfile`, `.github/workflows/ci.yml`, `scripts/smoke-image.sh` *(modify)* | `@sentry/nextjs/config`, optional main-only source-map upload, no DSN baked in, no maps shipped. |
| `worker/jobs/embed-content.ts`, `worker/jobs/embed-content.test.ts`, `lib/observability/memory-watchdog.ts` *(modify)* | DOC-M2: retryable → `warn`; truthful comments. |
| `docs/observability.md` *(rewrite)*, `docs/README.md`, `CLAUDE.md`, `.env.example`, `docker-compose.yml` *(modify)* | What reaches Sentry, what never does, bundle cost, source maps, the 11 bump, HetrixTools dead-man monitors. |
| `docs/backups.md`, `lib/env.ts`, `lib/heartbeat-ping.ts` *(modify, docs/comments only)* | uptime-kuma → HetrixTools Cron Job monitors. |

---

### Task 0: Branch

- [ ] **Step 1: Branch from a current `main`**

```bash
git checkout main
git pull --ff-only
git merge-base --is-ancestor 60df852 HEAD && echo has-509   # expect: has-509 (logging-and-heartbeats merged)
git status --short                                          # expect: empty
git checkout -b fix/production-observability
docker info >/dev/null && echo docker-ok
```

Tasks 1, 3, 8 and 9 edit code #509 introduced (`logMethod`'s derived-message lines, `worker/index.ts`'s monitored-jobs import, the three heartbeat lines in `.env.example` and `docs/README.md`). Match every "replace this" block below by content, not line number.

---

### Task 1: The Pino → Sentry bridge

**Files:**
- Create: `lib/observability/error-reporter.ts`
- Test: `lib/observability/error-reporter.test.ts` (create)
- Modify: `lib/logger.ts` (`hooks.logMethod`)

- [ ] **Step 1: Write the failing test**

Create `lib/observability/error-reporter.test.ts`:

```ts
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loggerOptions } from '@/lib/logger';
import {
  type ErrorReporter,
  getErrorReporter,
  sentryReporter,
  setErrorReporter,
} from './error-reporter';

/** A logger with the app's real options (hooks included) writing to memory. */
function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const root = pino(
    { ...loggerOptions, level: 'trace' },
    { write: (s: string) => lines.push(JSON.parse(s)) },
  );
  return { log: root.child({ module: 'test.bridge' }), lines };
}

function installSpy() {
  const reporter = vi.fn<ErrorReporter>();
  setErrorReporter(reporter);
  return reporter;
}

// Built from parts so no credentialed URL appears literally in the source.
const DB_USER = 'housemanager';
const DB_PW = 's3cr3tP%40ss';
const DB_URL = `postgresql://${DB_USER}:${DB_PW}@db-host:5432/housemanager`;
const MASKED_DB_URL = DB_URL.replace(DB_PW, '***');

afterEach(() => setErrorReporter(undefined));

describe('Pino -> Sentry bridge', () => {
  it('reports logger.error({ err }) once, with module, event and the message', () => {
    const reporter = installSpy();
    const { log } = captureLogger();
    const err = new Error('voyage 400');

    log.error({ err, event: 'embed.failed', entityId: 'n1' }, 'embed-content: failed');

    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith(err, {
      level: 'error',
      module: 'test.bridge',
      event: 'embed.failed',
      message: 'embed-content: failed',
    });
  });

  it('reports an Error passed as the first argument, and fatal as fatal', () => {
    const reporter = installSpy();
    const { log } = captureLogger();
    const err = new Error('boot failed');

    log.fatal(err, 'worker failed to start');

    expect(reporter).toHaveBeenCalledWith(err, expect.objectContaining({ level: 'fatal' }));
  });

  // pg-dump logs safe fields at error level AND captures the Error itself.
  // Reporting error lines without an Error would double-report it as a
  // message-only event. Mutation-checked: a captureMessage-style fallback for
  // err-less lines fails this test.
  it('ignores error lines that carry no Error', () => {
    const reporter = installSpy();
    const { log } = captureLogger();

    log.error({ event: 'pg-dump.failed', code: 1, stderr: 'refused' }, 'pg_dump failed');
    log.error({ err: 'a string, not an Error' }, 'odd');
    log.error('plain message');

    expect(reporter).not.toHaveBeenCalled();
  });

  it('ignores warn and below, even with an Error', () => {
    const reporter = installSpy();
    const { log } = captureLogger();

    log.warn({ err: new Error('retryable') }, 'will retry');
    log.info({ err: new Error('x') }, 'x');

    expect(reporter).not.toHaveBeenCalled();
  });

  // Call sites that already did Sentry.captureException(err) and then log the
  // same err must not produce a second event. The SDK marks captured errors;
  // the bridge honours the mark. Mutation-checked: dropping alreadyCaptured()
  // fails this test (the real-SDK test in sentry-bridge.test.ts pins the flag).
  it('does not re-report an Error Sentry already captured', () => {
    const reporter = installSpy();
    const { log } = captureLogger();
    const err = new Error('pg-boss error');
    Object.defineProperty(err, '__sentry_captured__', { value: true, enumerable: false });

    log.error({ err }, 'pg-boss error');

    expect(reporter).not.toHaveBeenCalled();
  });

  it('scrubs the message it forwards; the Error goes to the SDK for beforeSend', () => {
    const reporter = installSpy();
    const { log } = captureLogger();

    log.error({ err: new Error('x') }, `cannot reach ${DB_URL}`);

    expect(reporter.mock.calls[0][1].message).toBe(`cannot reach ${MASKED_DB_URL}`);
  });

  it('is a no-op without a reporter (no DSN): logging still works', () => {
    expect(getErrorReporter()).toBeUndefined();
    const { log, lines } = captureLogger();
    expect(() => log.error({ err: new Error('x') }, 'no sentry')).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  it('a throwing reporter never breaks logging', () => {
    setErrorReporter(() => {
      throw new Error('transport down');
    });
    const { log, lines } = captureLogger();
    expect(() => log.error({ err: new Error('x') }, 'still logged')).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  it('does not recurse when the reporter itself logs an error', () => {
    const { log } = captureLogger();
    const reporter = vi.fn<ErrorReporter>(() => {
      log.error({ err: new Error('inner') }, 'reporter logged');
    });
    setErrorReporter(reporter);

    log.error({ err: new Error('outer') }, 'outer');

    expect(reporter).toHaveBeenCalledTimes(1);
  });
});

describe('sentryReporter', () => {
  it('maps a report to captureException tags and extra', () => {
    const capture = vi.fn();
    const err = new Error('x');
    sentryReporter(capture)(err, {
      level: 'fatal',
      module: 'worker.lifecycle',
      event: 'startup.failed',
      message: 'failed to start',
    });
    expect(capture).toHaveBeenCalledWith(err, {
      level: 'fatal',
      tags: { source: 'pino', module: 'worker.lifecycle', event: 'startup.failed' },
      extra: { logMessage: 'failed to start' },
    });
  });

  it('omits absent fields rather than sending undefined', () => {
    const capture = vi.fn();
    sentryReporter(capture)(new Error('x'), { level: 'error' });
    expect(capture).toHaveBeenCalledWith(expect.any(Error), {
      level: 'error',
      tags: { source: 'pino' },
      extra: {},
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run lib/observability/error-reporter.test.ts`
Expected: FAIL, `Failed to resolve import "./error-reporter"`.

- [ ] **Step 3: Create the bridge**

Create `lib/observability/error-reporter.ts`:

```ts
import { scrubSecrets } from '@/lib/log-scrub';

// The Pino -> Sentry bridge. lib/logger.ts calls reportLoggedError() for every
// error/fatal log call; if that call carries an Error (`{ err }` or an Error
// as the first argument) and an SDK has registered a reporter, the Error is
// reported once.
//
// This module imports no Sentry SDK. The worker (@sentry/node) and web
// (@sentry/nextjs) each register their own reporter at init (worker/sentry.ts,
// instrumentation.ts), so neither SDK leaks into the other's module graph and
// the worker image never needs @sentry/nextjs. No DSN, no init, no reporter:
// the bridge is then a no-op.
//
// The reporter lives on globalThis, not in a module variable. Next bundles
// instrumentation.ts separately from the route/page chunks, and a module-level
// variable set in one bundle's copy of this file is invisible to another's.

/** Pino's numeric level for `error`. `fatal` is 60. */
export const PINO_ERROR_LEVEL = 50;

type LoggedErrorReport = {
  level: 'error' | 'fatal';
  /** The child logger's `module` binding, e.g. `worker.embed-content`. */
  module?: string;
  /** The log call's `event` field, when it has one. */
  event?: string;
  /** The log message, scrubbed. */
  message?: string;
};

export type ErrorReporter = (err: Error, report: LoggedErrorReport) => void;

const REPORTER = Symbol.for('house-manager.error-reporter');
type Carrier = { [REPORTER]?: ErrorReporter };

export function setErrorReporter(reporter: ErrorReporter | undefined): void {
  (globalThis as Carrier)[REPORTER] = reporter;
}

export function getErrorReporter(): ErrorReporter | undefined {
  return (globalThis as Carrier)[REPORTER];
}

/**
 * Sentry marks every exception it captures with this non-enumerable flag
 * (`checkOrSetAlreadyCaught` in @sentry/core, still present in 11.0.0). A
 * call site that already did `Sentry.captureException(err)` and then logs the
 * same `err` must not report it twice. The SDK would drop the duplicate on its
 * own; checking here keeps the bridge's contract independent of that.
 */
function alreadyCaptured(err: Error): boolean {
  return (err as { __sentry_captured__?: unknown }).__sentry_captured__ === true;
}

let reporting = false;

/**
 * Called from lib/logger.ts's `hooks.logMethod` with the raw (unscrubbed) log
 * arguments. The Error object is passed to the reporter as-is: scrubbing its
 * message and stack is the SDK's `beforeSend` job (lib/observability/
 * sentry-options.ts), which covers every event, not just bridged ones.
 *
 * Never throws: a broken reporter must not break logging.
 */
export function reportLoggedError(
  args: readonly unknown[],
  level: number,
  bindings: Record<string, unknown>,
): void {
  if (level < PINO_ERROR_LEVEL || reporting) return;
  const reporter = getErrorReporter();
  if (!reporter) return;

  const [first, second] = args;
  const merge =
    first !== null && typeof first === 'object' && !(first instanceof Error)
      ? (first as Record<string, unknown>)
      : undefined;
  const err = first instanceof Error ? first : merge?.err;
  // No Error, no report. An error-level line without one (pg-dump logs safe
  // fields and captures separately) would otherwise become a second, message-
  // only event.
  if (!(err instanceof Error) || alreadyCaptured(err)) return;

  const message = typeof second === 'string' ? scrubSecrets(second) : undefined;
  const report: LoggedErrorReport = {
    level: level >= 60 ? 'fatal' : 'error',
    ...(typeof bindings.module === 'string' && { module: bindings.module }),
    ...(typeof merge?.event === 'string' && { event: merge.event }),
    ...(message !== undefined && { message }),
  };

  reporting = true;
  try {
    reporter(err, report);
  } catch {
    // Reporting is best-effort; the log line has already been written.
  } finally {
    reporting = false;
  }
}

/**
 * The reporter both SDKs register. Takes the SDK's `captureException` so this
 * file stays SDK-free. Module and event become tags (searchable), the log
 * message goes to `extra`.
 */
export function sentryReporter(
  captureException: (
    err: unknown,
    context: {
      level: 'error' | 'fatal';
      tags: Record<string, string>;
      extra: Record<string, string>;
    },
  ) => unknown,
): ErrorReporter {
  return (err, report) => {
    const tags: Record<string, string> = { source: 'pino' };
    if (report.module) tags.module = report.module;
    if (report.event) tags.event = report.event;
    const extra: Record<string, string> = {};
    if (report.message) extra.logMessage = report.message;
    captureException(err, { level: report.level, tags, extra });
  };
}
```

- [ ] **Step 4: Call it from the logger**

In `lib/logger.ts`, add after `import { deepScrubStrings, scrubSecrets } from './log-scrub';`:

```ts
import { PINO_ERROR_LEVEL, reportLoggedError } from './observability/error-reporter';
```

and replace the `logMethod` hook (as the logging-and-heartbeats plan left it):

```ts
    logMethod(args, method) {
      const scrubbed = args.map((a) => (typeof a === 'string' ? scrubSecrets(a) : a));
      // No message given: supply the scrubbed err.message so pino doesn't
      // derive an unscrubbed one (see derivedErrorMessage).
      const derived = derivedErrorMessage(args);
      if (derived !== undefined) scrubbed.push(scrubSecrets(derived));
      return method.apply(this, scrubbed as typeof args);
    },
```

with (the two comment lines above it stay, and gain the four lines shown):

```ts
    // Then hand error/fatal calls to the Sentry bridge (a no-op unless an SDK
    // registered a reporter; see lib/observability/error-reporter.ts). It gets
    // the RAW args because it needs the Error object itself; scrubbing what
    // reaches Sentry is the SDK's beforeSend.
    logMethod(args, method, level) {
      const scrubbed = args.map((a) => (typeof a === 'string' ? scrubSecrets(a) : a));
      // No message given: supply the scrubbed err.message so pino doesn't
      // derive an unscrubbed one (see derivedErrorMessage).
      const derived = derivedErrorMessage(args);
      if (derived !== undefined) scrubbed.push(scrubSecrets(derived));
      method.apply(this, scrubbed as typeof args);
      // Level check first: bindings() re-parses the child's bindings, and
      // this hook runs on every enabled log call.
      if (level >= PINO_ERROR_LEVEL) reportLoggedError(args, level, this.bindings());
    },
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm exec vitest run lib/observability/error-reporter.test.ts lib/logger.test.ts && pnpm typecheck`
Expected: 11 + 15 passed; tsc clean.

- [ ] **Step 6: Mutation check (do, observe, undo)**

Replace `if (!(err instanceof Error) || alreadyCaptured(err)) return;` with `if (!(err instanceof Error)) return;` → "does not re-report an Error Sentry already captured" fails. Revert.

- [ ] **Step 7: Commit**

```bash
git add lib/observability/error-reporter.ts lib/observability/error-reporter.test.ts lib/logger.ts
git commit -m "feat(observability): Pino -> Sentry bridge for error/fatal logs that carry an Error"
git log --oneline -1
```

---

### Task 2: One shared, SDK-free `Sentry.init` option set

**Files:**
- Create: `lib/observability/sentry-options.ts`, `lib/observability/browser-dsn.ts`, `lib/git-sha.ts`
- Modify: `lib/version.ts`
- Test: `lib/observability/sentry-options.test.ts`, `lib/git-sha.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `lib/observability/sentry-options.test.ts`:

```ts
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
```

Create `lib/git-sha.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

// APP_GIT_SHA is computed at module load, so each case re-imports it.
async function load(env: { NEXT_PUBLIC_GIT_SHA?: string; GIT_SHA?: string }) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_GIT_SHA', env.NEXT_PUBLIC_GIT_SHA);
  vi.stubEnv('GIT_SHA', env.GIT_SHA);
  return (await import('./git-sha')).APP_GIT_SHA;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('APP_GIT_SHA', () => {
  it('prefers the build-time NEXT_PUBLIC_GIT_SHA (web bundles)', async () => {
    expect(await load({ NEXT_PUBLIC_GIT_SHA: 'abcdef1234567', GIT_SHA: '9999999999' })).toBe(
      'abcdef1',
    );
  });

  // The worker image has only the runtime-stage GIT_SHA. Mutation-checked:
  // dropping the fallback makes this 'dev', which is what prod reported.
  it('falls back to the runtime GIT_SHA (the worker under tsx)', async () => {
    expect(await load({ GIT_SHA: '1234567890abc' })).toBe('1234567');
  });

  it('is dev when neither is set', async () => {
    expect(await load({})).toBe('dev');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run lib/observability/sentry-options.test.ts lib/git-sha.test.ts`
Expected: FAIL, `Failed to resolve import` (`./browser-dsn` / `./sentry-options` don't exist yet).

- [ ] **Step 3: Create both modules**

Create `lib/observability/sentry-options.ts`:

```ts
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
```

Create `lib/observability/browser-dsn.ts`:

```ts
import { httpUrlSchema } from '@/lib/http-url';

/**
 * The browser DSN, read from the SERVER's environment at request time and
 * rendered by app/layout.tsx into `<meta name="sentry-browser-dsn">`, where
 * instrumentation-client.ts picks it up. This is what lets one image serve any
 * deployment: nothing is inlined at build time (a NEXT_PUBLIC_ var would be).
 *
 * Soft-validated: anything but an http(s) URL means "browser reporting off",
 * never a crash. See the note in lib/env.ts for why it isn't in the schema.
 */
export function browserSentryDsn(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const parsed = httpUrlSchema.safeParse(env.SENTRY_BROWSER_DSN);
  return parsed.success ? parsed.data : undefined;
}
```

Create `lib/git-sha.ts` (the release; importable by the browser without `package.json`, and with the worker's runtime fallback):

```ts
// The short git SHA of this build: the Sentry release, and the footer's
// version stamp. Its own file, apart from lib/version.ts, because the browser
// bundle needs it (instrumentation-client.ts, via sentry-options.ts) and has
// no use for lib/version.ts's package.json import.
//
// Two sources, because the two roles see different env:
//   - NEXT_PUBLIC_GIT_SHA: a build-stage ENV in the Dockerfile. Next inlines it
//     into the web server and browser bundles at `next build`.
//   - GIT_SHA: the runtime-stage ENV. The worker runs source under tsx, so it
//     reads process.env at runtime, where only GIT_SHA exists. Without this
//     fallback every worker event was released as 'dev'.
// Local `pnpm dev` sets neither, so the value is 'dev'.
export const APP_GIT_SHA: string = (
  process.env.NEXT_PUBLIC_GIT_SHA ??
  process.env.GIT_SHA ??
  'dev'
).slice(0, 7);
```

Replace `lib/version.ts` with:

```ts
import pkg from '../package.json' with { type: 'json' };

export const APP_VERSION: string = pkg.version;

// Re-exported so existing importers keep one version module. New client-side
// code imports lib/git-sha.ts directly (see the note there).
export { APP_GIT_SHA } from './git-sha';
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run lib/observability/sentry-options.test.ts lib/git-sha.test.ts && pnpm typecheck`
Expected: 10 + 3 passed; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add lib/observability/sentry-options.ts lib/observability/browser-dsn.ts lib/observability/sentry-options.test.ts lib/git-sha.ts lib/git-sha.test.ts lib/version.ts
git commit -m "feat(observability): shared Sentry options: request allowlist, scrubbing, no propagation; worker release from GIT_SHA"
git log --oneline -1
```

---

### Task 3: Worker Sentry: shared options, the bridge, flush before a fatal exit

**Files:**
- Create: `worker/sentry.ts`
- Test: `worker/sentry.test.ts` (create)
- Modify: `worker/index.ts`

- [ ] **Step 1: Write the failing test**

Create `worker/sentry.test.ts`. It drives the **real** `@sentry/node` SDK; only the transport is fake:

```ts
import * as Sentry from '@sentry/node';
import { describe, expect, it, vi } from 'vitest';
import { getLogger } from '@/lib/logger';
import { getErrorReporter } from '@/lib/observability/error-reporter';
import { initWorkerSentry } from './sentry';

// The real @sentry/node SDK end to end: our options, our beforeSend, our
// bridge, the SDK's own capture bookkeeping. Only the transport is fake, so
// every assertion is about what would actually leave the process.
//
// Tests run in order and share one SDK client (Sentry state is global).

type SentEvent = {
  level?: string;
  tags?: Record<string, string>;
  exception?: { values?: Array<{ type?: string; value?: string }> };
};
const sent: SentEvent[] = [];
const transport = () => ({
  send: async (envelope: unknown) => {
    const [, items] = envelope as [unknown, Array<[{ type: string }, unknown]>];
    for (const [header, payload] of items) {
      if (header.type === 'event') sent.push(payload as SentEvent);
    }
    return {};
  },
  flush: async () => true,
});

const DSN = 'https://publickey@glitchtip.example/1';
// Built from parts so no credentialed URL appears literally in the source.
const DB_USER = 'housemanager';
const DB_PW = 's3cr3tP%40ss';
const DB_URL = `postgresql://${DB_USER}:${DB_PW}@db-host:5432/housemanager`;
const MASKED_DB_URL = DB_URL.replace(DB_PW, '***');

async function drain(): Promise<SentEvent[]> {
  await Sentry.flush(2_000);
  return sent.splice(0);
}

describe('worker Sentry', () => {
  it('without a DSN: no client, no bridge', () => {
    // The default argument reads process.env.SENTRY_DSN; a developer's .env
    // must not turn this into a real init.
    vi.stubEnv('SENTRY_DSN', '');
    expect(initWorkerSentry()).toBe(false);
    vi.unstubAllEnvs();
    expect(initWorkerSentry(undefined)).toBe(false);
    expect(initWorkerSentry('')).toBe(false);
    expect(Sentry.getClient()).toBeUndefined();
    expect(getErrorReporter()).toBeUndefined();
  });

  it('with a DSN: inits and installs the bridge', () => {
    // defaultIntegrations off: no process-wide handlers inside the test runner.
    expect(initWorkerSentry(DSN, { transport, defaultIntegrations: false })).toBe(true);
    expect(Sentry.getClient()).toBeDefined();
    expect(getErrorReporter()).toBeDefined();
    // Installed with incoming-body capture off (see worker/sentry.ts).
    expect(Sentry.getClient()?.getIntegrationByName('Http')).toBeDefined();
  });

  it('logger.error({ err }) sends one scrubbed event tagged with the module', async () => {
    getLogger('worker.embed-content').error(
      { err: new Error(`cannot reach ${DB_URL}`), event: 'embed.failed' },
      'embed-content: failed',
    );

    const events = await drain();
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('error');
    expect(events[0].tags).toMatchObject({ module: 'worker.embed-content', event: 'embed.failed' });
    expect(events[0].exception?.values?.[0]?.value).toBe(`cannot reach ${MASKED_DB_URL}`);
    // Nowhere in the event: message, stack frames, extra, tags.
    expect(JSON.stringify(events[0])).not.toContain('s3cr3tP');
  });

  it('captureException then logger.error of the same err sends ONE event', async () => {
    const err = new Error('pg-boss error');
    Sentry.captureException(err);
    getLogger('queue').error({ err }, 'pg-boss error');

    expect(await drain()).toHaveLength(1);
    // Pins the SDK flag the bridge relies on. If a future @sentry/* renames
    // it, this fails before duplicate events reach production.
    expect((err as { __sentry_captured__?: boolean }).__sentry_captured__).toBe(true);
  });

  // The other order: the bridge reports first, so the SDK must see the SAME
  // object the call site captures next. Mutation-checked: making the bridge
  // wrap the error (a new Error with the original as `cause`) sends 2 events.
  it('logger.error then captureException of the same err sends ONE event', async () => {
    const err = new Error('auto-stub failed');
    getLogger('worker.classify').error({ err }, 'auto-stub failed');
    Sentry.captureException(err);

    expect(await drain()).toHaveLength(1);
  });

  it('an error line without an Error adds nothing to an explicit capture (pg-dump)', async () => {
    getLogger('worker.pg-dump').error({ event: 'pg-dump.failed', code: 1 }, 'pg_dump failed');
    Sentry.captureException(new Error('Command failed: pg_dump'));

    expect(await drain()).toHaveLength(1);
  });

  it('warn is never sent', async () => {
    getLogger('worker.embed-content').warn({ err: new Error('429') }, 'will retry');
    expect(await drain()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run worker/sentry.test.ts`
Expected: FAIL, `Failed to resolve import "./sentry"`.

- [ ] **Step 3: Create the module**

Create `worker/sentry.ts`:

```ts
import * as Sentry from '@sentry/node';
import { sentryReporter, setErrorReporter } from '@/lib/observability/error-reporter';
import { sentryOptions } from '@/lib/observability/sentry-options';

/**
 * Worker-side Sentry: init with the shared options, then register the Pino
 * bridge so `logger.error({ err })` anywhere in the worker reaches Sentry.
 * No DSN means neither happens and every capture is a no-op.
 *
 * Must run before main() calls getBoss(): lib/queue.ts's boss.on('error')
 * reports through this client. Where the import line sits does not matter
 * (ESM evaluates every import before the importing module's body); where
 * this CALL sits does.
 */
export function initWorkerSentry(
  dsn: string | undefined = process.env.SENTRY_DSN,
  /** Test seam (a fake transport). The worker passes nothing. */
  overrides: Sentry.NodeOptions = {},
): boolean {
  if (!dsn) return false;
  Sentry.init({
    ...sentryOptions(dsn),
    // In 10.75 the HTTP integration buffers incoming request bodies onto the
    // scope unless told not to, whatever dataCollection.httpBodies says. The
    // worker's only server is its health endpoint; this keeps both server
    // inits identical. (11 renames the option and gates it on dataCollection;
    // tsc will flag this line on that bump.)
    integrations: [Sentry.httpIntegration({ maxIncomingRequestBodySize: 'none' })],
    ...overrides,
  });
  setErrorReporter(sentryReporter(Sentry.captureException));
  return true;
}

/**
 * Send whatever is queued before the process exits. `captureException` only
 * queues; a `process.exit(1)` straight after it loses the event, and the
 * startup-failure event is the one that matters most. Bounded, never throws.
 */
export async function flushSentry(timeoutMs = 2_000): Promise<void> {
  await Sentry.flush(timeoutMs).catch(() => false);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run worker/sentry.test.ts`
Expected: 7 passed. (A `module.register()` DeprecationWarning from the SDK's loader hook is printed; it is harmless. The `Http` integration is installed for real here, with body capture off.)

- [ ] **Step 5: Wire it into the worker**

In `worker/index.ts`:

1. Delete the three comment lines at the top (`// Sentry init MUST run before any other imports …` through `… no-op when unset.`). DOC-L2: the claim is wrong; ESM evaluates every import first, and what matters is that init runs before `main()`. `import * as Sentry from '@sentry/node';` stays (the `captureException` calls use it).
2. Delete `import { APP_GIT_SHA } from '@/lib/version';`.
3. After `import { runRemindersTick, runSearchReindex } from './monitored-jobs';` add:

   ```ts
   import { flushSentry, initWorkerSentry } from './sentry';
   ```

4. Replace the init block:

   ```ts
   if (process.env.SENTRY_DSN) {
     Sentry.init({
       dsn: process.env.SENTRY_DSN,
       release: APP_GIT_SHA,
       environment: process.env.NODE_ENV,
       tracesSampleRate: 0,
       sendDefaultPii: false,
     });
   }
   ```

   with:

   ```ts
   // Before main(): lib/queue.ts's boss.on('error') reports through this client,
   // and getBoss() runs inside main(). Also installs the Pino -> Sentry bridge.
   // No SENTRY_DSN makes this a no-op.
   initWorkerSentry();
   ```

5. Replace the fatal handler at the bottom:

   ```ts
   main().catch((e) => {
     Sentry.captureException(e);
     logger.error({ err: e }, 'failed to start');
     process.exit(1);
   });
   ```

   with:

   ```ts
   main().catch(async (e) => {
     Sentry.captureException(e);
     logger.error({ err: e }, 'failed to start');
     // captureException only queues. Exiting straight away dropped this event,
     // the one a crash-looping worker most needs to send.
     await flushSentry();
     process.exit(1);
   });
   ```

   (Capture, then log, the same `e`: the bridge sees the SDK's mark and does not send a second event.)

6. In `main()`, replace the shutdown failure handler:

   ```ts
       shutdown(signal).catch((e) => {
         logger.error({ err: e }, 'shutdown failed');
         process.exit(1);
       });
   ```

   with:

   ```ts
       shutdown(signal).catch(async (e) => {
         logger.error({ err: e }, 'shutdown failed');
         // Same as the startup path below: the bridged event only queues.
         await flushSentry();
         process.exit(1);
       });
   ```

7. In `shutdown`, flush before the graceful exit too. Replace:

   ```ts
       await boss.stop({ graceful: true });
       process.exit(0);
   ```

   with:

   ```ts
       await boss.stop({ graceful: true });
       await flushSentry();
       process.exit(0);
   ```

- [ ] **Step 6: Check**

```bash
pnpm typecheck
pnpm lint:worker-graph          # expect: OK
pnpm exec tsx -e "import('./worker/sentry').then(() => console.log('ok'))"   # expect: ok
pnpm exec vitest run worker/
```

Expected: all pass (heartbeat, health-server, monitored-jobs, sentry, and the two `jobs/` files).

- [ ] **Step 7: Commit**

```bash
git add worker/sentry.ts worker/sentry.test.ts worker/index.ts
git commit -m "feat(worker): shared Sentry options + log bridge; flush before both fatal exits"
git log --oneline -1
```

---

### Task 4: Web server: `onRequestError`, shared options, the bridge

**Files:**
- Rewrite: `instrumentation.ts`
- Rewrite: `tests/unit/instrumentation.test.ts`

- [ ] **Step 1: Write the failing test**

Replace `tests/unit/instrumentation.test.ts` with:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run tests/unit/instrumentation.test.ts`
Expected: FAIL. `onRequestError` is not exported yet, so the two `onRequestError` tests throw `onRequestError is not a function`, and the init-options and bridge tests fail on the old inline options (`sendDefaultPii` present, no `beforeSend`, no reporter registered).

- [ ] **Step 3: Rewrite `instrumentation.ts`**

Replace the whole file with:

```ts
import type { Instrumentation } from 'next';

// Next.js server-side observability bootstrap. `register` runs once per server
// runtime (nodejs, edge) at startup; `onRequestError` is Next's hook for every
// error thrown while serving a request: Server Components, route handlers,
// server actions. Under Turbopack (the default `next build` in Next 16) there
// are no webpack wrapping loaders, so onRequestError is the ONLY path by which
// those errors reach Sentry.
//
// Everything is gated on SENTRY_DSN. With no DSN, register() returns before
// loading the SDK and onRequestError returns before touching it.
//
// Release and environment come from lib/observability/sentry-options.ts,
// shared with the browser and worker inits.

export async function register() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  if (process.env.NEXT_RUNTIME !== 'nodejs' && process.env.NEXT_RUNTIME !== 'edge') return;

  const Sentry = await import('@sentry/nextjs');
  const { sentryOptions } = await import('@/lib/observability/sentry-options');
  Sentry.init({
    ...sentryOptions(dsn),
    // nodejs only (the edge SDK has no HTTP server integration). In 10.75 it
    // buffers incoming request bodies onto the scope unless told not to,
    // whatever dataCollection.httpBodies says; scrubEvent also drops
    // `request.data`, so this is belt and braces. (11 renames the option and
    // gates it on dataCollection; tsc will flag this line on that bump.)
    // Passing our own httpIntegration REPLACES @sentry/nextjs's default, which
    // sets disableIncomingRequestSpans (server/index.js): Next creates its own
    // request spans, and without this every request gets a second root span.
    ...(process.env.NEXT_RUNTIME === 'nodejs' && {
      integrations: [
        Sentry.httpIntegration({
          maxIncomingRequestBodySize: 'none',
          disableIncomingRequestSpans: true,
        }),
      ],
    }),
  });

  // Pino only runs in the nodejs runtime, so the bridge is registered there.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { sentryReporter, setErrorReporter } = await import('@/lib/observability/error-reporter');
    setErrorReporter(sentryReporter(Sentry.captureException));
  }
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (!process.env.SENTRY_DSN) return;
  const { captureRequestError } = await import('@sentry/nextjs');
  captureRequestError(err, request, context);
};
```

The SDK is imported dynamically in both exports so a deployment without `SENTRY_DSN` never loads it. `captureRequestError` flushes through `waitUntil` itself. The custom `httpIntegration` replaces `@sentry/nextjs`'s default one, which sets `disableIncomingRequestSpans: true` (`build/cjs/server/index.js`: Next makes its own request spans), so it passes that option too; without it every request would get a second, non-recording root span.

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run tests/unit/instrumentation.test.ts && pnpm typecheck`
Expected: 6 passed; tsc clean. `Instrumentation` is exported from `next` (`node_modules/next/dist/server/instrumentation/types.d.ts`).

- [ ] **Step 5: Mutation check (do, observe, undo)**

Replace `captureRequestError(err, request, context);` with `void [captureRequestError, err, request, context];` → "onRequestError forwards the error…" fails. Revert.

- [ ] **Step 6: Commit**

```bash
git add instrumentation.ts tests/unit/instrumentation.test.ts
git commit -m "fix(sentry): report server component, route handler and server action errors (onRequestError)"
git log --oneline -1
```

---

### Task 5: Browser: `instrumentation-client.ts`, runtime DSN, error boundaries

**Files:**
- Create: `instrumentation-client.ts`; delete `sentry.client.config.ts`
- Modify: `app/layout.tsx`, `app/global-error.tsx`; rewrite `app/error.tsx`
- Test: `app/layout.test.tsx`, `app/error.test.tsx` (create)
- Modify: `knip.json`, `lib/env.ts`, `tests/unit/env.test.ts`, `.github/workflows/ci.yml` (one comment)

- [ ] **Step 1: Write the failing tests**

Create `app/layout.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

// next/font/google is a compiler transform; outside `next build` it has no
// runtime, so stand in for the three fonts the layout loads.
vi.mock('next/font/google', () => {
  const font = () => ({ variable: 'font-var' });
  return { Geist: font, Geist_Mono: font, Instrument_Serif: font };
});
// Tailwind's PostCSS pipeline doesn't run under Vitest.
vi.mock('./globals.css', () => ({}));

import RootLayout from './layout';

const DSN = 'https://publickey@glitchtip.example/2';

afterEach(() => {
  vi.unstubAllEnvs();
});

// instrumentation-client.ts reads this meta; it is the only way the browser
// learns its DSN, since nothing Sentry-related is inlined at build time.
describe('RootLayout browser DSN meta', () => {
  it('renders the DSN from the server env at request time', () => {
    vi.stubEnv('SENTRY_BROWSER_DSN', DSN);
    const html = renderToStaticMarkup(<RootLayout>{null}</RootLayout>);
    expect(html).toContain(`<meta name="sentry-browser-dsn" content="${DSN}"/>`);
  });

  it('renders no meta when unset or invalid (browser reporting off)', () => {
    vi.stubEnv('SENTRY_BROWSER_DSN', '');
    expect(renderToStaticMarkup(<RootLayout>{null}</RootLayout>)).not.toContain('sentry');
    vi.stubEnv('SENTRY_BROWSER_DSN', 'javascript:alert(1)');
    expect(renderToStaticMarkup(<RootLayout>{null}</RootLayout>)).not.toContain('sentry');
  });
});
```

Create `app/error.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppError from './error';
import GlobalError from './global-error';

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException }));

afterEach(() => {
  cleanup();
});

// A server-thrown error reaches the boundary as a redacted copy with a
// `digest`; onRequestError already reported the original on the server.
// Mutation-checked: dropping the digest check fails the "server" cases.
describe('error boundaries report browser errors only', () => {
  it('app/error.tsx reports a browser-thrown error', () => {
    const error = new Error('client render failed');
    render(<AppError error={error} reset={() => {}} />);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(error);
  });

  it('app/error.tsx does not re-report a server error (has a digest)', () => {
    const error = Object.assign(new Error('An error occurred in the Server Components render.'), {
      digest: '1234567890',
    });
    render(<AppError error={error} reset={() => {}} />);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('app/global-error.tsx applies the same rule', () => {
    const server = Object.assign(new Error('redacted'), { digest: 'abc' });
    const { unmount } = render(<GlobalError error={server} reset={() => {}} />);
    expect(captureException).not.toHaveBeenCalled();
    unmount();

    const client = new Error('client');
    render(<GlobalError error={client} reset={() => {}} />);
    expect(captureException).toHaveBeenCalledWith(client);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run app/layout.test.tsx app/error.test.tsx`
Expected: 3 failed. No meta is rendered; `app/error.tsx` reports nothing; `global-error.tsx` reports the digest error.

- [ ] **Step 3: Render the DSN meta in the root layout**

In `app/layout.tsx`:

1. After `import { Geist, Geist_Mono, Instrument_Serif } from 'next/font/google';` add:

   ```tsx
   import { browserSentryDsn } from '@/lib/observability/browser-dsn';
   import { BROWSER_DSN_META } from '@/lib/observability/sentry-options';
   ```

2. Replace:

   ```tsx
   export default function RootLayout({ children }: { children: React.ReactNode }) {
     return (
   ```

   with:

   ```tsx
   export default function RootLayout({ children }: { children: React.ReactNode }) {
     // Read per request: every page under (app)/ is dynamic (auth()), so this is
     // the server's runtime env, not the build's. Statically prerendered pages
     // (not-found) are rendered at build time, when it is unset, and so ship no
     // DSN: those pages simply run without browser reporting.
     const sentryDsn = browserSentryDsn();
     return (
   ```

3. Replace:

   ```tsx
           <script dangerouslySetInnerHTML={{ __html: themeScript }} />
         </head>
   ```

   with:

   ```tsx
           <script dangerouslySetInnerHTML={{ __html: themeScript }} />
           {/* Read by instrumentation-client.ts. A DSN is public by design. */}
           {sentryDsn ? <meta name={BROWSER_DSN_META} content={sentryDsn} /> : null}
         </head>
   ```

- [ ] **Step 4: Report browser-thrown errors only**

Replace `app/error.tsx` with:

```tsx
'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

// Segment error boundary. Reports errors thrown in the browser; a no-op when
// the browser SDK was not initialised (no SENTRY_BROWSER_DSN).
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // A digest means the error was thrown on the server, where onRequestError
    // (instrumentation.ts) already reported the original. The browser only
    // has a redacted copy; reporting it too would double every server error.
    if (!error.digest) Sentry.captureException(error);
  }, [error]);

  return (
    <div>
      <h1>Something went wrong</h1>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
```

In `app/global-error.tsx`, replace:

```tsx
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
```

with:

```tsx
  useEffect(() => {
    // A digest means the error was thrown on the server, where onRequestError
    // (instrumentation.ts) already reported the original. The browser only
    // has a redacted copy; reporting it too would double every server error.
    if (!error.digest) Sentry.captureException(error);
  }, [error]);
```

- [ ] **Step 5: Replace the dead client config**

```bash
git rm sentry.client.config.ts
```

Create `instrumentation-client.ts`:

```ts
// Browser-side Sentry. Next.js runs this file before hydration on every full
// page load (node_modules/next/dist/docs/01-app/03-api-reference/
// 03-file-conventions/instrumentation-client.md). It replaces
// sentry.client.config.ts, which only @sentry/nextjs's webpack path ever
// loaded; `next build` is Turbopack, so the browser SDK never started.
//
// The DSN is read at runtime from a <meta> the root layout renders from the
// server's SENTRY_BROWSER_DSN (lib/observability/browser-dsn.ts), not inlined
// at build time, so one image serves every deployment. No meta, no init.

import * as Sentry from '@sentry/nextjs';
import { BROWSER_DSN_META, sentryOptions } from '@/lib/observability/sentry-options';

function dsnMeta(): string | undefined {
  return document.querySelector<HTMLMetaElement>(`meta[name="${BROWSER_DSN_META}"]`)?.content;
}

function start(): void {
  const dsn = dsnMeta();
  if (dsn) Sentry.init(sentryOptions(dsn));
}

// Next's own async <script> tags precede the layout's <head> children, so in
// principle this can run before the parser reaches the meta. Fall back to
// DOMContentLoaded rather than silently staying off for the whole page.
if (dsnMeta() === undefined && document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}

// Navigation breadcrumbs. Harmless when the SDK was not initialised.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
```

In `knip.json`, add `"instrumentation-client.ts",` to `entry` directly after `"instrumentation.ts",`.

- [ ] **Step 6: Retire `NEXT_PUBLIC_SENTRY_DSN`**

In `lib/env.ts`, replace the comment above `SENTRY_DSN` and the `NEXT_PUBLIC_SENTRY_DSN` line:

```ts
  // Empty string is tolerated alongside undefined: the Dockerfile's
  // `ARG SENTRY_DSN` + `ENV SENTRY_DSN=$SENTRY_DSN` pattern produces an
  // empty-string ENV when no --build-arg is passed, which a bare
  // `.url().optional()` would reject. Consumer code already truthy-checks
  // (`if (process.env.SENTRY_DSN)`), so empty string degrades cleanly. These
  // two keep `''` as a value rather than using `optionalEnv` — the observable
  // behaviour is identical for a truthy check, and rewriting them would churn
  // the schema that shipped the original fix.
  SENTRY_DSN: z.string().url().or(z.literal('')).optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().url().or(z.literal('')).optional(),
```

with:

```ts
  // Empty string is tolerated alongside undefined: compose's
  // `SENTRY_DSN: ${SENTRY_DSN:-}` hands the containers an empty string when
  // the host leaves it unset (the Dockerfile's old `ARG SENTRY_DSN` did the
  // same at build time), which a bare `.url().optional()` would reject.
  // Consumer code already truthy-checks (`if (!dsn) return`), so empty string
  // degrades cleanly. This keeps `''` as a value rather than using
  // `optionalEnv`: the observable behaviour is identical for a truthy check,
  // and rewriting it would churn the schema that shipped the original fix.
  SENTRY_DSN: z.string().url().or(z.literal('')).optional(),
  // SENTRY_BROWSER_DSN is deliberately NOT here. Only the root layout reads it
  // (lib/observability/browser-dsn.ts), which validates it softly: a malformed
  // browser DSN turns browser reporting off rather than failing getEnv() in
  // every server action and in the worker, which shares the compose env.
```

In `tests/unit/env.test.ts`, the "treats empty SENTRY_DSN as unset" test: replace

```ts
    expect(() =>
      parseEnv({ ...baseValid, SENTRY_DSN: '', NEXT_PUBLIC_SENTRY_DSN: '' }),
    ).not.toThrow();
```

with

```ts
    expect(() => parseEnv({ ...baseValid, SENTRY_DSN: '' })).not.toThrow();
```

In `.github/workflows/ci.yml` (e2e job env), replace the comment line `# NEXT_PUBLIC_SENTRY_DSN intentionally unset; browser SDK no-ops gracefully.` with `# SENTRY_BROWSER_DSN intentionally unset; no meta tag, browser SDK stays off.`

Then confirm nothing else reads the old names:

```bash
git grep -n "NEXT_PUBLIC_SENTRY_DSN\|sentry.client.config" -- . ':!docs/superpowers' ':!docs/observability.md' ':!Dockerfile' ':!docker-compose.yml'
```

Expected: no output. `Dockerfile` is Task 6; `docs/observability.md` and `docker-compose.yml` are Task 8.

- [ ] **Step 7: Run to verify**

```bash
pnpm exec vitest run app/layout.test.tsx app/error.test.tsx tests/unit/env.test.ts
pnpm typecheck
pnpm lint:knip
```

Expected: 2 + 3 + 10 passed; tsc clean; knip clean.

- [ ] **Step 8: Commit**

```bash
git add instrumentation-client.ts app/layout.tsx app/layout.test.tsx app/error.tsx app/error.test.tsx app/global-error.tsx knip.json lib/env.ts tests/unit/env.test.ts .github/workflows/ci.yml
git commit -m "fix(sentry): start the browser SDK under Turbopack (instrumentation-client.ts, runtime DSN meta)"
git log --oneline -1
```

(`git rm` already staged the deletion of `sentry.client.config.ts`.)

---

### Task 6: Build config: `@sentry/nextjs/config`, optional source maps, no maps shipped

**Files:**
- Modify: `next.config.ts`, `Dockerfile`, `.github/workflows/ci.yml`, `scripts/smoke-image.sh`

- [ ] **Step 1: `next.config.ts`**

Replace `import { withSentryConfig } from '@sentry/nextjs';` with:

```ts
import { withSentryConfig } from '@sentry/nextjs/config';
```

Replace the whole `export default withSentryConfig(nextConfig, { … });` statement at the bottom (from `export default` through the final `});`, including the `webpack: { treeshake: … }` block) with:

```ts
// Source-map upload only. Every option here is build-time; runtime init lives
// in instrumentation.ts / instrumentation-client.ts / worker/sentry.ts.
//
// Imported from '@sentry/nextjs/config': the bare '@sentry/nextjs' import is
// deprecated in 10.x and removed in 11.
//
// Upload runs only when SENTRY_AUTH_TOKEN is present (CI passes it as a
// buildkit secret on main, see Dockerfile). Without it the plugin skips the
// upload and the build is unaffected. Under Turbopack the SDK turns on
// productionBrowserSourceMaps itself and deletes the maps after the upload
// step, token or not, so no .map file ships in the image either way.
//
// CI passes the identifiers as build-args from repo variables, which arrive
// as EMPTY strings when a variable is not configured. Delete those here, in
// the process that later spawns sentry-cli: an empty SENTRY_URL is not
// "unset" to it.
for (const key of ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT', 'SENTRY_URL']) {
  if (process.env[key] === '') delete process.env[key];
}

export default withSentryConfig(nextConfig, {
  silent: true,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  // GlitchTip / self-hosted Sentry base URL. Unset means sentry.io.
  sentryUrl: process.env.SENTRY_URL,
  // The same 7-char release the runtime SDKs report (lib/version.ts), so
  // uploaded maps and events line up. NEXT_PUBLIC_GIT_SHA is the Docker
  // build-arg; there is no .git in the build context to derive it from.
  release: { name: (process.env.NEXT_PUBLIC_GIT_SHA ?? 'dev').slice(0, 7) },
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
  // Don't send the bundler plugin's own usage telemetry to sentry.io.
  telemetry: false,
  // `webpack.treeshake.removeDebugLogging` was here. It is webpack-only and a
  // no-op under Turbopack (`next build`'s default), so it was dropped rather
  // than carried as dead config.
});
```

Leave `headers()` and everything above it untouched.

- [ ] **Step 2: `Dockerfile`**

Replace this block in the build stage:

```dockerfile
# Sentry (optional — non-secret DSNs as ARG/ENV; auth token via --secret mount).
# The DSNs are public values that ship in the bundle anyway (NEXT_PUBLIC_*) or
# only identify a project, so ARG/ENV is fine. SENTRY_AUTH_TOKEN is a write
# token to the Sentry project — buildkit's SecretsUsedInArgOrEnv lint
# correctly flagged using ARG/ENV for it (the value would land in image
# history). We mount it inline on the build RUN below so it's available as an
# env var ONLY during that step and never persisted in any layer.
ARG SENTRY_DSN
ARG NEXT_PUBLIC_SENTRY_DSN
ENV SENTRY_DSN=$SENTRY_DSN
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
ENV LOG_LEVEL=info

# To enable source-map upload during build, pass:
#   docker build --secret id=sentry_auth_token,src=/path/to/token ...
# When the secret is absent, buildkit just doesn't set the env var, so
# withSentryConfig's authToken is undefined and source-map upload no-ops.
```

with:

```dockerfile
# Sentry: no DSN is baked in. SENTRY_DSN (server + worker) and
# SENTRY_BROWSER_DSN (rendered into the page by the root layout) are read at
# RUNTIME from the container env, so this one image serves every deployment.
#
# Source-map upload (optional) is the only build-time Sentry work. The three
# ARGs below are non-secret identifiers; empty means "not configured" and the
# upload is skipped. SENTRY_AUTH_TOKEN is a write token, so it is NOT an ARG
# (buildkit's SecretsUsedInArgOrEnv lint flags that: the value would land in
# image history). It is mounted inline on the build RUN below, available as an
# env var ONLY during that step and never persisted in any layer:
#   docker build --secret id=sentry_auth_token,src=/path/to/token ...
# When the secret is absent, buildkit doesn't set the env var, withSentryConfig's
# authToken is undefined, and the upload no-ops.
# (An ARG is visible to this stage's RUN steps as an env var; no ENV needed,
# and nothing Sentry-related reaches the runtime stage.)
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ARG SENTRY_URL
ENV LOG_LEVEL=info
```

The `RUN --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN …` line right after it is unchanged.

- [ ] **Step 3: CI build steps**

In `.github/workflows/ci.yml`, job `build-image`, step **Build and push by digest**, replace:

```yaml
          platforms: ${{ matrix.platform }}
          build-args: |
            GIT_SHA=${{ github.sha }}
          labels: ${{ steps.meta.outputs.labels }}
```

with:

```yaml
          platforms: ${{ matrix.platform }}
          # Keep build-args identical in the smoke-test step below: ARG values
          # are part of the layer cache key, and a mismatch rebuilds the image.
          # The SENTRY_* repo variables are optional (empty = no source-map
          # upload); next.config.ts drops empty values.
          build-args: |
            GIT_SHA=${{ github.sha }}
            SENTRY_ORG=${{ vars.SENTRY_ORG }}
            SENTRY_PROJECT=${{ vars.SENTRY_PROJECT }}
            SENTRY_URL=${{ vars.SENTRY_URL }}
          # Source-map upload token: main only (PR builds would upload maps for
          # releases that never ship), one matrix leg only (same source, same
          # Turbopack build: the browser chunks should be byte-identical on both
          # architectures, so a second upload of the release is redundant; if
          # they ever differ, drop the platform condition), and only when the
          # secret exists. An empty
          # string passes no secret at all. The other leg still deletes its
          # maps (next.config.ts). Secrets are not part of the cache key, so
          # the smoke step below still hits the cache.
          secrets: ${{ github.ref == 'refs/heads/main' && matrix.platform == 'linux/amd64' && secrets.SENTRY_AUTH_TOKEN != '' && format('sentry_auth_token={0}', secrets.SENTRY_AUTH_TOKEN) || '' }}
          labels: ${{ steps.meta.outputs.labels }}
```

And in step **Load image locally for smoke test**, replace:

```yaml
          build-args: |
            GIT_SHA=${{ github.sha }}
          load: true
```

with:

```yaml
          build-args: |
            GIT_SHA=${{ github.sha }}
            SENTRY_ORG=${{ vars.SENTRY_ORG }}
            SENTRY_PROJECT=${{ vars.SENTRY_PROJECT }}
            SENTRY_URL=${{ vars.SENTRY_URL }}
          load: true
```

The two `build-args` blocks must stay identical, or the smoke step rebuilds from scratch instead of hitting the local cache.

- [ ] **Step 4: Smoke test: no source maps in the image**

In `scripts/smoke-image.sh`, after the line `echo "  ✓ .next/static asset ($chunk)"`, add:

```bash
# No source maps in the image. Under Turbopack, @sentry/nextjs switches on
# productionBrowserSourceMaps and deletes the maps after its upload step
# whether or not an auth token was present (next.config.ts). If a future SDK
# stops deleting them, catch it here rather than by reading a bundle listing.
maps="$(docker run --rm --pull=never "$IMAGE" sh -c 'find /app/web/.next/static -name "*.map" | head -3')"
[ -z "$maps" ] || fail "source maps shipped in /app/web/.next/static: $maps"
echo "  ✓ no source maps shipped"
```

- [ ] **Step 5: Build and inspect the output**

```bash
bash -n scripts/smoke-image.sh && shellcheck scripts/smoke-image.sh   # expect: no output
command -v actionlint >/dev/null && actionlint -oneline .github/workflows/ci.yml | grep -v 'runner-label'
pnpm typecheck
pnpm build 2>&1 | tee "${TMPDIR:-/tmp}/hm-build.log" | tail -5
grep -c 'Turbopack' "${TMPDIR:-/tmp}/hm-build.log"                         # expect: >= 1
grep -ci '@sentry/nextjs.*deprecat\|will stop working in v11' "${TMPDIR:-/tmp}/hm-build.log"   # expect: 0
chunk="$(grep -l 'sentry-browser-dsn' .next/static/chunks/*.js)"; echo "$chunk"   # expect: exactly one file
grep -c "$(basename "$chunk")" .next/server/app/_not-found.html              # expect: >= 1 (pages load it)
find .next/static -name '*.map' | wc -l                                      # expect: 0
grep -l 'packageManager' .next/static/chunks/*.js | wc -l                    # expect: 0 (no package.json in the browser)
```

That chunk is `instrumentation-client.ts` compiled into the page bootstrap. It is the proof that Turbopack picked the file up; `sentry.client.config.ts` never appeared in any chunk. actionlint (if installed) should print only the pre-existing `SC2016:info` line, which `main` has too: nothing about `build-args`, `secrets` or `vars`. The filter hides the pre-existing `ubuntu-26.04` runner-label noise.

- [ ] **Step 6 (recommended): Build the image and run the smoke test locally**

```bash
docker build -t house-manager:obs --build-arg GIT_SHA="$(git rev-parse HEAD)" .
scripts/smoke-image.sh house-manager:obs
```

Expected: every existing check passes, plus `✓ no source maps shipped`. The worker boots `worker/index.ts` inside the image, so this also proves `worker/sentry.ts` and `worker/monitored-jobs.ts` resolve at runtime there.

- [ ] **Step 7: Commit**

```bash
git add next.config.ts Dockerfile .github/workflows/ci.yml scripts/smoke-image.sh
git commit -m "build(sentry): @sentry/nextjs/config, optional main-only source-map upload, no DSN baked in"
git log --oneline -1
```

---

### Task 7: Make DOC-M2's comments true (and stop reporting retryable embeds)

**Files:**
- Modify: `worker/jobs/embed-content.ts`, `worker/jobs/embed-content.test.ts`, `lib/observability/memory-watchdog.ts`, `worker/index.ts` (comment)

- [ ] **Step 1: Write the failing test**

In `worker/jobs/embed-content.test.ts`, after the existing `vi.mock('@/lib/env', …)` block, add:

```ts
// Captured: the level decides whether the Pino -> Sentry bridge reports it.
const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/logger', () => ({ getLogger: () => log }));
```

and append at the end of the file:

```ts
// Only error-level lines with an `err` reach Sentry (lib/observability/
// error-reporter.ts). Mutation-checked: logging the retryable case at error
// again fails the first test.
describe('handleEmbedContent log levels', () => {
  it('logs a retryable failure at warn only (a blip is not an incident)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(handleEmbedContent(JOBS)).rejects.toBeInstanceOf(VoyageRetryableError);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(VoyageRetryableError), entityId: 'note-1' }),
      expect.any(String),
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs a swallowed permanent failure at error, with the err', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad request', { status: 400 }));
    await handleEmbedContent(JOBS);
    // voyage.ts logs its own error line too, without an `err` (not bridged).
    // Exactly one error line carries the Error, so exactly one Sentry event.
    const withErr = log.error.mock.calls.filter(([fields]) => 'err' in fields);
    expect(withErr).toHaveLength(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), entityType: 'NOTE', entityId: 'note-1' }),
      'embed-content: failed',
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run worker/jobs/embed-content.test.ts`
Expected: 1 failed ("logs a retryable failure at warn only": `log.error` was called).

- [ ] **Step 3: Implement**

In `worker/jobs/embed-content.ts`, replace docstring points 2 and 3:

```ts
 *   2. Re-throws {@link VoyageRetryableError} so pg-boss's retry policy can
 *      back off and try again (network blips, 429, 5xx).
 *   3. Lets fatal errors propagate so they surface in Sentry, but does not
 *      retry — re-trying a fatal Voyage error wastes budget.
```

with:

```ts
 *   2. Re-throws {@link VoyageRetryableError} so pg-boss's retry policy can
 *      back off and try again (network blips, 429, 5xx). Logged at warn,
 *      which the Pino -> Sentry bridge does not forward: a blip is not an
 *      incident, and each retry would otherwise be its own event.
 *   3. Swallows every other error so the job completes and is NOT retried
 *      (re-trying a fatal Voyage error wastes budget), logging it at error
 *      with `err`. That line is what reaches Sentry, through the bridge in
 *      lib/observability/error-reporter.ts, when SENTRY_DSN is set.
```

and replace the `catch` block:

```ts
    } catch (err) {
      log.error(
        { err, entityType: data.entityType, entityId: data.entityId },
        'embed-content: failed',
      );
      // pg-boss retries on throw; only retry the transient class so the
      // permanent Voyage 400 doesn't loop.
      if (err instanceof VoyageRetryableError) throw err;
      // Non-retryable: swallow so the job doesn't infinitely retry. Sentry
      // will pick up the error from the structured log above (Pino + Sentry
      // integration in Plan 5a).
    }
```

with:

```ts
    } catch (err) {
      const fields = { err, entityType: data.entityType, entityId: data.entityId };
      // pg-boss retries on throw; only retry the transient class so the
      // permanent Voyage 400 doesn't loop.
      if (err instanceof VoyageRetryableError) {
        log.warn(fields, 'embed-content: failed, will retry');
        throw err;
      }
      // Non-retryable: swallow so the job doesn't infinitely retry. The
      // error-level line is the report: the Pino -> Sentry bridge forwards it.
      log.error(fields, 'embed-content: failed');
    }
```

In `lib/observability/memory-watchdog.ts`, replace:

```ts
 * crosses `thresholdMb`, emit a structured `module: 'worker.memory'` warning.
 * The Plan 5a Pino+Sentry pipeline picks the warning up; from there it surfaces
 * in logs and (if Sentry is configured) creates a breadcrumb event.
```

with:

```ts
 * crosses `thresholdMb`, emit a structured `module: 'worker.memory'` warning.
 * Log-only: the Pino -> Sentry bridge forwards error/fatal lines that carry an
 * Error, so this warn never reaches Sentry. Find it in `docker logs`.
```

In `worker/index.ts`, replace:

```ts
  // logs a structured warning when RSS crosses 800 MB; Sentry picks it up
  // through the Plan 5a integration.
```

with:

```ts
  // logs a structured warning when RSS crosses 800 MB. Log-only: the Pino ->
  // Sentry bridge forwards error/fatal calls that carry an Error, not warns.
```

- [ ] **Step 4: Run and sweep**

```bash
pnpm exec vitest run worker/jobs/embed-content.test.ts
git grep -n "Sentry picks it up\|Sentry will pick up\|Pino+Sentry\|Pino + Sentry integration\|surface in Sentry" -- lib worker app instrumentation.ts
```

Expected: 5 passed; the grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/embed-content.ts worker/jobs/embed-content.test.ts lib/observability/memory-watchdog.ts worker/index.ts
git commit -m "fix(observability): retryable embed failures log at warn; comments no longer promise a Sentry pipeline that didn't exist"
git log --oneline -1
```

---

### Task 8: Docs, compose and CLAUDE.md

**Files:**
- Rewrite: `docs/observability.md`
- Modify: `docs/README.md`, `.env.example`, `docker-compose.yml`, `CLAUDE.md`

- [ ] **Step 1: Rewrite `docs/observability.md`**

Replace the whole file with:

````markdown
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
- **Incoming bodies are not even buffered.** In 10.75 the HTTP server integration captures incoming request bodies regardless of `dataCollection.httpBodies`, so both server inits pass `httpIntegration({ maxIncomingRequestBodySize: 'none' })`. The `request` allowlist above would drop a body anyway.
- **No user data.** Every `Sentry.init` shares `dataCollection` turned off: no cookies, headers, IP, user info, bodies, query params or local variables. It is set explicitly because `sendDefaultPii` is removed in `@sentry/*` 11, whose default with no `dataCollection` collects all of it.
- **No secrets in event text.** `beforeSend` applies the same pattern scrubbing the logs get (`lib/log-scrub.ts`) to the message, exception, extra, contexts, breadcrumbs, request, tags and **transaction**. That masks DB passwords in connection strings, Bearer/Basic tokens, `sk-` API keys, and the capability token in `/api/calendar/<token>` and `/api/inbound-email/<token>`. The transaction matters: the SDK names each request `${method} ${raw path}`, so an error logged inside the inbound webhook would otherwise carry the real token.
- **No outgoing-request breadcrumbs, and query-less navigation ones.** `beforeBreadcrumb` drops `http`/`fetch`/`xhr` breadcrumbs, whose URLs carry credentials no pattern can recognise (dead-man tokens, Web Push endpoints). It keeps the browser's `navigation` breadcrumbs but strips the query from their `from`/`to`: search terms travel as `?q=`.
- **No query strings in browser stack frames.** Inline browser code is attributed to the page URL; `scrubEvent` strips the query from each frame's `abs_path`/`filename`.
- **No trace headers on outgoing requests.** `tracePropagationTargets: []`. Without it the SDK adds `sentry-trace` and `baggage` (which includes the DSN's public key) to every outgoing call, to Voyage, Anthropic, ForwardEmail, Web Push and the monitors, even at `tracesSampleRate: 0`.

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

A logged `err` keeps its `type`, `message`, `stack`, `cause` and custom fields (scrubbed), and when a call passes no message (`logger.error({ err })`), the `msg` pino derives from `err.message` is scrubbed too. Add new sensitive key names to `lib/logger.ts` and new value patterns to `lib/log-scrub.ts`. Sentry's `beforeSend` uses the same patterns, so both outputs stay in step.

## Upgrading to `@sentry/*` 11

Checked against the 11.0.0 tarballs:

- `withSentryConfig` is imported from `@sentry/nextjs/config` (the bare import is removed in 11).
- `sendDefaultPii` is not used. The explicit `dataCollection` keeps 11's collect-everything default out.
- `worker/sentry.test.ts` asserts the `__sentry_captured__` flag the bridge relies on, so a rename fails CI rather than doubling events.
- `buildTimeInstrumentation` defaults to `true` in 11 (build-time instrumentation of server dependencies). Run `pnpm build` and the image smoke test on the bump PR before merging.
- `httpIntegration({ maxIncomingRequestBodySize: 'none' })` stops type-checking: 11 renames the option (`maxRequestBodySize`) and gates body capture on `dataCollection.httpBodies`, which is already `[]`. Delete the option (or rename it) on the bump PR; `scrubEvent` drops `request.data` either way.
````

- [ ] **Step 2: `docker-compose.yml`**

In `x-app-env`, replace:

```yaml
  # Optional observability vars. Set these once GlitchTip / Loki are running.
  # SENTRY_DSN: ${SENTRY_DSN:-}
  # NEXT_PUBLIC_SENTRY_DSN: ${NEXT_PUBLIC_SENTRY_DSN:-}
  # SENTRY_AUTH_TOKEN: ${SENTRY_AUTH_TOKEN:-}
  # LOG_LEVEL: ${LOG_LEVEL:-info}
```

with:

```yaml
  # Error reporting (docs/observability.md). Optional, read at runtime; empty
  # means off. SENTRY_DSN: web server + worker. SENTRY_BROWSER_DSN: rendered
  # into each page for the browser SDK. (SENTRY_AUTH_TOKEN is build-time only:
  # a buildkit secret, never a runtime var.)
  SENTRY_DSN: ${SENTRY_DSN:-}
  SENTRY_BROWSER_DSN: ${SENTRY_BROWSER_DSN:-}
  # LOG_LEVEL: ${LOG_LEVEL:-info}
```

- [ ] **Step 3: `.env.example`**

After the `# SEARCH_REINDEX_HEARTBEAT_URL=` line (the last of the three heartbeat lines):

```
# SENTRY_DSN=           # web server + worker error reporting (GlitchTip/Sentry); see docs/observability.md
# SENTRY_BROWSER_DSN=   # browser error reporting; read at request time, never baked into the build
```

- [ ] **Step 4: `docs/README.md`**

Optional env table, after the `SEARCH_REINDEX_HEARTBEAT_URL` row (the last of the three heartbeat rows):

```
| `SENTRY_DSN` | unset | Web server + worker error reporting. See [observability.md](observability.md) |
| `SENTRY_BROWSER_DSN` | unset | Browser error reporting. Read per request and rendered into the page; not a build-time var. See [observability.md](observability.md) |
```

Docs index line, replace ``— logging (Pino) and error reporting (Sentry/GlitchTip).`` with ``— logging (Pino), error reporting (Sentry/GlitchTip), dead-man monitors, source maps.``

- [ ] **Step 5: `CLAUDE.md`**

In the **Worker** paragraph, replace:

```
stage; removing that COPY breaks the worker at boot, not at build. Sentry init must stay
the first import in `worker/index.ts` (`lib/queue.ts` registers `boss.on('error')` →
`Sentry.captureException`). Worker uses `@sentry/node`, web uses `@sentry/nextjs`.
```

with:

```
stage; removing that COPY breaks the worker at boot, not at build. `initWorkerSentry()`
must run before `main()` calls `getBoss()` (`lib/queue.ts`'s `boss.on('error')` reports
through it), which is why it sits at module top level; the import's position is
irrelevant, since ESM evaluates every import first. Worker uses `@sentry/node`, web uses
`@sentry/nextjs`. What both share (the `Sentry.init` options and the Pino → Sentry
bridge) lives SDK-free in `lib/observability/`: never import either SDK from there.
```

And add this section under **Rules that bite**, directly before `### Migrations carry SQL that Prisma cannot regenerate`:

```
### A log level is a reporting decision

`logger.error(...)` / `logger.fatal(...)` with an Error (`{ err }`, or the Error as the
first argument) **is a Sentry event** when `SENTRY_DSN` is set, via the bridge in
`lib/observability/error-reporter.ts`. `warn` never is. So: expected or retried failures
log at `warn`; failures someone should look at log at `error` with the `err`. An error
line without an Error is not reported, and an Error the call site already passed to
`Sentry.captureException` is not reported twice. Details: `docs/observability.md`.
```

- [ ] **Step 6: Commit**

```bash
git add docs/observability.md docs/README.md .env.example docker-compose.yml CLAUDE.md
git commit -m "docs(observability): what reaches Sentry, what never does, dead-man monitors, source maps"
git log --oneline -1
```

---

### Task 9: Dead-man monitors move to HetrixTools

Owner decision (2026-09-25): uptime-kuma is being removed; monitoring is HetrixTools. The jobs need no change (they GET the URL verbatim and never log it). This task is docs and comments. The Dead-man monitors section of `docs/observability.md` already went in with Task 8's rewrite.

**Files:**
- Modify: `docs/backups.md` (§ Monitoring, § Production deployments), `docs/README.md` (the `BACKUP_HEARTBEAT_URL` row), `.env.example` (two comments), `lib/env.ts` and `lib/heartbeat-ping.ts` (comments)

- [ ] **Step 1: `docs/backups.md` § Monitoring**

Replace:

```markdown
Set up once, in uptime-kuma:

1. **Add New Monitor** → Monitor Type **Push**. Name it e.g. `house-manager backup`.
2. **Heartbeat Interval**: `90000` seconds (25 hours: one daily run plus slack). **Retries**: `0`.
3. Save, and copy the **Push URL** it shows (`https://<kuma>/api/push/<token>?status=up&msg=OK&ping=`).
4. Set it as `BACKUP_HEARTBEAT_URL` on the **worker** container, then **recreate** the worker so it picks up the new environment: `docker compose up -d` (in production, your normal deploy). `docker restart` keeps the old environment.
5. Send the first ping by running the [manual smoke test](#manual-smoke-test-after-deployment). The monitor stays pending until then.

The URL is fetched verbatim with a 10-second timeout. A monitor that is down or slow logs `"event":"pg-dump.heartbeat.failed"` and never fails the backup. The URL carries the push token, so the job never logs it; treat it as a secret.
```

with:

```markdown
Set up once, in HetrixTools:

1. Add a **Cron Job monitor** (HetrixTools' heartbeat monitor). Name it e.g. `house-manager backup`.
2. **Timeout** `1 day` + **Grace period** `60 min` (25 hours: one daily run plus slack). Never total less than 24 hours: it would page every day.
3. Save, and copy the unique URL it generates (`https://sm.hetrixtools.net/hb/?s=<token>`).
4. Set it as `BACKUP_HEARTBEAT_URL` on the **worker** container, then **recreate** the worker so it picks up the new environment: `docker compose up -d` (in production, your normal deploy). `docker restart` keeps the old environment.
5. Send the first ping by running the [manual smoke test](#manual-smoke-test-after-deployment). The monitor has no data until then.

The URL is fetched verbatim with a plain GET and a 10-second timeout (HetrixTools' examples use `curl`/`wget`; the worker needs outbound HTTPS to `sm.hetrixtools.net`). A monitor that is down or slow logs `"event":"pg-dump.heartbeat.failed"` and never fails the backup. The `?s=` token is the secret, so the job never logs the URL; treat it as one. The two other dead-man monitors are in [observability.md § Dead-man monitors](observability.md#dead-man-monitors).
```

And in § Production deployments replace `      BACKUP_HEARTBEAT_URL: <uptime-kuma push URL>` with `      BACKUP_HEARTBEAT_URL: <HetrixTools Cron Job monitor URL>`.

- [ ] **Step 2: The one-line mentions**

- `docs/README.md`, `BACKUP_HEARTBEAT_URL` row: `e.g. an uptime-kuma Push monitor.` → `e.g. a HetrixTools Cron Job monitor.`
- `.env.example`: both `(uptime-kuma Push URL)` → `(HetrixTools Cron Job monitor URL)`.
- `lib/env.ts`, the `BACKUP_HEARTBEAT_URL` comment: `// monitor behind it (an uptime-kuma Push monitor) goes red by silence rather` → `// monitor behind it (a HetrixTools Cron Job monitor) goes down by silence rather`, and `// ping. The URL carries the monitor's push token: never log it.` → ``// ping. The URL's `?s=` token is the secret: never log it.``
- `lib/heartbeat-ping.ts` line 4: `// (an uptime-kuma Push monitor, healthchecks.io, ...). The monitor alerts when` → `// (a HetrixTools Cron Job monitor, healthchecks.io, ...). The monitor alerts when`

- [ ] **Step 2b: Check**

```bash
git grep -n -i 'kuma' -- . ':!*.test.ts' ':!docs/superpowers'   # expect: no output
pnpm exec biome check lib/env.ts lib/heartbeat-ping.ts
```

(Test fixtures such as `kuma.example` and `uptime-kuma:3001` in `*.test.ts` are just hostnames and stay.)

- [ ] **Step 3: Commit**

```bash
git add docs/backups.md docs/README.md .env.example lib/env.ts lib/heartbeat-ping.ts
git commit -m "docs(monitoring): dead-man monitors are HetrixTools Cron Job monitors"
git log --oneline -1
```

---

### Task 10: Full verification

- [ ] **Step 1: The pre-push gate**

Run: `pnpm verify`
Expected: Biome, `lint:tokens`, `lint:worker-graph` and `lint:knip` pass; tsc clean; `test:unit` passes (128 files).

- [ ] **Step 1b: No uptime-kuma left outside test fixtures and old plans**

```bash
git grep -n -i 'kuma' -- . ':!*.test.ts' ':!docs/superpowers'   # expect: no output
```

- [ ] **Step 2: Integration files on the worker's paths**

```bash
pnpm exec vitest run tests/integration/reminders-tick.test.ts tests/integration/search-reindex.test.ts tests/integration/missed-tick-recovery.test.ts tests/integration/pg-dump-restore.test.ts tests/integration/health.test.ts
```

Expected: all pass. (`pg-dump-restore` needs a PostgreSQL 18 client on PATH; see `docs/TESTING.md`.)

- [ ] **Step 3: e2e**

The root layout, both error boundaries and the page bootstrap changed, so run the full suite: `pnpm test:e2e:local`. Nothing visible changes with `SENTRY_BROWSER_DSN` unset, so visual baselines should not move. If one does, compare the diff image before touching a baseline.

- [ ] **Step 4: Prove the web path end to end against a local envelope listener**

This is the only check that runs `onRequestError`, the bridge inside a request, and `scrubEvent` through a real `next start`. Needs Task 6's `pnpm build` (rerun it if anything changed since). Save this as `"${TMPDIR:-/tmp}/e2e-sentry.sh"` (not in the repo) and run it from the repo root with `bash "${TMPDIR:-/tmp}/e2e-sentry.sh"`:

```bash
#!/usr/bin/env bash
# Local end-to-end check of the web server's Sentry path against a fake
# envelope endpoint. Needs `pnpm build` first. Commits nothing.
set -uo pipefail

T="${TMPDIR:-/tmp}"
OUT="$T/envelopes.txt"
rm -f "$OUT"

cat > "$T/fake-sentry.mjs" <<'EOF'
import fs from 'node:fs';
import http from 'node:http';
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    fs.appendFileSync(process.argv[2], `${req.method} ${req.url}\n${body}\n---\n`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
}).listen(9999, '127.0.0.1');
EOF

INBOX_TOKEN=inboxTok3nCanary0123456789
HMAC_KEY=hmacKeyCanary0123456789abcdef
BODY='{"messageId":"<e2e@example.test>","from":{"value":[{"address":"a@example.test"}]},"text":"bodyCanary-9f8e7d"}'
SIG="$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$HMAC_KEY" -r | cut -d' ' -f1)"

node "$T/fake-sentry.mjs" "$OUT" & FAKE=$!
# DATABASE_URL points at a closed port so both routes below fail inside a request.
SENTRY_DSN=http://publickey@127.0.0.1:9999/1 \
  DATABASE_URL=postgresql://nobody@127.0.0.1:1/nodb \
  INBOUND_EMAIL_TOKEN="$INBOX_TOKEN" INBOUND_EMAIL_HMAC_KEY="$HMAC_KEY" \
  node_modules/.bin/next start -p 3998 > "$T/next-start.log" 2>&1 & WEB=$!
until curl -s -o /dev/null http://127.0.0.1:3998/api/health; do sleep 1; done

# 1. onRequestError: a route handler that throws.
curl -s -o /dev/null -w 'calendar: %{http_code}\n' \
  -H 'Cookie: authjs.session-token=cookieCanary' -H 'Authorization: Bearer bearerCanary123' \
  'http://127.0.0.1:3998/api/calendar/calTok3nCanary.ics?q=queryCanary'
# 2. The bridge: a route that catches, logs { err } at error level and returns 500.
curl -s -o /dev/null -w 'inbound: %{http_code}\n' -X POST \
  -H 'content-type: application/json' -H "x-webhook-signature: $SIG" \
  --data "$BODY" "http://127.0.0.1:3998/api/inbound-email/$INBOX_TOKEN?q=queryCanary"

sleep 4
kill "$WEB" "$FAKE"

echo "events: $(grep -c '"exception"' "$OUT")"
grep -o '"transaction":"[^"]*"' "$OUT"
grep -o '"url":"[^"]*"' "$OUT"
for canary in calTok3nCanary "$INBOX_TOKEN" cookieCanary bearerCanary123 queryCanary bodyCanary-9f8e7d; do
  echo "$canary: $(grep -c -- "$canary" "$OUT")"
done
```

Expected output:

```
calendar: 500
inbound: 500
events: 2
"transaction":"GET /api/calendar/***"
"transaction":"POST /api/inbound-email/***"
"url":"http://127.0.0.1:3998/api/calendar/***"
"url":"http://127.0.0.1:3998/api/inbound-email/***"
calTok3nCanary: 0
inboxTok3nCanary0123456789: 0
cookieCanary: 0
bearerCanary123: 0
queryCanary: 0
bodyCanary-9f8e7d: 0
```

The calendar route throws (the DB port is closed), so `onRequestError` reports it. The inbound webhook passes its token and HMAC checks, then its ingest throws; the route catches that and logs `{ err }`, so the **bridge** reports it (look for `"source":"pino"` in the envelope). Every canary count must be 0. The other envelopes (`session`, `sessions`, `client_report`) are SDK bookkeeping. `next start` may warn that it doesn't serve `output: 'standalone'`; it works for this.

- [ ] **Step 5: Prove no trace headers leave the process**

Save as `prop-probe.mjs` **in the repo root** (so `@sentry/node` resolves), run it twice, then delete it:

```js
import http from 'node:http';
const Sentry = await import('@sentry/node');
const opts = { dsn: 'http://publickey@127.0.0.1:9/1', tracesSampleRate: 0 };
if (process.argv[2] === 'empty') opts.tracePropagationTargets = [];
Sentry.init(opts);
const srv = http.createServer((req, res) => { res.end(JSON.stringify({ trace: req.headers['sentry-trace'] ?? null, baggage: req.headers.baggage ?? null })); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}/`;
const viaFetch = await (await fetch(url)).text();
const viaHttp = await new Promise((r) => http.get(url, (res) => { let b=''; res.on('data', (c) => (b += c)); res.on('end', () => r(b)); }));
console.log(process.argv[2] ?? 'default', 'fetch', viaFetch, 'http', viaHttp);
srv.close(); await Sentry.close(100);
```

```bash
node prop-probe.mjs 2>/dev/null         # default options: sentry-trace + baggage present on both fetch and http
node prop-probe.mjs empty 2>/dev/null   # expect: {"trace":null,"baggage":null} for both
rm prop-probe.mjs
```

The first line shows what `tracePropagationTargets: []` in `sentryOptions` prevents: `baggage` carries `sentry-public_key` to every API the app calls.

- [ ] **Step 6 (optional): coverage floor**

`pnpm test:coverage:check`. Every new line has tests, so the merged floor can only rise. **Never lower a threshold in `vitest.config.ts`.**

---

### Task 11: Mutation checks not yet run

Tasks 1 and 4 had their own. Run each of these once: make the edit, run the command, check the result, then `git checkout -- <file>`.

| Edit | Run | Expect |
|---|---|---|
| `lib/observability/error-reporter.ts`: `const err = first instanceof Error ? first : merge?.err;` → `… : merge?.err instanceof Error ? merge.err : new Error(String(second));` | `pnpm exec vitest run lib/observability/error-reporter.test.ts worker/sentry.test.ts` | 2 fail |
| `lib/observability/error-reporter.ts`: `reporter(err, report);` → `reporter(new Error(err.message, { cause: err }), report);` | `pnpm exec vitest run worker/sentry.test.ts` | 1 fail (log-then-capture) |
| `lib/observability/sentry-options.ts`: remove `'transaction',` from `SCRUBBED_SECTIONS` | `pnpm exec vitest run lib/observability/sentry-options.test.ts` | 1 fail |
| `lib/observability/sentry-options.ts`: delete `if (out.request !== undefined) out.request = scrubRequest(out.request);` | same | 1 fail |
| `lib/observability/sentry-options.ts`: delete `tracePropagationTargets: [],` | same | 1 fail |
| `lib/observability/sentry-options.ts`: `breadcrumb.category === 'navigation' &&` → `breadcrumb.category === 'navigation-off' &&` | same | 1 fail |
| `lib/observability/sentry-options.ts`: delete `if (out.exception !== undefined) out.exception = stripFrameQueries(out.exception);` | same | 1 fail |
| `lib/observability/sentry-options.ts`: delete `graphQL: { document: false, variables: false },` | same | 1 fail |
| `instrumentation.ts`: delete `disableIncomingRequestSpans: true,` | `pnpm exec vitest run tests/unit/instrumentation.test.ts` | 1 fail |
| `lib/observability/sentry-options.ts`: add `sendDefaultPii: false,` after `tracesSampleRate: 0,` | `pnpm exec vitest run lib/observability/sentry-options.test.ts tests/unit/instrumentation.test.ts` | 2 fail |
| `worker/sentry.ts`: delete the `integrations: [Sentry.httpIntegration(…)],` line | `pnpm exec vitest run worker/sentry.test.ts` | 1 fail |
| `lib/git-sha.ts`: delete `process.env.GIT_SHA ??` | `pnpm exec vitest run lib/git-sha.test.ts` | 1 fail |
| `app/error.tsx`: `if (!error.digest) Sentry.captureException(error);` → `Sentry.captureException(error);` | `pnpm exec vitest run app/error.test.tsx` | 1 fail |
| `worker/jobs/embed-content.ts`: `log.warn(fields, 'embed-content: failed, will retry');` → `log.error(…)` | `pnpm exec vitest run worker/jobs/embed-content.test.ts` | 1 fail |

Finish with `git status --short`: expect a clean tree.

---

### Task 12: Owner steps (list only; the implementer does NOT do these)

These run outside this repo. Put them in the PR body.

1. **GlitchTip projects.** Create a server project (web server + worker) and, optionally, a separate browser project. Copy the DSNs.
2. **HetrixTools Cron Job monitors** (replacing the uptime-kuma Push monitors, which go away with uptime-kuma). Create three, and set each **Timeout** under advanced settings:
   - `house-manager backup`: Timeout 1 day + grace 60 min
   - `house-manager reminders.tick`: smallest Timeout + grace, ≈15 min total (three missed 5-min ticks)
   - `house-manager search.reindex`: Timeout 1 day + grace 60 min

   The form has a preset Timeout plus a Grace period; totals are what matter. Never under 24 h on a daily job, or it pages every day. Each monitor shows a unique `https://sm.hetrixtools.net/hb/?s=<token>` URL; the `?s=` token is the secret. Also add a HetrixTools HTTP monitor on the public `/api/health`. There is no container monitor any more: the `reminders.tick` monitor is the worker's liveness signal (DOWN within 15 minutes of the worker dying or crash-looping).
3. **docker-piwine, via 1Password.** Add the two DSNs and the three HetrixTools URLs as fields on the `piwine-housemanager` item. Reference them from `compose.env` in the existing `HOUSEMANAGER_*` style (`HOUSEMANAGER_SENTRY_DSN`, `HOUSEMANAGER_SENTRY_BROWSER_DSN`, and replace the values behind `HOUSEMANAGER_BACKUP_HEARTBEAT_URL`, `HOUSEMANAGER_REMINDERS_TICK_HEARTBEAT_URL`, `HOUSEMANAGER_SEARCH_REINDEX_HEARTBEAT_URL`). Then in `housemanager/compose.yaml`:
   - `housemanager-web` → `SENTRY_DSN: ${HOUSEMANAGER_SENTRY_DSN}` and `SENTRY_BROWSER_DSN: ${HOUSEMANAGER_SENTRY_BROWSER_DSN}`
   - `housemanager-worker` → `SENTRY_DSN: ${HOUSEMANAGER_SENTRY_DSN}`, plus the three `*_HEARTBEAT_URL` vars (already there after #508/#509; only their values change)

   Open that as a docker-piwine PR. Use `op run` with `${VAR}` placeholders; don't source `compose.env` over SSH. The worker needs outbound HTTPS to `sm.hetrixtools.net`. (The planning session could not read docker-piwine, because `gh api` timed out on authorization. Check service names and style against the file first.)
4. **Optional: source maps.** Repository variables `SENTRY_ORG`, `SENTRY_PROJECT` (the browser project) and `SENTRY_URL` (GlitchTip's base URL), plus the repository secret `SENTRY_AUTH_TOKEN` (a GlitchTip auth token with release/upload scope). First confirm this GlitchTip version accepts `sentry-cli` debug-ID uploads. If it doesn't, leave all four unset: builds are unaffected.
5. **After the digest bump deploys this image**, recreate web and worker (a restart keeps the old env), then:
   - Worker: run the smoke command in `docs/observability.md` § Setting up GlitchTip step 5, and confirm one event arrives with tag `module: smoke` and a real release (7-char SHA, not `dev`).
   - Backup monitor: run the backup smoke test in `docs/backups.md` so HetrixTools gets its first ping. `reminders.tick` turns up within 5 minutes; `search.reindex` after the next 03:00 UTC run.
   - Browser: on a signed-in page, check the page source for the `sentry-browser-dsn` meta, then run `setTimeout(() => { throw new Error('house-manager browser Sentry smoke test') })` in the console.
   - Web server: there is no safe way to force a server error in prod. Task 10 Step 4 proved the path locally, and the first real one will show up tagged with its route.
6. **Remove the old uptime-kuma Push monitors** once the HetrixTools ones are green.

---

### Task 13: PR

- [ ] **Step 1: Rebase on current `main`**

```bash
git fetch origin
git rebase origin/main
```

Resolve conflicts without `--no-verify`. Likely overlaps: the `docs/README.md` env table and `CLAUDE.md`. Keep both sides. If anything was rebased, rerun Task 10 Steps 1–2.

- [ ] **Step 2: Check this plan for invisible characters and credentialed URLs, then copy it into the repo**

```bash
python3 - <<'EOF'
import re, sys, unicodedata
p = '.full-review/plans/2026-09-24-production-observability.md'
text = open(p, encoding='utf-8').read()
bad = [(i + 1, f'U+{ord(c):04X}') for i, line in enumerate(text.splitlines()) for c in line
       if unicodedata.category(c) in ('Cf', 'Zl', 'Zp') or (unicodedata.category(c) == 'Zs' and c != ' ')]
# Templated URLs are built from parts; the one literal allowed is the u:p@localhost
# fixture copied verbatim from tests/unit/env.test.ts, which CI's ggshield passes.
ALLOWED = {'postgresql://u:p@'}
creds = [m.group(0) for m in re.finditer(r'[a-z][a-z0-9+.-]*://[^\s/@`\'"]+:[^\s/@`\'"]+@', text)
         if '${' not in m.group(0) and m.group(0) not in ALLOWED]
print('invisible:', bad or 'clean')
print('credentialed URLs:', creds or 'none')
sys.exit(1 if bad or creds else 0)
EOF
[ -n "$GITGUARDIAN_API_KEY" ] && ggshield secret scan path .full-review/plans/2026-09-24-production-observability.md
cp .full-review/plans/2026-09-24-production-observability.md docs/superpowers/plans/2026-09-24-production-observability.md
git add docs/superpowers/plans/2026-09-24-production-observability.md
git commit -m "docs(plans): production observability implementation plan"
git log --oneline -1
```

Expected: `invisible: clean`, `credentialed URLs: none`, and ggshield (if the key is set) reports no incidents. The only credential-shaped URLs in this plan are built from `${…}` parts. If the check lists anything else, rewrite it from parts in the source plan, then copy.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin fix/production-observability
gh pr create --title "fix(observability): turn production error reporting on, without leaking what it reports" --body "$(cat <<'EOF'
Second half of the review's P1 "production error reporting is effectively off" (BP-H1, O-M6, DOC-M2). Built on the logging-and-heartbeats PR.

**Web server (BP-H1).** `instrumentation.ts` exports `onRequestError` → `captureRequestError`. Under Turbopack that is the only path by which Server Component, route handler and server action errors reach Sentry, and it didn't exist.

**Browser (BP-H1, O-M6).** `sentry.client.config.ts` never ran (webpack-only). It is replaced by `instrumentation-client.ts` with `onRouterTransitionStart`. The DSN is read at **runtime**: the root layout renders `SENTRY_BROWSER_DSN` into a `<meta>` per request, so one image serves every deployment. `NEXT_PUBLIC_SENTRY_DSN` is retired. Error boundaries report browser-thrown errors only; server errors (with a `digest`) come from `onRequestError`.

**Pino → Sentry bridge (DOC-M2).** `logger.error`/`fatal` with an Error becomes one event, tagged with the logger's module and event. `warn` never does, error lines without an Error never do, and an Error that was already captured is never sent twice (tested with the real SDK in both orders). SDK-free in `lib/observability/`; each SDK registers its reporter at init, so `@sentry/nextjs` never enters the worker graph. Retryable embed failures now log at warn; the false "Sentry picks it up" comments are gone.

**Privacy, verified end to end against a local envelope listener.**
- `request` is cut to method, query-less URL and User-Agent. Query strings are stripped from the URL, the transaction name and `request_path`.
- The log scrubber's patterns run over the event, **including the transaction name**: the SDK names requests by raw path, so a bridged error from the inbound webhook carried its token there.
- Incoming body capture is off in both HTTP integrations (10.75 ignores `dataCollection.httpBodies` for it).
- `tracePropagationTargets: []`: no `sentry-trace`/`baggage` (with the DSN key) to Voyage, Anthropic, ForwardEmail, Web Push or the monitors.
- An explicit `dataCollection` (off) replaces `sendDefaultPii`, which 11 removes. 11's default with no `dataCollection` collects cookies, headers, IPs and bodies.
- Network breadcrumbs are dropped; navigation breadcrumbs and browser stack frames lose their query strings.
- The web `httpIntegration` keeps `@sentry/nextjs`'s `disableIncomingRequestSpans` (a custom one replaces the default).

**Build (O-M6).** `withSentryConfig` comes from `@sentry/nextjs/config` (the bare import breaks in 11). Optional source-map upload runs on main when the `SENTRY_AUTH_TOKEN` secret and the `SENTRY_ORG`/`SENTRY_PROJECT`/`SENTRY_URL` variables exist. The smoke test asserts no `.map` ships. The webpack-only `treeshake` block is dropped.

**Dead-man monitors → HetrixTools** (owner decision): docs, env comments and owner steps now describe HetrixTools Cron Job monitors (15 min for reminders.tick, 25 h for the daily jobs, cron-schedule fallback). No code change: the jobs already GET the URL and never log it.

**Also fixed:**
- The worker released every event as `dev`: `lib/git-sha.ts` falls back to the runtime `GIT_SHA`.
- The worker dropped its fatal-startup and failed-shutdown events by exiting before the transport flushed.

**Owner steps after merge:**
1. GlitchTip: server project (+ optional browser project); copy DSNs.
2. docker-piwine: 1Password fields, then `HOUSEMANAGER_SENTRY_DSN` / `HOUSEMANAGER_SENTRY_BROWSER_DSN` in `compose.env`; web gets `SENTRY_DSN` + `SENTRY_BROWSER_DSN`, worker gets `SENTRY_DSN`.
3. HetrixTools Cron Job monitors: backup + search.reindex 1 day + 60 min grace, reminders.tick ≈15 min total; HTTP monitor on public `/api/health`; new URLs into docker-piwine; retire the uptime-kuma monitors.
4. Optional source maps: repo variables `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_URL` + secret `SENTRY_AUTH_TOKEN` (check GlitchTip accepts debug-ID uploads first).
5. After deploy: worker smoke command in `docs/observability.md` (check the release isn't `dev`); backup smoke test for the first ping; browser `setTimeout` throw.

Plan: `docs/superpowers/plans/2026-09-24-production-observability.md`.

Test plan: `pnpm verify`; `pnpm exec vitest run tests/integration/reminders-tick.test.ts tests/integration/search-reindex.test.ts tests/integration/missed-tick-recovery.test.ts tests/integration/pg-dump-restore.test.ts tests/integration/health.test.ts`; `pnpm test:e2e:local`; `pnpm build` + chunk/map inspection; local envelope check (onRequestError + bridge, all canaries 0); propagation probe; CI image smoke test.
EOF
)"
```

- [ ] **Step 4: Watch Sourcery first (background), then address its comments**

Run in the background (`run_in_background: true`), watching **only** the `Sourcery review` check:

```bash
PR=$(gh pr view --json number --jq .number)
until gh pr checks "$PR" --json name,state --jq '.[] | select(.name=="Sourcery review") | .state' | grep -qE 'SUCCESS|FAILURE|SKIPPED|NEUTRAL|CANCELLED'; do sleep 30; done
gh api "repos/{owner}/{repo}/pulls/$PR/reviews" --jq '.[] | select(.user.login | test("sourcery")) | .body'
gh api "repos/{owner}/{repo}/pulls/$PR/comments" --jq '.[] | select(.user.login | test("sourcery")) | {path, line, body}'
```

**Sourcery is budget-limited** (150k per PR, 500k per week), and its check says pass/skipping even when it hit a limit, so read the review **body**. This PR is large and may exceed the per-PR limit. If the body says it was rate-limited or skipped, there is nothing to address. Otherwise address real comments with new commits (explicit `git add`, verify HEAD moved, push). If Sourcery doesn't show up within about 20 minutes, check the PR page directly and continue.

- [ ] **Step 5: Enable auto-merge, then watch CI (background)**

```bash
gh pr merge --auto --squash
gh pr checks --watch --fail-fast   # run_in_background: true
```

On a failure, fix it, push, and watch again. Likely CI-only failures:

- **`build-image` / smoke:** `SMOKE FAIL: source maps shipped` means the SDK stopped deleting maps. Set `sourcemaps: { deleteSourcemapsAfterUpload: true, filesToDeleteAfterUpload: ['.next/static/**/*.map'] }` in `next.config.ts` rather than relaxing the check.
- **`build-image`:** a `secrets:` expression error means the `format(...)` line lost its quoting; compare with Task 6 Step 3.

Once merged:

```bash
gh pr view --json state --jq .state      # expect MERGED
git checkout main && git pull --ff-only && git branch -d fix/production-observability
```

---

## Acceptance criteria

- [ ] With `SENTRY_DSN` set, an error thrown by a Server Component, route handler or server action produces exactly one event.
- [ ] No event carries a request body, a cookie, a header other than `User-Agent`, a query string, or a real token in `url`, `request_path` or `transaction` (Task 10 Step 4: every canary 0).
- [ ] No outgoing request carries `sentry-trace` or `baggage`; no navigation breadcrumb or browser frame path carries a query string.
- [ ] No uptime-kuma reference remains outside test fixtures; the three dead-man monitors are documented as HetrixTools Cron Job monitors.
- [ ] With `SENTRY_BROWSER_DSN` set, every dynamic page carries the meta and the browser SDK initialises; unset, no meta and no init.
- [ ] `logger.error`/`fatal` with an Error produces one event in web and worker; `warn`, error lines without an Error, and already-captured Errors produce none.
- [ ] Worker events carry the real release; the fatal-startup and failed-shutdown events are flushed before exit.
- [ ] No DSN is baked into the image; no `.map` file ships; source maps upload only on main when the token exists.
- [ ] `withSentryConfig` comes from `@sentry/nextjs/config`; nothing uses `sendDefaultPii`.
- [ ] `pnpm verify` is green.

## Deliberately out of scope

- **Reporting pg-boss job failures.** A handler that throws is retried and then marked `failed` in `pgboss.job`, and nothing reads that. A follow-up could wrap each `boss.work` callback to log `{ err, queue, event: 'job.failed' }` at error level on the **final** attempt only (compare the job's `retryCount` with `retryLimit`), which the bridge would then report once per job rather than once per retry. The dead-man pings (logging-and-heartbeats plan) cover the three jobs where silence matters most.
- **The `@sentry/*` 11 bump itself.** This PR removes the known breakers; `docs/observability.md` § Upgrading lists what to re-check (including the two `maxIncomingRequestBodySize` lines, which will stop type-checking on purpose).
- **Trimming the browser bundle** (dynamic import, or filtering out `browserTracingIntegration`). See design decision 9.
- **Moving worker Sentry init into a `--import` preload** for pg/http auto-instrumentation (DOC-L2's footnote). Tracing is off, so nothing needs it.
