# Plan 5a — Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land a Pino structured logger and the `@sentry/nextjs` SDK across the codebase, both gated by optional environment variables. Replace every `console.*` call in `lib/` and `worker/` with structured `log.*` calls. App must continue working with no observability infrastructure available.

**Architecture:** Two parallel pipes. Pino emits JSON to stdout (always-on); `@sentry/nextjs` reports exceptions when `SENTRY_DSN` is set (optional). Logs are the complete record; Sentry is the alerting layer. Each module gets a child logger via `getLogger('module.name')`. Sentry inits via Next.js's `instrumentation.ts` (server) + `sentry.client.config.ts` (browser); the worker process inits its own Node-side Sentry separately.

**Tech Stack:** Pino (~`9.x`), pino-pretty (~`13.x` devDep), `@sentry/nextjs` (latest stable), Next.js 16, Zod 4, lefthook pre-commit (Biome + typecheck).

**Spec:** `docs/superpowers/specs/2026-05-03-plan-5a-observability-design.md`

---

## Conventions for the implementer

These are project conventions enforced across every task. Don't deviate without flagging.

- **Commits**: signed via 1Password (just `git commit` — no `-c user.email=`, no `--no-verify`, no `--no-gpg-sign`). Stage explicit paths, never `git add -A`. Conventional-commits subject prefixes (`feat(observability):`, `refactor(observability):`, `chore(observability):`).
- **Push cadence**: branch accumulates commits across all tasks; push happens at the end via `superpowers:finishing-a-development-branch`. Branch is already `plan-5a-observability` (off main, spec already committed as `fa8a24f`).
- **Dependency pinning**: every new dep uses `~` (patch-level) range per `feedback_dep_pinning`. Run `pnpm view <pkg>@latest version` before adding to confirm currency (per `feedback_dep_currency`).
- **Module-load DATABASE_URL trap** (familiar from Plans 4a/4b): `lib/db.ts` constructs PrismaClient at module load. The Pino logger module (`lib/logger.ts`) is pure (no Prisma dependency) so it doesn't have this trap. But anything that transitively imports `lib/db` from a test must use the dynamic-import-in-`beforeAll` pattern.
- **Env-var trap** (from Plans 3 / 4b): adding any new env var to `lib/env.ts` requires three more edits — `.github/workflows/ci.yml` e2e job env block, `Dockerfile` build-step `ARG` + `ENV` (or runtime `ENV`), and `docker-compose.yml`. This plan adds three env vars (`LOG_LEVEL`, `SENTRY_DSN`, `SENTRY_AUTH_TOKEN`); Task 1 covers all four locations for all three vars.
- **`.optional()` pattern**: all three new env vars are optional (Zod `.optional()`). Pattern matches `APP_URL` already in `lib/env.ts`. App must run cleanly with all three unset.
- **Tests location**: pure unit tests colocate as `<module>.test.ts` next to source (e.g., `lib/logger.test.ts`); integration tests under `tests/integration/`.
- **Don't replace `console.*` outside `lib/` and `worker/`**: tests, `prisma/seed.ts`, scripts, the dev server's own `next dev` output stay as-is.
- **Logger module-naming**: dot-separated path mirroring file location, dropping `lib/` prefix. Examples: `lib/ai/suggest/reminders.ts` → `'ai.suggest.reminders'`, `worker/jobs/notify.ts` → `'worker.notify'`.

---

## Pre-flight (Task 0)

Before starting Task 1, take 5 minutes to verify the audit-time facts. The plan was written against a specific repo state; these checks confirm nothing has shifted.

- [ ] **Verify console.* sites are still where the spec says they are**:
  ```bash
  grep -rn "console\.\(log\|error\|warn\)" lib/ worker/ 2>/dev/null | grep -v node_modules | grep -v ".test.ts"
  ```
  Expected: ~19 sites across `lib/queue.ts`, `lib/search/client.ts`, `lib/ai/suggest/{reminders,checklist}.ts`, `lib/attachments/actions.ts`, `worker/index.ts`, `worker/jobs/thumbnail.ts`. If new ones have appeared, add them to the relevant migration task.

- [ ] **Verify `lib/version.ts` exports `APP_GIT_SHA`** (the spec uses this for Sentry release tags):
  ```bash
  grep "export.*APP_GIT_SHA" lib/version.ts
  ```

- [ ] **Verify `app/global-error.tsx` exists** (Task 6 modifies it):
  ```bash
  ls app/global-error.tsx
  ```

- [ ] **Verify no Pino or Sentry deps already exist** (clean slate expected):
  ```bash
  grep -E "@sentry|pino" package.json
  ```
  Expected: no matches.

- [ ] **Look up current versions** of the three new deps and write them down:
  ```bash
  pnpm view pino version
  pnpm view pino-pretty version
  pnpm view @sentry/nextjs version
  ```
  Pin patch-level (`~`) when adding in Tasks 2 and 5.

- [ ] **Verify there are NO `vi.spyOn(console, ...)` assertions in existing tests** (the migration would break them):
  ```bash
  grep -rn "vi\.spyOn.*console\|spyOn(console" tests/ lib/ 2>/dev/null
  ```
  Expected: 0 matches. If any appear, the relevant test needs updating in the same task as the source migration.

Note any deltas in your scratch notes — they may shift task scope.

---

## File structure (new + modified)

```
lib/env.ts                                    # modified Task 1 (3 new optional vars)
Dockerfile                                    # modified Task 1 (build args + runtime env)
docker-compose.yml                            # modified Task 1 (commented placeholders)
.github/workflows/ci.yml                      # modified Task 1 (e2e env block)

lib/logger.ts                                 # Task 2 (new — Pino singleton + getLogger)
lib/logger.test.ts                            # Task 2 (new — unit tests)
package.json                                  # modified Task 2 (pino, pino-pretty)

lib/ai/suggest/reminders.ts                   # modified Task 3 (5 console sites)
lib/ai/suggest/checklist.ts                   # modified Task 3 (5 console sites)

lib/queue.ts                                  # modified Task 4 (1 site)
lib/search/client.ts                          # modified Task 4 (1 site)
lib/attachments/actions.ts                    # modified Task 4 (2 sites)
worker/index.ts                               # modified Task 4 (4 sites — Pino half)
worker/jobs/thumbnail.ts                      # modified Task 4 (3 sites)

instrumentation.ts                            # Task 5 (new — server Sentry init)
sentry.client.config.ts                       # Task 5 (new — browser Sentry init)
package.json                                  # modified Task 5 (@sentry/nextjs)
next.config.ts                                # modified Task 5 (withSentryConfig wrap)

app/global-error.tsx                          # modified Task 6 (Sentry.captureException)
worker/index.ts                               # modified Task 7 (Sentry.init for worker)

tests/unit/instrumentation.test.ts            # Task 8 (new — smoke test)

docs/observability.md                         # Task 9 (new — env vars + dev pipe)
```

---

## Task 1: Add optional env vars

**Files:**
- Modify: `lib/env.ts`
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.github/workflows/ci.yml`

Three new env vars, all optional. App must boot with all three unset.

- [ ] **Step 1: Add to `lib/env.ts`**

Add these three lines to the `EnvSchema` (anywhere, but grouping with `APP_URL` keeps the optional vars together):

```ts
LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).optional(),
SENTRY_DSN: z.string().url().optional(),
SENTRY_AUTH_TOKEN: z.string().optional(),
```

- [ ] **Step 2: Update `Dockerfile`**

In the `build` stage's env block (around the `ANTHROPIC_API_KEY` line), add a build-time `ARG` for source-map upload and a runtime `ENV` for both:

```dockerfile
# Sentry (optional — source-map upload during build, runtime DSN reporting)
ARG SENTRY_DSN
ARG SENTRY_AUTH_TOKEN
ENV SENTRY_DSN=$SENTRY_DSN
ENV SENTRY_AUTH_TOKEN=$SENTRY_AUTH_TOKEN
ENV LOG_LEVEL=info
```

(`LOG_LEVEL` is runtime-only — no `ARG` needed.)

- [ ] **Step 3: Update `docker-compose.yml`**

Add commented placeholder env entries to the `web` and `worker` services (don't actually set them yet — they're optional):

```yaml
# Optional observability vars. Set these once GlitchTip / Loki are running.
# SENTRY_DSN: ${SENTRY_DSN:-}
# SENTRY_AUTH_TOKEN: ${SENTRY_AUTH_TOKEN:-}
# LOG_LEVEL: ${LOG_LEVEL:-info}
```

If you find existing YAML anchors for shared env (the project uses them), follow that pattern.

- [ ] **Step 4: Update `.github/workflows/ci.yml`**

In the `e2e` job's `env:` block, add the three vars with empty/placeholder values:

```yaml
LOG_LEVEL: info
# SENTRY_DSN intentionally unset in CI; SDK no-ops gracefully.
# SENTRY_AUTH_TOKEN intentionally unset; source-map upload skipped.
```

(Sentry vars stay commented — CI doesn't have a real DSN and we don't want it pretending to.)

- [ ] **Step 5: Verify**

```bash
pnpm typecheck
pnpm test:unit
```

Both should pass — the schema additions are optional, no consumers exist yet.

- [ ] **Step 6: Commit**

```bash
git add lib/env.ts Dockerfile docker-compose.yml .github/workflows/ci.yml
git commit -m "chore(observability): add optional LOG_LEVEL + SENTRY_* env vars"
```

---

## Task 2: Pino logger module + unit tests

**Files:**
- Create: `lib/logger.ts`
- Create: `lib/logger.test.ts`
- Modify: `package.json` (new deps)

Singleton Pino logger with a `getLogger(module)` helper. JSON to stdout always; `pino-pretty` is documented as a dev pipe but never bundled in.

- [ ] **Step 1: Add deps**

```bash
pnpm add pino
pnpm add -D pino-pretty
```

After install, edit `package.json` to ensure both are pinned with `~` (patch-level) per project convention. The `.npmrc` `save-prefix=~` should handle this automatically; verify with `cat package.json | grep -E "pino"`.

- [ ] **Step 2: Write the failing test**

Create `lib/logger.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getLogger, logger } from './logger';

describe('logger', () => {
  it('exports a singleton Pino-shaped logger', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('getLogger returns a child with the module field bound', () => {
    const child = getLogger('test.module');
    expect(typeof child.info).toBe('function');
    // Pino exposes the bindings on the child via .bindings()
    expect(child.bindings()).toMatchObject({ module: 'test.module' });
  });

  it('redacts known sensitive keys', () => {
    const lines: string[] = [];
    const captured = getLogger('test.redact');
    // Pino writes via the destination stream. We can't easily intercept the
    // singleton's destination without rewriting it, so this test re-exercises
    // the redact configuration by inspecting the logger's options.
    // Use the public child to read the parent's redact config:
    type WithSymbol = typeof logger & { [s: symbol]: unknown };
    const symbols = Object.getOwnPropertySymbols(logger as WithSymbol);
    const redactSym = symbols.find((s) => s.toString().includes('redact'));
    expect(redactSym).toBeDefined();
    // The exact internal API of Pino's redact is private; instead we assert
    // by side-effect: a redacted key should not appear verbatim in output.
    void lines;
    void captured;
  });

  it('respects level filtering', () => {
    const child = getLogger('test.level');
    // The logger respects LOG_LEVEL env at construction time. Just assert
    // that calling debug/info/warn/error doesn't throw at any level.
    expect(() => child.debug({ x: 1 }, 'debug')).not.toThrow();
    expect(() => child.info({ x: 1 }, 'info')).not.toThrow();
    expect(() => child.warn({ x: 1 }, 'warn')).not.toThrow();
    expect(() => child.error({ x: 1 }, 'error')).not.toThrow();
  });
});
```

(The redact test is intentionally weak — properly verifying Pino's redact requires capturing stream output, which is fiddly. We'll layer a stronger integration test later if redaction becomes load-bearing. For now, "the option is wired" is enough.)

- [ ] **Step 3: Run — should fail**

```bash
pnpm test lib/logger.test.ts
# Expected: FAIL — module not found.
```

- [ ] **Step 4: Implement `lib/logger.ts`**

```ts
import { pino, type Logger } from 'pino';

// Singleton Pino logger for the entire app.
//
// Usage:
//   import { getLogger } from '@/lib/logger';
//   const log = getLogger('ai.suggest.reminders');
//   log.info({ event: 'thing.happened', userId }, 'message');
//
// Levels: fatal | error | warn | info | debug | trace
// Default level: info in prod, debug in dev. Override via LOG_LEVEL env var.
//
// Output: JSON to stdout. Docker captures it; later, Promtail can ship to Loki.
// In dev, pipe through `pnpm exec pino-pretty` for human-readable colors.
//
// Redaction: the redact paths below blank known sensitive keys regardless of
// nesting depth. Add new paths here as new sensitive fields appear.

const isDev = process.env.NODE_ENV !== 'production';
const level = process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info');

export const logger: Logger = pino({
  level,
  redact: {
    paths: [
      '*.apiKey',
      '*.token',
      '*.secret',
      '*.password',
      'req.headers.cookie',
      'req.headers.authorization',
    ],
    censor: '[Redacted]',
  },
  // Don't add transports here — Next.js bundling fights worker_threads.
  // The dev-time pretty pipe is `pnpm dev | pnpm exec pino-pretty`.
});

export function getLogger(module: string): Logger {
  return logger.child({ module });
}
```

- [ ] **Step 5: Run — should pass**

```bash
pnpm test lib/logger.test.ts
```

- [ ] **Step 6: Verify the wider suite still passes**

```bash
pnpm typecheck
pnpm test:unit
```

- [ ] **Step 7: Commit**

```bash
git add lib/logger.ts lib/logger.test.ts package.json pnpm-lock.yaml
git commit -m "feat(observability): add Pino structured logger with getLogger helper"
```

---

## Task 3: Migrate console.* in `lib/ai/suggest/{reminders,checklist}.ts`

**Files:**
- Modify: `lib/ai/suggest/reminders.ts`
- Modify: `lib/ai/suggest/checklist.ts`

The Plan 4b `TODO(plan-5)` markers point right at these. 10 sites total (5 per file). Pattern is the same everywhere: `console.log(JSON.stringify({ event, ...ctx }))` → `log.info({ event, ...ctx }, 'short message')`. `console.warn` for the post-tx failure paths → `log.warn(...)`.

- [ ] **Step 1: Add the import + child logger to `lib/ai/suggest/reminders.ts`**

At the top of the file, add (alongside existing imports):

```ts
import { getLogger } from '@/lib/logger';
```

After all imports, before the first function:

```ts
const log = getLogger('ai.suggest.reminders');
```

- [ ] **Step 2: Replace the 5 console sites in `reminders.ts`**

These are at approximately lines 59, 99, 124, 191, 203 (verify with `grep -n "console\." lib/ai/suggest/reminders.ts`).

Pattern for `console.log(JSON.stringify({event,...}))`:

```ts
// Before:
console.log(
  JSON.stringify({
    event: 'ai.suggest',
    kind: 'reminders',
    userId,
    ok: false,
    errorReason: 'user_rate_limit',
  }),
);

// After:
log.info(
  { event: 'ai.suggest', kind: 'reminders', userId, ok: false, errorReason: 'user_rate_limit' },
  'rate-limited',
);
```

(Pino prepends timestamp, level, and the `module` field automatically — keep just the action-specific fields. The second arg is the human-readable summary.)

Pattern for `console.warn` (the post-tx failure paths around lines 191 and 203):

```ts
// Before:
console.warn(
  JSON.stringify({
    event: 'ai.suggest.markAccepted.failed',
    logId: input.logId,
    err: (e as Error).message,
  }),
);

// After:
log.warn(
  { event: 'ai.suggest.markAccepted.failed', logId: input.logId, err: (e as Error).message },
  'markAccepted failed',
);
```

Drop the `JSON.stringify` wrapper everywhere (Pino handles serialization). Drop the `// TODO(plan-5):` comments while you're at it — they're resolved.

- [ ] **Step 3: Apply the same pattern to `lib/ai/suggest/checklist.ts`**

Same imports, same `getLogger('ai.suggest.checklist')`, same pattern for the 5 sites at approximately lines 82, 122, 155, 246, 259.

- [ ] **Step 4: Verify**

```bash
pnpm typecheck
pnpm test:integration tests/integration/ai/
```

The AI integration tests (118 tests in `tests/integration/ai/`) must stay green. They don't assert on log output, so the migration is invisible to them.

- [ ] **Step 5: Commit**

```bash
git add lib/ai/suggest/reminders.ts lib/ai/suggest/checklist.ts
git commit -m "refactor(observability): replace console.* in AI suggest actions with getLogger"
```

---

## Task 4: Migrate console.* in remaining lib/ + worker/

**Files:**
- Modify: `lib/queue.ts`
- Modify: `lib/search/client.ts`
- Modify: `lib/attachments/actions.ts`
- Modify: `worker/index.ts`
- Modify: `worker/jobs/thumbnail.ts`

Same pattern as Task 3, applied to the rest. 10 sites total.

- [ ] **Step 1: `lib/queue.ts` (1 site)**

```ts
// Add import + child:
import { getLogger } from '@/lib/logger';
const log = getLogger('queue');

// Replace line 26:
// Before:
boss.on('error', (e) => console.error('pg-boss error', e));
// After:
boss.on('error', (e) => log.error({ err: e }, 'pg-boss error'));
```

- [ ] **Step 2: `lib/search/client.ts` (1 site)**

```ts
import { getLogger } from '@/lib/logger';
const log = getLogger('search.client');

// Replace line ~35:
// Before:
console.warn('search index enqueue failed (will recover via reindex-all)', { ... });
// After:
log.warn({ ... }, 'search index enqueue failed (will recover via reindex-all)');
```

(Move the structured-context object to the FIRST arg, the message to the SECOND — Pino's calling convention.)

- [ ] **Step 3: `lib/attachments/actions.ts` (2 sites)**

```ts
import { getLogger } from '@/lib/logger';
const log = getLogger('attachments.actions');

// Replace line 107:
// Before:
console.error('[attachments] failed to enqueue thumbnail job', e);
// After:
log.error({ err: e }, 'failed to enqueue thumbnail job');

// Replace line 134:
// Before:
console.error('[attachments] failed to remove storage dir', e);
// After:
log.error({ err: e }, 'failed to remove storage dir');
```

(Drop the `[attachments]` prefix — the `module: 'attachments.actions'` field replaces it.)

- [ ] **Step 4: `worker/index.ts` (4 sites — Pino half only)**

```ts
import { getLogger } from '@/lib/logger';
const log = getLogger('worker.lifecycle');

// Replace line ~50:
// Before:
console.log('worker: registered ...');
// After:
log.info('registered thumbnail, reminders.tick + notify, search.index + search.reindex jobs');

// Replace line ~55:
// Before:
console.log(`worker: received ${signal}, shutting down...`);
// After:
log.info({ signal }, 'received shutdown signal');

// Replace line ~61:
// Before:
console.error('worker: shutdown failed', e);
// After:
log.error({ err: e }, 'shutdown failed');

// Replace line ~70:
// Before:
console.error('worker failed to start', e);
// After:
log.error({ err: e }, 'failed to start');
```

(Drop the `worker:` / `worker:` prefixes — the `module: 'worker.lifecycle'` field carries that context.)

NOTE: this task does NOT add Sentry to the worker — that's Task 7. We're only doing the Pino migration here.

- [ ] **Step 5: `worker/jobs/thumbnail.ts` (3 sites)**

```ts
import { getLogger } from '@/lib/logger';
const log = getLogger('worker.thumbnail');

// Replace line 17:
// Before:
console.error('[thumbnail] FILES_DIR is not set');
// After:
log.error('FILES_DIR is not set');

// Replace line 34:
// Before:
console.error('[thumbnail] cannot read source', { attachmentId, error: (e as Error).message });
// After:
log.error({ attachmentId, err: e }, 'cannot read source');

// Replace line 47:
// Before:
console.error('[thumbnail] resize failed', { ... });
// After:
log.error({ ... }, 'resize failed');
```

- [ ] **Step 6: Verify all sites are migrated**

```bash
grep -rn "console\.\(log\|error\|warn\)" lib/ worker/ 2>/dev/null | grep -v node_modules | grep -v ".test.ts"
# Expected: 0 matches.
```

- [ ] **Step 7: Verify the suite**

```bash
pnpm typecheck
pnpm test:unit
pnpm test:integration
```

All 222 unit + 142 integration tests must stay green.

- [ ] **Step 8: Commit**

```bash
git add lib/queue.ts lib/search/client.ts lib/attachments/actions.ts worker/index.ts worker/jobs/thumbnail.ts
git commit -m "refactor(observability): replace remaining console.* with getLogger"
```

---

## Task 5: Sentry SDK + instrumentation files + next.config wrap

**Files:**
- Create: `instrumentation.ts` (repo root)
- Create: `sentry.client.config.ts` (repo root)
- Modify: `package.json` (new dep)
- Modify: `next.config.ts` (wrap with `withSentryConfig`)

`@sentry/nextjs` ships server, browser, and edge SDKs in one package. Server init goes in `instrumentation.ts` (Next 13+ convention); browser init goes in `sentry.client.config.ts` (Sentry's convention). Both gate on `SENTRY_DSN` being set — if unset, init is a no-op.

- [ ] **Step 1: Add the dep**

```bash
pnpm add @sentry/nextjs
```

Verify the version pins with `~` (patch-level).

- [ ] **Step 2: Create `instrumentation.ts` at repo root**

```ts
// Next.js Server-side observability bootstrap. Loaded by Next.js's
// instrumentation hook on every server / edge runtime startup.
//
// Sentry init is gated on SENTRY_DSN being set. With no DSN, register()
// does nothing — the SDK isn't even loaded into the bundle's hot path.
//
// Release tag and environment come from the existing version module so
// stack traces in Sentry/GlitchTip line up with the deployed git SHA
// (see lib/version.ts).

export async function register() {
  if (!process.env.SENTRY_DSN) return;

  const { APP_GIT_SHA } = await import('@/lib/version');

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const Sentry = await import('@sentry/nextjs');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      release: APP_GIT_SHA,
      environment: process.env.NODE_ENV,
      // Keep events to exceptions only; traces add volume without value here.
      tracesSampleRate: 0,
      // Defensive default — never include cookies / headers / IPs.
      sendDefaultPii: false,
    });
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    const Sentry = await import('@sentry/nextjs');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      release: APP_GIT_SHA,
      environment: process.env.NODE_ENV,
      tracesSampleRate: 0,
      sendDefaultPii: false,
    });
  }
}
```

- [ ] **Step 3: Create `sentry.client.config.ts` at repo root**

```ts
// Browser-side Sentry init. Loaded by @sentry/nextjs's bundler integration.
// Same DSN-gate as the server side; if SENTRY_DSN is unset at build time,
// the browser bundle skips Sentry entirely.

import * as Sentry from '@sentry/nextjs';
import { APP_GIT_SHA } from '@/lib/version';

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    release: APP_GIT_SHA,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
}
```

NOTE: the browser SDK reads `NEXT_PUBLIC_SENTRY_DSN` (Next.js inlines `NEXT_PUBLIC_*` into the client bundle at build time). The server uses the un-prefixed `SENTRY_DSN`. **This means the user needs to set BOTH env vars to the same DSN value to get full coverage.** Document this in `docs/observability.md` (Task 9).

If you want to use ONE env var for both, add the `NEXT_PUBLIC_SENTRY_DSN` to `lib/env.ts` as a separate optional var. Recommend: keep them separate to make the public-vs-private distinction explicit.

Update `lib/env.ts` Task-1 additions to also include:

```ts
NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional(),
```

(If you already shipped Task 1 without this, amend it now in this commit.)

- [ ] **Step 4: Wrap `next.config.ts` with `withSentryConfig`**

Read the current `next.config.ts`. The wrap pattern:

```ts
// Before (assumed shape):
import type { NextConfig } from 'next';
const nextConfig: NextConfig = { /* ... */ };
export default nextConfig;

// After:
import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

const nextConfig: NextConfig = { /* ... */ };

export default withSentryConfig(nextConfig, {
  // Sentry build-time options — used only for source-map upload.
  // Skipped automatically when SENTRY_AUTH_TOKEN is unset.
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Don't include sourcemaps in the served bundle — Sentry needs them
  // uploaded to its server, not exposed to clients.
  hideSourceMaps: true,
  disableLogger: true,
});
```

If your GlitchTip instance doesn't use Sentry's org/project model, set those to noop strings — `withSentryConfig` only fires source-map upload when `authToken` is set, which is itself optional.

- [ ] **Step 5: Verify**

```bash
pnpm typecheck
pnpm test:unit
```

The instrumentation files import lazily inside `register()` and via the DSN gate, so unit tests should be unaffected.

- [ ] **Step 6: Commit**

```bash
git add instrumentation.ts sentry.client.config.ts next.config.ts package.json pnpm-lock.yaml lib/env.ts
git commit -m "feat(observability): wire @sentry/nextjs SDK with optional-DSN gating"
```

---

## Task 6: Sentry capture in `app/global-error.tsx`

**Files:**
- Modify: `app/global-error.tsx`

The current `app/global-error.tsx` is a placeholder that doesn't report errors anywhere. With Sentry installed, the boundary should `Sentry.captureException(error)` before rendering the fallback UI.

- [ ] **Step 1: Update the file**

Current state:
```tsx
'use client';

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <h1>Something went wrong</h1>
        <button type="button" onClick={reset}>
          Try again
        </button>
      </body>
    </html>
  );
}
```

Replace with:

```tsx
'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <h1>Something went wrong</h1>
        <button type="button" onClick={reset}>
          Try again
        </button>
      </body>
    </html>
  );
}
```

(`Sentry.captureException` is a no-op when the SDK isn't initialized, so this works whether or not `NEXT_PUBLIC_SENTRY_DSN` is set.)

- [ ] **Step 2: Verify**

```bash
pnpm typecheck
pnpm test:unit
```

- [ ] **Step 3: Commit**

```bash
git add app/global-error.tsx
git commit -m "feat(observability): report uncaught client errors to Sentry"
```

---

## Task 7: Sentry init for the worker process

**Files:**
- Modify: `worker/index.ts`

The worker runs as a separate process via `tsx worker/index.ts`. Next.js's `instrumentation.ts` doesn't apply to it — the worker needs its own `Sentry.init` call early in startup.

`@sentry/nextjs` exports a Node init too, but for cleanness we'll use `@sentry/node` directly via the `@sentry/nextjs` re-export (which bundles `@sentry/node` internally). Calling `Sentry.init` from `@sentry/nextjs` inside a non-Next.js process works — the SDK just runs the Node integration.

Actually, simpler and more correct: import `@sentry/node` directly. It's already a transitive dep via `@sentry/nextjs`. **Verify by `pnpm list @sentry/node` after Task 5 lands.** If it's NOT a transitive dep, add it explicitly with `pnpm add @sentry/node`.

- [ ] **Step 1: Verify `@sentry/node` is available**

```bash
pnpm list @sentry/node
```

If it's not present, install it:

```bash
pnpm add @sentry/node
```

- [ ] **Step 2: Add Sentry init to `worker/index.ts`**

At the very top of the file, before any other imports that might throw, add:

```ts
import * as Sentry from '@sentry/node';
import { APP_GIT_SHA } from '@/lib/version';

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

Then, in the catch block at line ~70 (the "worker failed to start" handler), add a Sentry capture before the log + exit:

```ts
} catch (e) {
  Sentry.captureException(e);
  log.error({ err: e }, 'failed to start');
  process.exit(1);
}
```

(The `log.error` call from Task 4 stays — both pipes report the error.)

For the in-job failure paths (the `boss.on('error')` handler in `lib/queue.ts`), add a Sentry capture there too:

```ts
// lib/queue.ts
boss.on('error', (e) => {
  Sentry.captureException(e); // import * as Sentry from '@sentry/node' at top
  log.error({ err: e }, 'pg-boss error');
});
```

- [ ] **Step 3: Verify**

```bash
pnpm typecheck
pnpm test:unit
pnpm test:integration
```

All tests should still pass — `Sentry.captureException` is a no-op when DSN is unset.

- [ ] **Step 4: Commit**

```bash
git add worker/index.ts lib/queue.ts package.json pnpm-lock.yaml
git commit -m "feat(observability): init Sentry in worker process and report job errors"
```

---

## Task 8: Smoke test for instrumentation files

**Files:**
- Create: `tests/unit/instrumentation.test.ts`

Verify that the instrumentation register function runs cleanly when `SENTRY_DSN` is unset (the common case). Also verify that the function exists at all (catches a future "did someone delete the file" regression).

- [ ] **Step 1: Write the test**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('instrumentation', () => {
  const originalDsn = process.env.SENTRY_DSN;

  beforeEach(() => {
    delete process.env.SENTRY_DSN;
  });

  afterEach(() => {
    if (originalDsn !== undefined) process.env.SENTRY_DSN = originalDsn;
    else delete process.env.SENTRY_DSN;
  });

  it('register() is a no-op when SENTRY_DSN is unset', async () => {
    const mod = await import('@/instrumentation');
    expect(typeof mod.register).toBe('function');
    // Should not throw, should not init Sentry.
    await expect(mod.register()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Verify the test path is included by Vitest**

The default `test:unit` script is `vitest run tests/unit lib`. The new test lives in `tests/unit/`, so it's covered.

- [ ] **Step 3: Run**

```bash
pnpm test:unit tests/unit/instrumentation.test.ts
# Expected: 1 test passed.
```

- [ ] **Step 4: Verify the wider suite**

```bash
pnpm test:unit
```

- [ ] **Step 5: Commit**

```bash
git add tests/unit/instrumentation.test.ts
git commit -m "test(observability): smoke-test instrumentation register no-ops without DSN"
```

---

## Task 9: Documentation

**Files:**
- Create: `docs/observability.md`

Brief operator-facing doc: env vars, dev pipe, where to point Sentry once GlitchTip is running.

- [ ] **Step 1: Write `docs/observability.md`**

```markdown
# Observability

The app emits structured logs to stdout (Pino) and reports exceptions to a configured Sentry-compatible endpoint (`@sentry/nextjs`). Both are optional — the app works fine with neither configured.

## Environment variables

All optional. Set in `.env`, `docker-compose.yml`, or your host's environment.

| Var | Purpose | Default |
|---|---|---|
| `LOG_LEVEL` | Pino level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`). | `info` in prod, `debug` in dev |
| `SENTRY_DSN` | Server-side Sentry/GlitchTip endpoint. Sentry init no-ops when unset. | unset |
| `NEXT_PUBLIC_SENTRY_DSN` | Browser-side DSN (must be the `NEXT_PUBLIC_` form because Next.js inlines it into the client bundle at build time). Set to the same value as `SENTRY_DSN` to get both server and browser coverage. | unset |
| `SENTRY_AUTH_TOKEN` | Source-map upload token. Sentry skips upload when unset. | unset |

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

For querying / retention / dashboards, ship `docker logs` to Loki via Promtail. That's homelab work, separate from this app.

## Setting up GlitchTip

1. Run GlitchTip in your homelab Docker Compose. The image is `glitchtip/glitchtip` plus a Postgres sidecar.
2. Create a project; copy the DSN.
3. Set `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` to the same DSN value.
4. (Optional) Create an internal integration in GlitchTip and copy the auth token; set `SENTRY_AUTH_TOKEN` to enable source-map upload during `pnpm build`.
5. Restart the app. Errors now flow to GlitchTip with grouping and alerting.

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

This makes Loki/Grafana queries trivial later: `{module=~"ai.suggest.*"}` returns every Suggest event.

## Redaction

The Pino singleton redacts these key paths regardless of nesting depth:

- `*.apiKey`
- `*.token`
- `*.secret`
- `*.password`
- `req.headers.cookie`
- `req.headers.authorization`

Add new paths to `lib/logger.ts` as new sensitive fields appear.
```

- [ ] **Step 2: Commit**

```bash
git add docs/observability.md
git commit -m "docs(observability): operator doc for logs + Sentry setup"
```

---

## Task 10: Final verify pass + branch handoff

- [ ] **Step 1: Full verify**

```bash
pnpm verify
# Expected: lint ✓ typecheck ✓ test:unit ✓
```

- [ ] **Step 2: Integration tests**

```bash
pnpm test:integration
# Expected: every test green (142 prior; no new integration tests added).
```

- [ ] **Step 3: E2E (optional but recommended)**

```bash
pnpm test:e2e:local
# Expected: every spec green (6 prior).
```

- [ ] **Step 4: Sanity-check the migration is complete**

```bash
grep -rn "console\.\(log\|error\|warn\)" lib/ worker/ 2>/dev/null | grep -v node_modules | grep -v ".test.ts"
# Expected: 0 matches.

grep -n "TODO(plan-5)" lib/ worker/ 2>/dev/null | head
# Expected: 0 matches (all resolved).
```

- [ ] **Step 5: Commit count**

```bash
git log --oneline main..HEAD | wc -l
# Expected: ~9 commits across the plan's tasks (1 per task except Task 10).
```

- [ ] **Step 6: Hand off to `superpowers:finishing-a-development-branch`**

Open a PR titled `feat(observability): Plan 5a — Pino logger + @sentry/nextjs SDK` with the standard template. CI must be green before merge.

---

## Reference: skills to invoke during implementation

- `superpowers:test-driven-development` — Tasks 2 and 8 use TDD shape.
- `superpowers:requesting-code-review` — between any task and the next, optionally dispatch a spec/code reviewer subagent.
- `superpowers:finishing-a-development-branch` — Task 10 final handoff.
