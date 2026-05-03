# Plan 5a — Observability: structured logging + error reporting

**Date:** 2026-05-03
**Status:** Draft for review
**Authors:** Oliver Wine (with Claude)
**Parent spec:** `docs/superpowers/specs/2026-04-26-house-manager-design.md`
**Builds on:** Plans 1, 2a, 2b, 2c, 3, 4a, 4ab, 4b — all shipped to main as of 2026-05-03.

## Overview

Plan 4b shipped a lot of new code paths (AI Server Actions, mock harnesses, entry-point components, admin pages) and left a series of `TODO(plan-5)` markers in the codebase pointing at `console.log({event,...})` placeholders that should become real structured-log calls. The repo currently has no logger module, no error reporter, and no consistent way to see what's happening at runtime. Plan 5a fixes the **app-side instrumentation** half of that gap.

**Scope:** add a Pino structured logger and the `@sentry/nextjs` SDK to the codebase. Both are gated by optional environment variables — if `SENTRY_DSN` is unset, Sentry calls no-op; if `LOG_LEVEL` is unset, the logger uses sensible defaults. The app must keep running on a fresh checkout with no observability infrastructure available.

**Out of scope:** standing up the receiving infrastructure (GlitchTip container, Loki + Promtail + Grafana stack). That is a homelab-side effort tracked separately. Plan 5a's deliverable is "the app emits structured logs and reports errors when those tools are wired up later," not "the homelab observability stack is running."

This is the first of four Plan 5 milestones. Plan 5b will add reliability work (reminder dedupe sweeper, missed-tick recovery, Postgres backup strategy). Plan 5c will cover UX polish (server-side autocomplete, type-aware metadata renderer, a11y audit). Plan 5d will add test infrastructure (Meilisearch opt-in for `setupIntegration`, Anthropic mock server for AI E2E specs).

## Goals

1. Replace every `console.log({event,...})` / `console.error` / `console.warn` site in `lib/` and `worker/` with a Pino structured-logger call.
2. Capture uncaught and explicitly-reported exceptions across Server Actions, route handlers, worker job handlers, and the browser via `@sentry/nextjs`.
3. Tag every Sentry event with `release: APP_GIT_SHA` (already exposed by the version-footer commit) and `environment: NODE_ENV`.
4. Keep the app fully functional with neither `SENTRY_DSN` nor `LOG_LEVEL` set. New env vars are all optional.
5. Add minimal unit-test coverage for the logger module (child loggers carry module fields; redaction works on known sensitive keys; level filtering respected).
6. Document the new env vars in the same places Plan 4b did (`lib/env.ts`, `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml`).

## Non-goals

- **Standing up GlitchTip / Loki / Grafana / Promtail containers.** Homelab work, separate from this app's plan.
- **OpenTelemetry / distributed tracing.** Out of scope until there are multiple services to trace across.
- **Metrics export (Prometheus, etc.).** Same reasoning. Defer indefinitely until there's a specific question metrics would answer.
- **Browser-side `logger`.** Browsers don't ship logs anywhere meaningful in this design — only browser **errors** flow through Sentry. Adding a browser logger is a separate decision.
- **Sentry performance tracing.** `tracesSampleRate: 0`. We don't need it; reduces event volume; can be flipped on later.
- **Pino transports.** Worker-thread transports add Next.js bundling complexity for negligible practical benefit. We log JSON to stdout and use `pino-pretty` as an optional shell pipe in dev.
- **Replacing `console.*` in tests, scripts, or `prisma/seed.ts`.** Those are not part of the running app.
- **Source-map upload as a hard requirement.** Wired via optional `SENTRY_AUTH_TOKEN`. CI/dev builds without the token skip the upload silently.

## Architecture

### Two parallel pipes

```
┌─ App code ─────────────────────────────────────────────────┐
│   log.info({event, ...ctx}, 'message')   ──────────────┐   │
│   log.error({err, ...ctx}, 'failed')  ──┬──────────────┤   │
│   throw new Error(...)            ──────┘              │   │
└─────────────────────────────────────────────────────────┼───┘
                                                         │
       ┌─ Pino singleton ─────────────────────────────┐  │
       │  JSON to stdout, level from LOG_LEVEL env    │◄─┘
       │  (everything goes through this path)         │
       └─────────────────────┬────────────────────────┘
                             │
              ┌──────────────▼──────────────┐
              │  docker logs (and later:    │
              │  Loki via Promtail)         │
              └─────────────────────────────┘

       ┌─ @sentry/nextjs ─────────────────────────────┐
       │  Server SDK (instrumentation.ts)             │
       │  Browser SDK (sentry.client.config.ts)       │◄─ exceptions only
       │  Init guards on SENTRY_DSN being set         │
       └─────────────────────┬────────────────────────┘
                             │  (only when DSN set)
              ┌──────────────▼──────────────┐
              │  GlitchTip                  │
              │  → email / webhook alert    │
              └─────────────────────────────┘
```

The two pipes are intentionally independent:

- **Logs are the complete record.** Every event a function emits via `log.*` ends up in stdout, regardless of Sentry's status.
- **Sentry is the alerting layer.** Only exceptions flow through it. If GlitchTip is down or unreachable, the SDK queues internally with a bounded buffer and drops silently after timeout. Logs still capture the same error context.

This separation means the app degrades gracefully: with no `SENTRY_DSN` set, logs work normally and you can inspect errors via `docker logs`. With a real DSN, you additionally get alerts. There's no scenario where adding observability infrastructure breaks the app's primary log-emission path.

### Components

**New files:**

| File | Purpose |
|---|---|
| `lib/logger.ts` | Pino singleton + `getLogger(module: string)` helper that returns a child logger with the `module` field bound. ~25 LOC. |
| `instrumentation.ts` | Next.js Server-side Sentry init. File at repo root per Next 15 convention. `register()` is a no-op when `SENTRY_DSN` is unset. |
| `sentry.client.config.ts` | Browser SDK init. Same DSN gate. |
| `tests/unit/logger.test.ts` | ~6 cases: child loggers carry `module`; redaction works on `apiKey` / `token` / cookie; level filtering respected. |

**Modified files:**

| File | Change |
|---|---|
| `lib/env.ts` | Add `SENTRY_DSN: z.string().url().optional()`, `SENTRY_AUTH_TOKEN: z.string().optional()`, `LOG_LEVEL: z.enum(['fatal','error','warn','info','debug','trace']).optional()`. |
| `next.config.ts` | Wrap export with `withSentryConfig({...}, { silent: true, ... })`. Source-map upload only runs when `SENTRY_AUTH_TOKEN` is set. |
| `worker/index.ts` | Early `Sentry.init` (Node-side, same DSN gate) so pg-boss job exceptions are captured. |
| `app/global-error.tsx` | Add `Sentry.captureException(error)` in the boundary handler. |
| `package.json` | New deps: `pino`, `@sentry/nextjs`. New devDep: `pino-pretty`. |
| `Dockerfile` | `ARG SENTRY_DSN` + `ARG SENTRY_AUTH_TOKEN` build-args (so source-map upload can fire); pass through as `ENV` for runtime. |
| `docker-compose.yml` | Add the same env vars (commented placeholders for now). |
| `.github/workflows/ci.yml` | Add the env vars to the e2e job env block (placeholder values). |

### console.* replacement scope

Grep for every `console.log` / `console.error` / `console.warn` in `lib/`, `worker/`, and `app/`. Convert each:

| Site type | Replacement |
|---|---|
| `TODO(plan-5)` markers in `lib/ai/suggest/{reminders,checklist}.ts` | `log.info({ event, ... })` |
| `console.error` in catch blocks across the codebase | `log.error({ err, ...ctx }, msg)` plus `Sentry.captureException(err)` for boundary-level errors |
| `console.warn` in `saveAccepted*` (markAccepted / enqueueSearchIndex try/catch from Plan 4b cleanup) | `log.warn({ err, ... }, msg)` |
| Worker job lifecycle (startup/shutdown logs) | `log.info({...}, msg)` |
| `console.*` in tests, scripts, `prisma/seed.ts` | **leave alone** |

**Module-naming convention:** dot-separated path that mirrors the file location, dropping the `lib/` prefix.

| File | Logger name |
|---|---|
| `lib/ai/suggest/reminders.ts` | `ai.suggest.reminders` |
| `lib/ai/suggest/checklist.ts` | `ai.suggest.checklist` |
| `worker/jobs/notify.ts` | `worker.notify` |
| `worker/index.ts` | `worker.lifecycle` |

This makes Loki/Grafana queries trivial later: `{module=~"ai.suggest.*"}` returns every Suggest event.

## Data flow

**Logs (always-on):**

1. Module imports `getLogger('foo.bar')` from `@/lib/logger`.
2. Calls `log.info({ event: 'thing.happened', userId, ... }, 'human-readable message')`.
3. Pino formats as JSON, writes to stdout.
4. Docker captures stdout into the container's log stream. `docker logs <container>` shows raw JSON.
5. Later (homelab work, not Plan 5a): Promtail tails container logs, ships to Loki, Grafana queries by labels.

**Errors (DSN-gated):**

1. Code throws or explicitly calls `Sentry.captureException(err, { contexts: ... })`.
2. `@sentry/nextjs` builds an event payload (stack trace, breadcrumbs, request context, release tag, environment).
3. SDK POSTs to the configured DSN. Bounded queue handles transient unavailability.
4. GlitchTip groups by stack-trace fingerprint and fires the alert channel for new issue types.
5. The same throw is also caught at the Server Action / route handler boundary and turned into a structured `log.error(...)` call. Errors appear in **both** pipes.

## Error handling in the new code itself

| Failure mode | Behavior |
|---|---|
| `SENTRY_DSN` unset | `Sentry.captureException` is a no-op. No errors emitted. |
| `SENTRY_DSN` malformed | Fails Zod validation in `lib/env.ts` at boot. Container won't start. (Loud failure beats silent misroute.) |
| GlitchTip unreachable | Sentry SDK queues internally with bounded buffer, drops silently after timeout. Logs still capture the underlying error. |
| `pino-pretty` dev pipe crashes | Raw JSON in stdout. Dev workflow degrades; app keeps running. |
| Pino can't write to stdout (e.g., closed pipe) | Falls through silently; not catastrophic. |

## Privacy and redaction

**Pino:** `redact` paths cover known sensitive keys at logger construction:

```
['*.apiKey', '*.token', '*.secret', 'req.headers.cookie', 'req.headers.authorization']
```

Redacted values appear as `[Redacted]` in output. Glob-style paths catch the keys regardless of nesting depth.

**Sentry:** `sendDefaultPii: false` (SDK default; explicitly stated for clarity). `beforeSend` hook strips `request.cookies` and any `user.email` field before transmission. We have no other PII-shaped data; the redaction is defensive against future additions.

## Testing strategy

| Test | Purpose |
|---|---|
| `tests/unit/logger.test.ts` | Asserts: `getLogger('foo')` returns a child with `module: 'foo'`; redact rules drop `apiKey` / `token` / cookie values; level filtering (debug calls invisible at info level). ~6 cases. |
| Existing test suite | Must stay 100% green. Grep for `vi.spyOn(console, 'log')` first; convert any if found. (Quick read says there are none in the existing 222 unit / 142 integration tests.) |
| Smoke test for `instrumentation.ts` | Verify `register()` runs without crashing when DSN is unset. ~1 test. |
| Sentry integration test | **Skip.** Mocking `@sentry/nextjs` cleanly is messy and the value is low. The SDK contract is the unit boundary — trust the SDK. |

## Operational surface

**Environment variables (all optional):**

| Var | Purpose | Default |
|---|---|---|
| `SENTRY_DSN` | GlitchTip / Sentry endpoint URL. Sentry init is no-op when unset. | unset |
| `SENTRY_AUTH_TOKEN` | Source-map upload during prod build. Build skips upload when unset. | unset |
| `LOG_LEVEL` | Pino level (`fatal`/`error`/`warn`/`info`/`debug`/`trace`). | `info` in prod, `debug` in dev |

**Files that must be touched together (the env-var trap from Plan 4a):**

1. `lib/env.ts` — Zod schema additions (`.optional()`)
2. `Dockerfile` — `ARG` + `ENV` lines for build-arg passthrough
3. `docker-compose.yml` — env var entries (commented placeholders)
4. `.github/workflows/ci.yml` — e2e job env block

**Dev workflow:**

- `pnpm dev` continues to emit raw JSON. Document `pnpm dev | pnpm exec pino-pretty` as the optional human-readable pipe for casual reading.
- We don't bake the `pino-pretty` pipe into `pnpm dev` itself because it breaks `pnpm dev | grep ...` patterns and adds a process to manage.

**Release tagging:**

- Sentry events tagged with `release: APP_GIT_SHA` (the 7-char value already exported by `lib/version.ts` — reuses what the version-footer commit shipped) and `environment: NODE_ENV`.
- Source maps uploaded under the same `release` value, so stack traces in GlitchTip get auto-symbolicated.

**Documentation:**

A new `docs/observability.md` (~30 lines): what the JSON log lines look like, how to enable Sentry once GlitchTip is running, env-var summary, the dev pipe trick.

## Risks and open questions

1. **Pino + Next.js bundling.** Pino works fine in Node-side code (Server Actions, route handlers, worker). Importing it in client components would crash at build time because Pino has Node-only dependencies. The `getLogger` helper should be Node-only; if a client component needs to log something, that's a design smell — re-shape the call into a Server Action instead.

2. **`@sentry/nextjs` bundle impact on the browser.** The browser SDK is ~30KB gzipped. Acceptable. If concerned, the `tunnel` option can ship events through a same-origin route instead of cross-origin to GlitchTip.

3. **Test ordering.** Adding `Sentry.init` at module load (via `instrumentation.ts`) could affect Vitest startup. Verify no existing test imports trip the Sentry init path; if they do, the init is already gated on `SENTRY_DSN` so it should no-op cleanly. Worth confirming during execution.

4. **`withSentryConfig` and Turbopack.** If Next.js's Turbopack mode is in use (`pnpm dev --turbo`), `withSentryConfig`'s webpack-side hooks are irrelevant. Source-map upload happens during `pnpm build`, which uses webpack regardless. Should be a non-issue but flag it.

5. **Worker process and Sentry init.** The worker (`tsx worker/index.ts`) doesn't go through Next.js's `instrumentation.ts`. It needs its own `Sentry.init` call early in `worker/index.ts`. Care needed: the SDK has different entry points for Node vs Edge vs Next.js; use `@sentry/node` directly in the worker if `@sentry/nextjs`'s Node entry is awkward.

6. **The `LOG_LEVEL` env var trap on the worker.** The worker runs as a separate process with its own `process.env`. Both the Next.js app and the worker need to read the same `LOG_LEVEL` for consistency. Already handled by docker-compose + `.env` defaults; flag it for the implementer.

## Acceptance criteria

- [ ] Every `console.log` / `console.error` / `console.warn` call in `lib/` and `worker/` is replaced with a Pino call.
- [ ] `lib/logger.ts` exports a `getLogger(module: string)` helper.
- [ ] Redaction works on `apiKey`, `token`, `secret`, `cookie`, `authorization` keys regardless of nesting.
- [ ] `instrumentation.ts` and `sentry.client.config.ts` exist and conditionally init only when `SENTRY_DSN` is set.
- [ ] `worker/index.ts` initializes Sentry separately for the Node process.
- [ ] `app/global-error.tsx` calls `Sentry.captureException`.
- [ ] All new env vars are added to `lib/env.ts`, `Dockerfile`, `docker-compose.yml`, and `.github/workflows/ci.yml`.
- [ ] `tests/unit/logger.test.ts` covers child fields, redaction, and level filtering.
- [ ] Existing 222 unit + 142 integration + 6 E2E tests stay green.
- [ ] `pnpm verify` clean.
- [ ] `docs/observability.md` documents the env vars and the dev pipe.
- [ ] App runs cleanly with neither `SENTRY_DSN` nor `LOG_LEVEL` set (no crashes, no dropped behavior).
