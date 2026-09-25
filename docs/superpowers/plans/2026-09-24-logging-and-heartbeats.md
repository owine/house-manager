# Logging and Heartbeats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the logs and the scheduled jobs trustworthy without any Sentry work. Logged errors keep their message and stack (every `err` has been `{}` in production since #169), no secret reaches a log line through the `msg` pino derives from an Error, the two public token routes are masked, `reminders.tick` and `search.reindex` get dead-man pings like the nightly backup, and `pnpm test:unit` finally runs the worker-root tests (and stops running two integration files).

**Architecture:** #508's `pingHeartbeat` moves from `worker/jobs/pg-dump.ts` into `lib/heartbeat-ping.ts`, gaining a `withHeartbeat(name, url, run)` wrapper that pings only after `run` resolves. `worker/monitored-jobs.ts` wraps the two cron entry points; `worker/index.ts`'s `boss.work` callbacks call those, while the startup missed-tick recovery keeps calling the raw handler. `lib/log-scrub.ts`'s `deepScrubStrings` learns to serialize Errors (pino runs `formatters.log` before serializers, which is what flattened them), gains one pattern for `/api/calendar/<token>` and `/api/inbound-email/<token>`, and `lib/logger.ts`'s `logMethod` hook supplies a scrubbed message whenever pino would derive one from `err.message`.

**Tech Stack:** TypeScript 7, Pino 10.3.1, pg-boss 12 worker under tsx, Zod, Vitest 5.0.1 (+ Testcontainers for the integration checks), uptime-kuma Push monitors.

**Source findings:** `.full-review/04b-cicd-devops.md` (O-H1, non-backup slice), `.full-review/05-final-report.md` (P1 observability cluster, the part that needs no Sentry), plus three findings made while planning (below). The Sentry half of that P1 item is the follow-up plan `2026-09-24-production-observability.md`, which is built on this one.

---

## Background the implementer needs

**Verified against the code (2026-09-24, `main` @ `7b23b6b`, which is #508 merged):**

- **O-H1 (non-backup slice) is correct.** Nothing watches `reminders.tick` (every 5 min) or `search.reindex` (daily 03:00 UTC). #508 added `pingHeartbeat` inside `worker/jobs/pg-dump.ts` and `BACKUP_HEARTBEAT_URL`; this plan lifts it into `lib/` rather than copying it.
- **Every logged `err` has been `{}` since #169 (2026-05-22).** Pino runs `formatters.log` *before* serializers (`node_modules/.pnpm/pino@10.3.1/node_modules/pino/lib/tools.js`, `_asJson`). `formatters.log` calls `deepScrubStrings`, which walks `Object.entries`, and an Error's `message` and `stack` are non-enumerable. The `err` serializer then receives `{}` plus any custom fields. Reproduce on `main`: `node_modules/.bin/tsx -e "import('./lib/logger.ts').then((m) => m.getLogger('x').error({ err: new Error('visible?') }, 'probe'))"` prints `"err":{}`. `lib/logger.test.ts` never asserted a message or a stack.
- **One secret-bearing string skips every scrub.** When a call passes no message (`logger.error({ err })`, `logger.error(err)`), pino fills `msg` from `err.message` inside `write()` (`pino/lib/proto.js`), after `hooks.logMethod` and outside `formatters.log`. A connection string in an error message reaches stdout verbatim in `msg`.
- **`pnpm test:unit` runs the wrong files.** Its path filters are substring matches. `worker/jobs` excludes `worker/heartbeat.test.ts` and `worker/health-server.test.ts` (21 tests that run in no CI job), and `app` also matches `tests/integration/chat/apply.test.ts` and `apply-part.test.ts`. Those two still run in `test:integration`, so changing `app` to `app/` only removes the duplicate. Both lists are checked in Task 1.

**How the code below was checked.** Every block was applied to a scratch copy of `main` @ `7b23b6b` with its **own** `pnpm install --frozen-lockfile` and `pnpm db:generate` (not a symlink to the real `node_modules`):

- `tsc --noEmit` clean; `biome check .` clean (662 files); `lint:worker-graph`, `lint:tokens` OK; knip clean apart from one scratch-only artifact (`lefthook` "unused", because the copy has no `.git`).
- `vitest run tests/unit lib worker/ components app/`: 122 files, 1457 tests pass.
- Integration: `reminders-tick`, `search-reindex`, `missed-tick-recovery`, `pg-dump-restore`, `chat/apply`, `chat/apply-part`: 6 files, 45 tests pass.
- `tsx` runtime import of `worker/monitored-jobs` with no env set: resolves (the image's own resolution path).
- **Mutation checks**:

  | Mutation | Result |
  |---|---|
  | log `err.message` in the heartbeat warn | 3 fail (`lib/heartbeat-ping.test.ts`, `worker/jobs/pg-dump.test.ts`) |
  | ping in a `finally` | 3 fail (`lib/heartbeat-ping.test.ts`, `worker/monitored-jobs.test.ts`) |
  | drop the Error branch in `deepScrubStrings` | 4 fail (`lib/logger.test.ts`) |
  | `errorFields(value)` returned without `scrubObject` (cause, other keys and AggregateError members unscrubbed) | 1 fail |
  | drop the `aggregateErrors` line | 1 fail |
  | drop the derived-message push in `logMethod` | 2 fail |
  | derive only from `err instanceof Error` (pino derives from any truthy `err`) | 1 fail |
  | drop the string guard on the derived message (the log call throws on a numeric `message`) | 1 fail |
  | token-route scrub pattern removed | 1 fail (`lib/log-scrub.test.ts`) |

**Design decisions (double-check these):**

1. **One env var per job, not a generic scheme.** `REMINDERS_TICK_HEARTBEAT_URL` and `SEARCH_REINDEX_HEARTBEAT_URL` follow #508's `BACKUP_HEARTBEAT_URL`. Each is Zod-validated (`optionalEnv(httpUrlSchema)`) and listed in `docs/README.md`; a prefix scheme (`HEARTBEAT_URL_<QUEUE>`) would escape both.
2. **Only the cron path pings.** `worker/monitored-jobs.ts` wraps what `boss.work` calls. The startup missed-tick recovery calls `handleRemindersTick` directly and does not ping, so a pg-boss cron that has stopped firing cannot be masked by worker restarts.
3. **`pg-dump` keeps calling `pingHeartbeat` itself** (it pings after pruning and returns the outcome in its result). Its tests are **not modified** and must still pass: they mock `@/lib/logger` for every module, so their "never logs the URL" assertions now exercise the lifted code. The warn line's `event` is unchanged (`pg-dump.heartbeat.failed`); its logger `module` becomes `heartbeat`.
4. **The lifted ping cancels the response body.** An unread body pins the socket until GC, and `reminders.tick` pings every 5 minutes.
5. **Error serialization keeps pino's shape** (`type`, `message`, `stack`, then custom fields) plus a nested `cause` and `aggregateErrors`, and the `err` serializer becomes `deepScrubStrings` itself. `pino.stdSerializers.err` would relabel an already-plain object's `type` as `'Object'`.
6. **The derived message follows pino's own rule** (`proto.js` `write()`: any truthy `err`, not only an Error; an explicit `msg` in the merge object wins; only a single-argument call is affected). It only ever returns a string: a non-string `message` is left to pino, because `scrubSecrets` on a number throws, and a log call must never throw.
6a. **The `search.reindex` heartbeat means "rebuild submitted", not "index populated".** `handleSearchReindex` returns once Meilisearch has accepted its tasks, without awaiting them. This PR does not change the job; the env comment, `worker/monitored-jobs.ts`, `docs/README.md` and `docs/observability.md` say what the ping proves.
7. **The token-route pattern lives in `lib/log-scrub.ts`**, the single scrubbing source (CLAUDE.md: don't re-roll per-site redaction). The follow-up Sentry plan's `beforeSend` reuses it.

**Repo rules that apply to every task:**

- `pnpm`, never `npx`/`npm`. Run one file with `pnpm exec vitest run <path>` (`pnpm test:unit`/`test:integration` *widen* when given a path).
- Never `--no-verify`. After **every** `git commit`, run `git log --oneline -1` and confirm HEAD moved: the Biome pre-commit hook can fail silently.
- Stage explicit paths only (`git add <paths>`), never `-A` or `.`.
- Run `pnpm lint:fix` before committing any file whose imports changed. The code below is already in Biome's order.
- **Vitest 5.0.1 defaults `clearMocks: true`**: call counts reset between tests, so call and assert in the same `it`.
- **Integration tests must `vi.mock('@/lib/env')` with only the fields read.** None change here; the handlers they call are untouched.
- **Worker imports must stay inside `lib/`, `worker/` or `prisma/`** and be production dependencies (`pnpm lint:worker-graph`). This plan adds no dependency.
- **A new env var goes in** `lib/env.ts`, `.env.example`, the `docs/README.md` env table, and `docker-compose.yml`'s `x-app-env`.
- Don't use git worktrees in this repo (knip hangs on pre-push, and there is no `.env`). Work in the main checkout.
- `.full-review/` is excluded via `.git/info/exclude`. Nothing there gets committed except the plan copy in Task 9.
- No literal credentialed URL (a user *and* password before the `@`) in new code. Build fixtures from parts, as the tests below do; Task 9 Step 2 checks the plan itself.

## File structure

| File | Responsibility |
|---|---|
| `package.json` *(modify)* | `test:unit` filters `worker/jobs` → `worker/` and `app` → `app/`. |
| `lib/heartbeat-ping.ts` *(create)* | `pingHeartbeat(name, url, opts)` lifted from `pg-dump.ts` (fail-soft, never logs the URL), plus `withHeartbeat` (ping only after the job resolves). |
| `lib/heartbeat-ping.test.ts` *(create)* | Skip/sent/non-2xx/timeout/no-secrets-logged; `withHeartbeat` never pings on throw. |
| `worker/jobs/pg-dump.ts` *(modify)* | Uses the lifted function. `worker/jobs/pg-dump.test.ts` is **unchanged** and must still pass. |
| `lib/env.ts`, `tests/unit/env.test.ts` *(modify)* | `REMINDERS_TICK_HEARTBEAT_URL`, `SEARCH_REINDEX_HEARTBEAT_URL`. |
| `worker/monitored-jobs.ts` *(create)* | `runRemindersTick` / `runSearchReindex`: the cron entry points, each wrapped in `withHeartbeat`. |
| `worker/monitored-jobs.test.ts` *(create)* | Pings once after success, never after a throw, never when unset, survives a monitor outage. |
| `worker/index.ts` *(modify)* | The two `boss.work` callbacks call the monitored entry points. |
| `lib/log-scrub.ts`, `lib/log-scrub.test.ts` *(modify)* | Serialize Errors instead of flattening them to `{}`; mask the token in the two token routes. |
| `lib/logger.ts`, `lib/logger.test.ts` *(modify)* | `err` serializer; scrubbed message when pino would derive one from `err.message`. |
| `docs/observability.md`, `docs/README.md`, `docs/TESTING.md`, `CLAUDE.md`, `.env.example`, `docker-compose.yml` *(modify)* | Dead-man monitors section, the two env vars, the test scope, what a logged error now contains. |

---

### Task 0: Branch

- [ ] **Step 1: Start from a current `main` that contains #508**

```bash
git checkout main
git pull --ff-only
git log --oneline --grep='(#508)' -1          # expect: 7b23b6b fix(backup): atomic validated dumps, ... (#508)
grep -n "async function pingHeartbeat" worker/jobs/pg-dump.ts   # expect: one hit, the function Task 2 lifts
git status --short                            # expect: empty
git checkout -b fix/logging-and-heartbeats
docker info >/dev/null && echo docker-ok      # Task 7's integration run needs the daemon
```

If `main` is past `7b23b6b`, re-read `worker/jobs/pg-dump.ts` and `worker/index.ts` before editing, and match the "replace this" blocks below by content, not line number.

---

### Task 1: Make `pnpm test:unit` run exactly the unit tests

**Files:**
- Modify: `package.json` (`test:unit` script), `CLAUDE.md:25`, `docs/TESTING.md:20`

- [ ] **Step 1: See both gaps**

```bash
pnpm exec vitest list tests/unit lib worker/jobs components app --filesOnly | grep -c '\.test\.'   # expect: 120
pnpm exec vitest list tests/unit lib worker/jobs components app --filesOnly | grep integration
#   expect: tests/integration/chat/apply-part.test.ts and tests/integration/chat/apply.test.ts
#   (the `app` filter substring-matches "apply")
pnpm exec vitest list tests/unit lib worker/ components app/ --filesOnly | grep -c '\.test\.'    # expect: 120
pnpm exec vitest list tests/unit lib worker/ components app/ --filesOnly | grep -c integration   # expect: 0
pnpm exec vitest list tests/unit lib worker/ components app/ --filesOnly | grep -E '^worker/[a-z-]+\.test\.ts$'
#   expect: worker/health-server.test.ts and worker/heartbeat.test.ts
```

Same count, different set: the two integration files leave (they still run in `pnpm test:integration`) and the two worker-root files arrive. `worker/` does not match `tests/integration/thumbnail-worker.test.ts`.

- [ ] **Step 2: Fix the filters**

In `package.json`, replace:

```json
    "test:unit": "vitest run tests/unit lib worker/jobs components app",
```

with:

```json
    "test:unit": "vitest run tests/unit lib worker/ components app/",
```

- [ ] **Step 3: Run it**

Run: `pnpm test:unit`
Expected: 120 test files pass, `worker/heartbeat.test.ts` and `worker/health-server.test.ts` among them, no `tests/integration/` file.

- [ ] **Step 4: Fix the two docs that describe the scope**

`CLAUDE.md:25`, replace:

```
pnpm test:unit            # tests/unit + lib + worker/jobs + components (mocked)
```

with:

```
pnpm test:unit            # tests/unit + lib + worker + components + app (mocked)
```

`docs/TESTING.md:20`, replace ``Unit tests: `tests/unit`, `lib`, `worker/jobs`, `components`.`` with ``Unit tests: `tests/unit`, `lib`, `worker` (including `worker/jobs`), `components`, `app`.``

- [ ] **Step 5: Commit**

```bash
git add package.json CLAUDE.md docs/TESTING.md
git commit -m "test: test:unit runs worker/*.test.ts and stops matching tests/integration/chat/apply*"
git log --oneline -1   # confirm HEAD moved
```

---

### Task 2: Lift `pingHeartbeat` into `lib/heartbeat-ping.ts`

**Files:**
- Create: `lib/heartbeat-ping.ts`
- Test: `lib/heartbeat-ping.test.ts` (create)
- Modify: `worker/jobs/pg-dump.ts` (its test file stays untouched)

- [ ] **Step 1: Write the failing test**

Create `lib/heartbeat-ping.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { pingHeartbeat, withHeartbeat } from './heartbeat-ping';

// Captured so tests can assert what is (and is never) logged.
const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/logger', () => ({ getLogger: () => log }));

const PUSH_URL = 'https://kuma.example/api/push/abc123?status=up&msg=OK&ping=';
const okFetch = () => vi.fn(async () => new Response('{"ok":true}', { status: 200 }));

describe('pingHeartbeat', () => {
  it('is skipped when the URL is unset or empty', async () => {
    const fetch = okFetch();
    expect(await pingHeartbeat('job', undefined, { fetch })).toBe('skipped');
    expect(await pingHeartbeat('job', '', { fetch })).toBe('skipped');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('GETs the URL verbatim with a timeout signal', async () => {
    const fetch = okFetch();
    expect(await pingHeartbeat('job', PUSH_URL, { fetch })).toBe('sent');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(PUSH_URL, { signal: expect.any(AbortSignal) });
  });

  it('reports a non-2xx as failed, logging only the status under the job name', async () => {
    const fetch = vi.fn(async () => new Response('{"ok":false}', { status: 404 }));
    expect(await pingHeartbeat('reminders-tick', PUSH_URL, { fetch })).toBe('failed');
    expect(log.warn).toHaveBeenCalledWith(
      { event: 'reminders-tick.heartbeat.failed', status: 404 },
      expect.any(String),
    );
  });

  it('is fail-soft when the monitor never answers (timeout)', async () => {
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (signal) signal.addEventListener('abort', () => reject(signal.reason));
      });
    });
    expect(await pingHeartbeat('job', PUSH_URL, { fetch, timeoutMs: 20 })).toBe('failed');
    expect(log.warn).toHaveBeenCalledWith(
      { event: 'job.heartbeat.failed', errName: 'TimeoutError', causeCode: undefined },
      expect.any(String),
    );
  });

  // undici puts the request URL in some error messages, and this URL carries
  // the push token (and could carry user:pass@). Only the error's name and
  // its cause's code may reach the log. Mutation-checked: logging
  // `err.message` (or the url) fails this test.
  it('never logs the URL or its secrets when the ping throws', async () => {
    // Built from parts (not one literal) so it is still a genuine embedded-
    // credential URL at runtime without pattern-matching as a real secret.
    const user = 'kuma-user';
    const pass = 's3cretPass';
    const secretUrl = `https://${user}:${pass}@kuma.example/api/push/tok3nSecret?status=up`;
    const fetch = vi.fn(async () => {
      throw Object.assign(new TypeError(`fetch failed: ${secretUrl}`), {
        cause: Object.assign(new Error(`connect ECONNREFUSED ${secretUrl}`), {
          code: 'ECONNREFUSED',
        }),
      });
    });

    expect(await pingHeartbeat('search-reindex', secretUrl, { fetch })).toBe('failed');

    expect(log.warn).toHaveBeenCalledWith(
      { event: 'search-reindex.heartbeat.failed', errName: 'TypeError', causeCode: 'ECONNREFUSED' },
      expect.any(String),
    );
    const everything = JSON.stringify([
      log.debug.mock.calls,
      log.info.mock.calls,
      log.warn.mock.calls,
      log.error.mock.calls,
    ]);
    for (const secret of ['s3cretPass', 'tok3nSecret', 'kuma-user', 'kuma.example']) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe('withHeartbeat', () => {
  it('pings after the job resolves and returns its result', async () => {
    const fetch = okFetch();
    const run = vi.fn(async () => ({ enqueued: 3 }));
    await expect(withHeartbeat('job', PUSH_URL, run, { fetch })).resolves.toEqual({ enqueued: 3 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // Mutation-checked: moving the ping into a `finally` fails this test.
  it('does not ping when the job throws, and rethrows the same error', async () => {
    const fetch = okFetch();
    const boom = new Error('meili down');
    await expect(
      withHeartbeat(
        'job',
        PUSH_URL,
        async () => {
          throw boom;
        },
        { fetch },
      ),
    ).rejects.toBe(boom);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not fail the job when the ping fails', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(withHeartbeat('job', PUSH_URL, async () => 'done', { fetch })).resolves.toBe(
      'done',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run lib/heartbeat-ping.test.ts`
Expected: FAIL, `Failed to resolve import "./heartbeat-ping"`.

- [ ] **Step 3: Create the module**

Create `lib/heartbeat-ping.ts`:

```ts
import { getLogger } from '@/lib/logger';

// Dead-man pings for scheduled jobs: after a successful run, GET a push URL
// (an uptime-kuma Push monitor, healthchecks.io, ...). The monitor alerts when
// the pings STOP, so a job that fails, hangs, or is never scheduled goes red
// by silence rather than by anything this process has to remember to send.
//
// Not to be confused with worker/heartbeat.ts, which is the worker's liveness
// beat for its own /api/health endpoint.

const logger = getLogger('heartbeat');

export const HEARTBEAT_TIMEOUT_MS = 10_000;

export type HeartbeatResult = 'sent' | 'skipped' | 'failed';

export type HeartbeatOptions = {
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Abort the GET after this long. Defaults to HEARTBEAT_TIMEOUT_MS. */
  timeoutMs?: number;
};

/**
 * GET `url` once. Fail-soft: a monitor outage must never fail the job, and a
 * missed ping is exactly what the monitor alerts on.
 *
 * `name` prefixes the log event (`<name>.heartbeat.failed`), so each job's
 * failures stay distinguishable in the logs.
 *
 * Never logs the URL, and never logs an error's `message`: undici puts the full
 * request URL in some of its errors, and this URL carries the push token (and
 * could carry `user:pass@` — httpUrlSchema allows credentials). Only the error's
 * name and its cause's `code` (e.g. ECONNREFUSED, ENOTFOUND) are logged.
 */
export async function pingHeartbeat(
  name: string,
  url: string | undefined,
  opts: HeartbeatOptions = {},
): Promise<HeartbeatResult> {
  if (!url) return 'skipped';
  const doFetch = opts.fetch ?? globalThis.fetch;
  try {
    const res = await doFetch(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? HEARTBEAT_TIMEOUT_MS),
    });
    // Release the connection. An unread body pins the socket until GC, and
    // reminders.tick pings every five minutes.
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) {
      logger.warn(
        { event: `${name}.heartbeat.failed`, status: res.status },
        'heartbeat rejected (non-fatal)',
      );
      return 'failed';
    }
    return 'sent';
  } catch (e) {
    const err = e as Error;
    logger.warn(
      {
        event: `${name}.heartbeat.failed`,
        errName: err.name,
        causeCode: (err.cause as { code?: string } | undefined)?.code,
      },
      'heartbeat failed (non-fatal)',
    );
    return 'failed';
  }
}

/**
 * Run a scheduled job, then ping. The ping happens only when `run` resolves:
 * if it throws, the error propagates (so pg-boss records the failure and
 * retries) and no ping is sent. The ping itself never throws.
 */
export async function withHeartbeat<T>(
  name: string,
  url: string | undefined,
  run: () => Promise<T>,
  opts: HeartbeatOptions = {},
): Promise<T> {
  const result = await run();
  await pingHeartbeat(name, url, opts);
  return result;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run lib/heartbeat-ping.test.ts`
Expected: 8 passed.

- [ ] **Step 5: Point `pg-dump` at it**

In `worker/jobs/pg-dump.ts`:

1. Add the import after `import { getEnv } from '@/lib/env';`:

   ```ts
   import { HEARTBEAT_TIMEOUT_MS, type HeartbeatResult, pingHeartbeat } from '@/lib/heartbeat-ping';
   ```

2. Delete the line `const HEARTBEAT_TIMEOUT_MS = 10_000;` (just below `STALE_PARTIAL_MS`).
3. In `PgDumpResult`, replace `heartbeat: 'sent' | 'skipped' | 'failed';` with `heartbeat: HeartbeatResult;`.
4. Delete the whole local `pingHeartbeat` function and the JSDoc above it (from `/**` "Dead-man ping. Fail-soft: …" through its closing `}`), which sits just above the `handlePgDump` JSDoc.
5. In `handlePgDump`, replace:

   ```ts
     const heartbeat = await pingHeartbeat(BACKUP_HEARTBEAT_URL, deps);
   ```

   with:

   ```ts
     const heartbeat = await pingHeartbeat('pg-dump', BACKUP_HEARTBEAT_URL, {
       fetch: deps.fetch,
       timeoutMs: deps.heartbeatTimeoutMs,
     });
   ```

- [ ] **Step 6: Prove `pg-dump`'s behaviour is unchanged**

```bash
pnpm exec vitest run worker/jobs/pg-dump.test.ts lib/heartbeat-ping.test.ts
git diff --stat worker/jobs/pg-dump.test.ts   # expect: no output (test file untouched)
pnpm typecheck
```

Expected: 25 + 8 passed. The pg-dump test mocks `@/lib/logger` as `getLogger: () => log` for every module, so its "never logs the URL" and `{ event: 'pg-dump.heartbeat.failed', errName, causeCode }` assertions now exercise the lifted code.

- [ ] **Step 7: Mutation check (do, observe, undo)**

In `lib/heartbeat-ping.ts`, change `errName: err.name,` to `errName: err.name, msg: err.message,` and rerun Step 6's vitest command: 3 tests must fail. Then change `withHeartbeat`'s body to `try { return await run(); } finally { await pingHeartbeat(name, url, opts); }` and rerun `lib/heartbeat-ping.test.ts`: the "does not ping when the job throws" test must fail. Revert both edits and re-run Step 6: all green.

- [ ] **Step 8: Commit**

```bash
git add lib/heartbeat-ping.ts lib/heartbeat-ping.test.ts worker/jobs/pg-dump.ts
git commit -m "refactor(heartbeat): lift pg-dump's dead-man ping into lib/heartbeat-ping"
git log --oneline -1
```

---

### Task 3: `REMINDERS_TICK_HEARTBEAT_URL` and `SEARCH_REINDEX_HEARTBEAT_URL`

**Files:**
- Modify: `lib/env.ts`, `tests/unit/env.test.ts`, `.env.example`, `docker-compose.yml`, `docs/README.md`

- [ ] **Step 1: Write the failing test**

In `tests/unit/env.test.ts`, add this `it` as the last test inside the outer `describe` (just before the file's final `});`):

```ts
  // The two job heartbeats share BACKUP_HEARTBEAT_URL's contract exactly.
  it('REMINDERS_TICK / SEARCH_REINDEX heartbeat URLs: optional, empty is unset, http(s) only', () => {
    const baseValid = {
      ANTHROPIC_API_KEY: 'sk-ant-test-fixture',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      AUTH_SECRET: 'a'.repeat(32),
      AUTH_OIDC_ISSUER: 'https://auth.example.com',
      AUTH_OIDC_CLIENT_ID: 'house-manager',
      AUTH_OIDC_CLIENT_SECRET: 'secret',
      MEILI_HOST: 'http://meilisearch:7700',
      MEILI_KEY: 'key',
      FILES_DIR: '/data/files',
      NODE_ENV: 'test',
      WEB_PUSH_VAPID_PUBLIC_KEY: 'test-vapid-public-key-fixture',
      WEB_PUSH_VAPID_PRIVATE_KEY: 'test-vapid-private-key-fixture',
      WEB_PUSH_CONTACT_EMAIL: 'mailto:test@example.com',
      FORWARDEMAIL_API_KEY: 'test-api-key',
      FORWARDEMAIL_FROM_ADDRESS: 'House Manager <reminders@example.com>',
    };
    const url = 'http://uptime-kuma:3001/api/push/Ab12Cd34?status=up&msg=OK&ping=';
    for (const key of ['REMINDERS_TICK_HEARTBEAT_URL', 'SEARCH_REINDEX_HEARTBEAT_URL'] as const) {
      expect(parseEnv(baseValid)[key]).toBeUndefined();
      expect(parseEnv({ ...baseValid, [key]: '' })[key]).toBeUndefined();
      expect(parseEnv({ ...baseValid, [key]: url })[key]).toBe(url);
      expect(() => parseEnv({ ...baseValid, [key]: 'ftp://kuma.example.com/x' })).toThrow();
      expect(() => parseEnv({ ...baseValid, [key]: 'not a url' })).toThrow();
    }
  });
```

(The `DATABASE_URL` fixture line is copied verbatim from the existing tests in this file.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run tests/unit/env.test.ts`
Expected: 1 failed. Also a typecheck error on `parseEnv(...)[key]` until the schema has the keys; `tsc` passes after Step 3.

- [ ] **Step 3: Add the vars to the schema**

In `lib/env.ts`, directly after `BACKUP_HEARTBEAT_URL: optionalEnv(httpUrlSchema),` add:

```ts
  // Same contract for two more scheduled jobs (worker/monitored-jobs.ts): a GET
  // after each run that completes, never after one that throws. For
  // search.reindex "completes" means the rebuild was submitted to Meilisearch
  // without throwing, not that the index is populated (its tasks are not
  // awaited). One var per job, not a generic prefix scheme, so each is
  // validated here and listed in docs/README.md. Carry push tokens: never log
  // them.
  REMINDERS_TICK_HEARTBEAT_URL: optionalEnv(httpUrlSchema),
  SEARCH_REINDEX_HEARTBEAT_URL: optionalEnv(httpUrlSchema),
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run tests/unit/env.test.ts && pnpm typecheck`
Expected: 10 passed; tsc clean.

- [ ] **Step 5: Document and pass the vars**

`.env.example`, after the `# BACKUP_HEARTBEAT_URL=` line:

```
# REMINDERS_TICK_HEARTBEAT_URL=   # worker: GET after each completed 5-min reminders tick (uptime-kuma Push URL); see docs/observability.md § Dead-man monitors
# SEARCH_REINDEX_HEARTBEAT_URL=   # worker: GET after each completed nightly search rebuild; same section
```

`docker-compose.yml`, in `x-app-env`, after `BACKUP_HEARTBEAT_URL: ${BACKUP_HEARTBEAT_URL:-}`:

```yaml
  # Dead-man pings for reminders.tick and search.reindex
  # (docs/observability.md § Dead-man monitors). Worker only; empty = unset.
  REMINDERS_TICK_HEARTBEAT_URL: ${REMINDERS_TICK_HEARTBEAT_URL:-}
  SEARCH_REINDEX_HEARTBEAT_URL: ${SEARCH_REINDEX_HEARTBEAT_URL:-}
```

`docs/README.md`, Optional env table, after the `BACKUP_HEARTBEAT_URL` row:

```
| `REMINDERS_TICK_HEARTBEAT_URL` | unset | Worker. http(s) URL GETed after each `reminders.tick` run (every 5 min) that completes, never after a failure. See [observability.md § Dead-man monitors](observability.md#dead-man-monitors) |
| `SEARCH_REINDEX_HEARTBEAT_URL` | unset | Worker. GETed after each nightly `search.reindex` run that submits the rebuild to Meilisearch without throwing. It does not wait for Meilisearch to finish indexing, so it proves the job ran, not that the index is populated |
```

- [ ] **Step 6: Commit**

```bash
git add lib/env.ts tests/unit/env.test.ts .env.example docker-compose.yml docs/README.md
git commit -m "feat(env): REMINDERS_TICK_HEARTBEAT_URL and SEARCH_REINDEX_HEARTBEAT_URL"
git log --oneline -1
```

---

### Task 4: Ping from the `reminders.tick` and `search.reindex` cron paths

**Files:**
- Create: `worker/monitored-jobs.ts`
- Test: `worker/monitored-jobs.test.ts` (create)
- Modify: `worker/index.ts` (two `boss.work` callbacks and imports)

- [ ] **Step 1: Write the failing test**

Create `worker/monitored-jobs.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { handleRemindersTick } from './jobs/reminders-tick';
import { handleSearchReindex } from './jobs/search-reindex';
import { runRemindersTick, runSearchReindex } from './monitored-jobs';

// Only the two fields monitored-jobs reads.
const env = vi.hoisted(() => ({
  REMINDERS_TICK_HEARTBEAT_URL: 'https://kuma.example/api/push/tick?status=up' as
    | string
    | undefined,
  SEARCH_REINDEX_HEARTBEAT_URL: 'https://kuma.example/api/push/reindex?status=up' as
    | string
    | undefined,
}));
vi.mock('@/lib/env', () => ({ getEnv: () => env }));
vi.mock('@/lib/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
// The handlers need Postgres and Meilisearch; their own behaviour is covered
// by tests/integration/reminders-tick.test.ts and search-reindex.test.ts.
vi.mock('./jobs/reminders-tick', () => ({ handleRemindersTick: vi.fn() }));
vi.mock('./jobs/search-reindex', () => ({ handleSearchReindex: vi.fn() }));

const okFetch = () => vi.fn(async () => new Response('ok', { status: 200 }));
const enqueue = async () => {};

describe('runRemindersTick', () => {
  it('runs the tick with the given deps, then pings its own URL once', async () => {
    vi.mocked(handleRemindersTick).mockResolvedValueOnce({ enqueued: 2 });
    const fetch = okFetch();

    await expect(runRemindersTick({ enqueue }, { fetch })).resolves.toEqual({ enqueued: 2 });

    expect(handleRemindersTick).toHaveBeenCalledWith({ enqueue });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(env.REMINDERS_TICK_HEARTBEAT_URL, {
      signal: expect.any(AbortSignal),
    });
  });

  it('does not ping when the tick throws, and rethrows for pg-boss', async () => {
    const boom = new Error('db down');
    vi.mocked(handleRemindersTick).mockRejectedValueOnce(boom);
    const fetch = okFetch();

    await expect(runRemindersTick({ enqueue }, { fetch })).rejects.toBe(boom);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('runs without pinging when the URL is unset', async () => {
    const saved = env.REMINDERS_TICK_HEARTBEAT_URL;
    env.REMINDERS_TICK_HEARTBEAT_URL = undefined;
    try {
      vi.mocked(handleRemindersTick).mockResolvedValueOnce({ enqueued: 0 });
      const fetch = okFetch();
      await expect(runRemindersTick({ enqueue }, { fetch })).resolves.toEqual({ enqueued: 0 });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      env.REMINDERS_TICK_HEARTBEAT_URL = saved;
    }
  });
});

describe('runSearchReindex', () => {
  it('reindexes, then pings its own URL (not the tick URL) once', async () => {
    vi.mocked(handleSearchReindex).mockResolvedValueOnce({ processed: 5, lastTaskUid: 9 });
    const fetch = okFetch();

    await expect(runSearchReindex({ fetch })).resolves.toEqual({ processed: 5, lastTaskUid: 9 });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(env.SEARCH_REINDEX_HEARTBEAT_URL, {
      signal: expect.any(AbortSignal),
    });
  });

  it('does not ping when the reindex throws', async () => {
    const boom = new Error('meili down');
    vi.mocked(handleSearchReindex).mockRejectedValueOnce(boom);
    const fetch = okFetch();

    await expect(runSearchReindex({ fetch })).rejects.toBe(boom);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still resolves when the monitor is down', async () => {
    vi.mocked(handleSearchReindex).mockResolvedValueOnce({ processed: 0, lastTaskUid: null });
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(runSearchReindex({ fetch })).resolves.toEqual({
      processed: 0,
      lastTaskUid: null,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run worker/monitored-jobs.test.ts`
Expected: FAIL, `Failed to resolve import "./monitored-jobs"`.

- [ ] **Step 3: Create the module**

Create `worker/monitored-jobs.ts`:

```ts
import { getEnv } from '@/lib/env';
import { type HeartbeatOptions, withHeartbeat } from '@/lib/heartbeat-ping';
import { handleRemindersTick } from './jobs/reminders-tick';
import { handleSearchReindex } from './jobs/search-reindex';

// The scheduled entry points that carry a dead-man ping. worker/index.ts's
// boss.work() callbacks call these, not the handlers directly, so the ping
// fires only from the cron path and only after a run that resolved.
//
// The startup missed-tick recovery in worker/index.ts deliberately calls
// handleRemindersTick directly: the monitor exists to prove that pg-boss cron
// keeps creating tick jobs and this worker keeps consuming them, and a ping
// on every boot would paper over a cron that has stopped.
//
// pg-dump keeps its own ping inside handlePgDump (it pings after pruning and
// reports the outcome in its result).
//
// What a ping proves differs per job. reminders.tick: the tick ran to the end.
// search.reindex: the rebuild was SUBMITTED without throwing. handleSearchReindex
// returns once Meilisearch has accepted its tasks (delete, settings, document
// batches); it does not wait for them to be processed, so the ping does not
// mean the index is populated.

type RemindersTickDeps = Parameters<typeof handleRemindersTick>[0];

export function runRemindersTick(deps: RemindersTickDeps, opts: HeartbeatOptions = {}) {
  return withHeartbeat(
    'reminders-tick',
    getEnv().REMINDERS_TICK_HEARTBEAT_URL,
    () => handleRemindersTick(deps),
    opts,
  );
}

export function runSearchReindex(opts: HeartbeatOptions = {}) {
  return withHeartbeat(
    'search-reindex',
    getEnv().SEARCH_REINDEX_HEARTBEAT_URL,
    () => handleSearchReindex(),
    opts,
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run worker/monitored-jobs.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Wire the two cron callbacks**

In `worker/index.ts`:

1. Delete `import { handleSearchReindex } from './jobs/search-reindex';`, and after `import { handleThumbnail, type ThumbnailJob } from './jobs/thumbnail';` add:

   ```ts
   import { runRemindersTick, runSearchReindex } from './monitored-jobs';
   ```

   Keep `import { handleRemindersTick } from './jobs/reminders-tick';`: the startup missed-tick recovery still calls it directly, on purpose (see the module comment).

2. Replace:

   ```ts
     await boss.work(Queue.RemindersTick, { batchSize: 1 }, async () => {
       await handleRemindersTick({
   ```

   with:

   ```ts
     // Pings REMINDERS_TICK_HEARTBEAT_URL after each tick that completes.
     await boss.work(Queue.RemindersTick, { batchSize: 1 }, async () => {
       await runRemindersTick({
   ```

3. Replace:

   ```ts
     await boss.work(Queue.SearchReindex, { batchSize: 1 }, async () => {
       await handleSearchReindex();
     });
   ```

   with:

   ```ts
     // Pings SEARCH_REINDEX_HEARTBEAT_URL after each rebuild that completes.
     await boss.work(Queue.SearchReindex, { batchSize: 1 }, async () => {
       await runSearchReindex();
     });
   ```

- [ ] **Step 6: Check the worker still resolves and the handlers still pass**

```bash
pnpm typecheck
pnpm lint:worker-graph          # expect: OK
pnpm exec tsx -e "import('./worker/monitored-jobs').then(() => console.log('ok'))"   # expect: ok (runtime resolution, as the image does it)
pnpm exec vitest run tests/integration/reminders-tick.test.ts tests/integration/search-reindex.test.ts tests/integration/missed-tick-recovery.test.ts
```

Expected: all pass. The integration tests call the handlers directly, which are unchanged.

- [ ] **Step 7: Commit**

```bash
git add worker/monitored-jobs.ts worker/monitored-jobs.test.ts worker/index.ts
git commit -m "feat(worker): dead-man pings for reminders.tick and search.reindex"
git log --oneline -1
```

---

### Task 5: Logged errors keep their message and stack; no unscrubbed `msg`; scrub the token routes

**Files:**
- Modify: `lib/log-scrub.ts`, `lib/log-scrub.test.ts`, `lib/logger.ts`, `lib/logger.test.ts`

- [ ] **Step 1: See both bugs**

```bash
node_modules/.bin/tsx -e "import('./lib/logger.ts').then((m) => m.getLogger('x').error({ err: new Error('visible?') }, 'probe'))"
node_modules/.bin/tsx -e "import('./lib/logger.ts').then((m) => m.getLogger('x').error({ err: new Error('pw=' + 'PGPASSWORD=' + 'hunter2') }))"
```

Expected (the bugs): the first prints `…"err":{},"msg":"probe"}`, with no message and no stack. The second prints `"msg":"pw=PGPASSWORD=hunter2"`: the one string no scrubbing layer touched.

- [ ] **Step 2: Write the failing tests**

In `lib/logger.test.ts`, insert these two blocks directly before `describe('logger', () => {`. They reuse the file's existing `captureLogger` and `DB_URL`.

```ts
// Regression (#169, 2026-05-22 until this fix): formatters.log runs before the
// err serializer and flattened every Error to its enumerable fields, so every
// `{ err }` in production logs was `{}`. Mutation-checked: removing the
// `instanceof Error` branch in deepScrubStrings fails all three.
describe('logger error serialization', () => {
  it('keeps type, message and stack of an { err }', () => {
    const { log, lines } = captureLogger();
    log.error({ err: new TypeError('fetch failed') }, 'ping failed');
    expect(lines[0].err).toMatchObject({ type: 'TypeError', message: 'fetch failed' });
    expect((lines[0].err as { stack?: string }).stack).toContain('TypeError: fetch failed');
  });

  it('keeps an Error passed as the first argument, and its cause and custom fields', () => {
    const { log, lines } = captureLogger();
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    log.error(new Error('outer', { cause }));
    expect(lines[0].msg).toBe('outer');
    expect(lines[0].err).toMatchObject({
      type: 'Error',
      message: 'outer',
      cause: { type: 'Error', message: 'connect ECONNREFUSED', code: 'ECONNREFUSED' },
    });
  });

  it('still scrubs secrets inside the message and stack', () => {
    const { log, lines } = captureLogger();
    log.error({ err: new Error(`cannot reach ${DB_URL}`) }, 'db');
    const err = lines[0].err as { message: string; stack: string };
    expect(err.message).toBe(`cannot reach ${DB_URL.replace('s3cr3tP%40ss', '***')}`);
    expect(err.stack).not.toContain('s3cr3tP%40ss');
  });

  // The err serializer re-scrubs only the top-level `err`. Everything below is
  // scrubbed by deepScrubStrings walking the Error's fields in formatters.log.
  // Mutation-checked: returning errorFields(value) unscrubbed fails all three,
  // and dropping the aggregateErrors line fails the last.
  it('scrubs secrets in a cause, an Error under another key, and AggregateError members', () => {
    const { log, lines } = captureLogger();
    const masked = `cannot reach ${DB_URL.replace('s3cr3tP%40ss', '***')}`;
    log.error({ err: new Error('outer', { cause: new Error(`cannot reach ${DB_URL}`) }) }, 'a');
    log.error({ error: new Error(`cannot reach ${DB_URL}`) }, 'b');
    log.error({ err: new AggregateError([new Error(`cannot reach ${DB_URL}`)], 'many') }, 'c');

    expect(JSON.stringify(lines)).not.toContain('s3cr3tP%40ss');
    expect((lines[0].err as { cause: { message: string } }).cause.message).toBe(masked);
    expect((lines[1].error as { message: string }).message).toBe(masked);
    expect(
      (lines[2].err as { aggregateErrors: Array<{ message: string }> }).aggregateErrors[0].message,
    ).toBe(masked);
  });
});

// pino fills a missing message from err.message after every scrubbing layer.
// Mutation-checked: removing the derivedErrorMessage push fails the first test.
describe('logger message derived from an Error', () => {
  const MASKED = `cannot reach ${DB_URL.replace('s3cr3tP%40ss', '***')}`;

  it('scrubs the msg pino derives from err.message when no message is given', () => {
    const { log, lines } = captureLogger();
    log.error({ err: new Error(`cannot reach ${DB_URL}`) });
    log.error(new Error(`cannot reach ${DB_URL}`));
    expect(lines.map((l) => l.msg)).toEqual([MASKED, MASKED]);
    expect(JSON.stringify(lines)).not.toContain('s3cr3tP%40ss');
  });

  // pino derives msg from ANY truthy err, not only an Error.
  it('scrubs the msg derived from a plain-object err', () => {
    const { log, lines } = captureLogger();
    log.error({ err: { message: `cannot reach ${DB_URL}` } });
    expect(lines[0].msg).toBe(MASKED);
    expect(JSON.stringify(lines)).not.toContain('s3cr3tP%40ss');
  });

  // Logging must never throw: scrubSecrets on a number would.
  it('does not throw, or derive a msg, when err.message is not a string', () => {
    const { log, lines } = captureLogger();
    const err = new Error('x');
    (err as { message: unknown }).message = 42;
    expect(() => log.error({ err })).not.toThrow();
    expect(() => log.error({ err: { message: { nested: true } } })).not.toThrow();
    expect(lines).toHaveLength(2);
  });

  it('leaves an explicit message, or a msg in the merge object, alone', () => {
    const { log, lines } = captureLogger();
    log.error({ err: new Error('boom') }, 'explicit');
    log.error({ err: new Error('boom'), msg: 'from merge object' });
    expect(lines.map((l) => l.msg)).toEqual(['explicit', 'from merge object']);
  });
});
```

In `lib/log-scrub.test.ts`, insert this `it` directly before `it('leaves ordinary text untouched (no false positives)', () => {`:

```ts
  it('masks the capability token in the calendar and inbound-email routes', () => {
    expect(scrubSecrets('GET /api/calendar/9f8e7d6c5b4a.ics')).toBe('GET /api/calendar/***');
    expect(scrubSecrets('https://hm.example/api/inbound-email/abcDEF123456?x=1')).toBe(
      'https://hm.example/api/inbound-email/***?x=1',
    );
    // Other routes, and the bare prefix, are left alone.
    expect(scrubSecrets('/api/files/abc123')).toBe('/api/files/abc123');
    expect(scrubSecrets('/api/calendar/')).toBe('/api/calendar/');
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm exec vitest run lib/logger.test.ts lib/log-scrub.test.ts`
Expected: 7 failed (19 passed): the four serialization/scrubbing tests (e.g. `expected {} to match object { type: 'TypeError', … }`), the two derived-message tests, and the token-route test. "does not throw … when err.message is not a string" already passes on `main` and must keep passing.

- [ ] **Step 4: Implement `lib/log-scrub.ts`**

Add this entry as the **last** element of `PATTERNS` (after the `sk-` line):

```ts
  // Capability tokens in the two public token-scoped routes. The path segment
  // IS the credential (the calendar feed's icsToken, the inbound webhook's
  // token), and request paths reach error reports via onRequestError.
  [/(\/api\/(?:calendar|inbound-email)\/)[^\s/?#"']+/g, '$1***'],
```

Then replace the whole `deepScrubStrings` function (keep its JSDoc) with:

```ts
export function deepScrubStrings(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubSecrets(value);
  if (Array.isArray(value)) return value.map((v) => deepScrubStrings(v, seen));
  if (value instanceof Error) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return scrubObject(errorFields(value), seen);
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return scrubObject(value, seen);
  }
  return value;
}

function scrubObject(value: object, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = deepScrubStrings(v, seen);
  }
  return out;
}

/**
 * An Error's `message` and `stack` are own but NON-enumerable, so walking it
 * like a plain object yields only its custom fields (`code`, `cmd`, ...).
 * pino runs `formatters.log` (which calls deepScrubStrings) BEFORE the `err`
 * serializer, so without this every logged `{ err }` reached stdout as `{}`
 * plus custom fields: no message, no stack. Same shape as pino's own
 * stdSerializers.err (`type`, `message`, `stack`, then custom fields), plus a
 * nested `cause`.
 */
function errorFields(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: err.constructor?.name ?? err.name,
    message: err.message,
    stack: err.stack,
  };
  for (const [k, v] of Object.entries(err)) out[k] = v;
  if (err.cause !== undefined) out.cause = err.cause;
  if (err instanceof AggregateError) out.aggregateErrors = err.errors;
  return out;
}
```

- [ ] **Step 5: Implement `lib/logger.ts`**

Directly after the line `const level = process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info');` add:

```ts

/**
 * The message pino will derive when the call passes no message of its own:
 * `logger.error({ err })` or `logger.error(err)`. pino fills `msg` from
 * `err.message` in `write()` (proto.js) for ANY truthy `err`, Error or not,
 * AFTER hooks.logMethod and outside formatters.log, so without this the one
 * secret-bearing string that skips every scrubbing layer is the log line's
 * `msg`. Mirrors pino's rule (an explicit `msg` in the merge object wins), and
 * only ever returns a string: a non-string `message` is left to pino, because
 * scrubSecrets on it would throw, and a log call must never throw.
 */
function derivedErrorMessage(args: readonly unknown[]): string | undefined {
  if (args.length !== 1) return undefined;
  const [first] = args;
  let message: unknown;
  if (first instanceof Error) {
    message = first.message;
  } else if (first !== null && typeof first === 'object') {
    const { msg, err } = first as { msg?: unknown; err?: unknown };
    if (msg === undefined && err) message = (err as { message?: unknown }).message;
  }
  return typeof message === 'string' ? message : undefined;
}
```

Replace the `serializers` block:

```ts
  serializers: {
    // Serialize the Error the standard way, then scrub embedded secrets from the
    // resulting strings (message, stack, and custom props like cmd/spawnargs).
    err: (e: unknown) => deepScrubStrings(pino.stdSerializers.err(e as Error)),
  },
```

with:

```ts
  serializers: {
    // pino runs formatters.log BEFORE serializers, so by the time this sees
    // `err` it is usually already the plain { type, message, stack, ... } that
    // deepScrubStrings makes of an Error. Not pino.stdSerializers.err: given
    // that plain object it would relabel `type` as 'Object'. deepScrubStrings
    // serializes a raw Error the same way, so both paths agree.
    err: (e: unknown) => deepScrubStrings(e),
  },
```

(`pino` is still imported: `pino(loggerOptions)` uses it.) And in `hooks.logMethod`, replace:

```ts
      const scrubbed = args.map((a) => (typeof a === 'string' ? scrubSecrets(a) : a));
      return method.apply(this, scrubbed as typeof args);
```

with:

```ts
      const scrubbed = args.map((a) => (typeof a === 'string' ? scrubSecrets(a) : a));
      // No message given: supply the scrubbed err.message so pino doesn't
      // derive an unscrubbed one (see derivedErrorMessage).
      const derived = derivedErrorMessage(args);
      if (derived !== undefined) scrubbed.push(scrubSecrets(derived));
      return method.apply(this, scrubbed as typeof args);
```

- [ ] **Step 6: Run them to verify they pass, and re-run the probes**

```bash
pnpm exec vitest run lib/logger.test.ts lib/log-scrub.test.ts
node_modules/.bin/tsx -e "import('./lib/logger.ts').then((m) => m.getLogger('x').error({ err: new Error('visible?') }, 'probe'))"
node_modules/.bin/tsx -e "import('./lib/logger.ts').then((m) => m.getLogger('x').error({ err: new Error('pw=' + 'PGPASSWORD=' + 'hunter2') }))"
```

Expected: 15 + 11 passed. The first probe prints `"err":{"type":"Error","message":"visible?","stack":"Error: visible?\n    at …"}`; the second prints `"msg":"pw=PGPASSWORD=***"` and no `hunter2` anywhere.

- [ ] **Step 7: Mutation checks (do, observe, undo; one at a time)**

Run `pnpm exec vitest run lib/logger.test.ts lib/log-scrub.test.ts` after each edit, then revert it. Every row must fail at least the stated count:

| Edit | Expect |
|---|---|
| `lib/log-scrub.ts`: `return scrubObject(errorFields(value), seen);` → `return errorFields(value);` | 1 fail (cause / other key / AggregateError test) |
| `lib/log-scrub.ts`: delete `if (err instanceof AggregateError) out.aggregateErrors = err.errors;` | 1 fail |
| `lib/log-scrub.ts`: `if (value instanceof Error) {` → `if (value instanceof Error && false) {` | 4 fail |
| `lib/logger.ts`: delete `if (derived !== undefined) scrubbed.push(scrubSecrets(derived));` | 2 fail |
| `lib/logger.ts`: `if (msg === undefined && err) message` → `if (msg === undefined && err instanceof Error) message` | 1 fail (plain-object `err`) |
| `lib/logger.ts`: `return typeof message === 'string' ? message : undefined;` → `return message === undefined ? undefined : (message as string);` | 1 fail (the log call throws) |

After the last revert, rerun: 26 passed.

- [ ] **Step 8: Commit**

```bash
git add lib/log-scrub.ts lib/log-scrub.test.ts lib/logger.ts lib/logger.test.ts
git commit -m "fix(logger): logged errors keep message and stack (every err was {} since #169); scrub derived msg and token routes"
git log --oneline -1
```

---

### Task 6: Docs

**Files:**
- Modify: `docs/observability.md`

(`docs/README.md`, `.env.example` and `docker-compose.yml` got their rows in Task 3; `CLAUDE.md` and `docs/TESTING.md` in Task 1.)

- [ ] **Step 1: Add the Dead-man monitors section**

In `docs/observability.md`, insert this section directly before `## Reading logs in dev`:

````markdown
## Dead-man monitors

A job with a heartbeat URL GETs it after every run that **completes**. A run that throws sends nothing (pg-boss retries it), so the monitor goes red by silence. The ping itself is fail-soft: a monitor outage never fails the job. It logs `<job>.heartbeat.failed` with the HTTP status, or the error's name and cause code, and never the URL, which carries the push token.

| Job | Env var | Runs | uptime-kuma Heartbeat Interval | Retries |
|---|---|---|---|---|
| `pg-dump` | `BACKUP_HEARTBEAT_URL` | daily 03:00 UTC | `90000` (25 h) | `0` |
| `reminders.tick` | `REMINDERS_TICK_HEARTBEAT_URL` | every 5 min | `900` (15 min, three missed ticks) | `0` |
| `search.reindex` | `SEARCH_REINDEX_HEARTBEAT_URL` | daily 03:00 UTC | `90000` (25 h) | `0` |

What a ping proves: for `pg-dump`, a dump that passed validation; for `reminders.tick`, a tick that ran to the end; for `search.reindex`, a rebuild **submitted** to Meilisearch without throwing. The job returns once Meilisearch has accepted its tasks and does not wait for them to be processed, so a green monitor does not mean the index is populated.

Only the scheduled runs ping. The worker's startup missed-tick recovery calls the reminders tick directly and does **not** ping, so a cron that has stopped firing cannot be hidden by the worker restarting.

To add one: **Add New Monitor** → type **Push**, set the interval and retries above, copy the Push URL, set it on the **worker** container, and recreate the worker. When uptime-kuma shares a Docker network with the worker, prefer its internal URL (`http://uptime-kuma:3001/api/push/<token>?status=up&msg=OK&ping=`) so the ping never depends on the reverse proxy.

The monitors a deployment should have:

- web: an HTTP monitor on `/api/health`
- worker: a Docker container monitor. Treat anything but `healthy` as down: a crash-looping container never leaves `starting`.
- the three Push monitors above
````

(The README rows added in Task 3 link to `observability.md#dead-man-monitors`, which this creates.)

- [ ] **Step 2: Say what a logged error now contains**

In the `## Redaction` section, after its last line (`Add new paths to lib/logger.ts as new sensitive fields appear.`), add:

```markdown

Secrets embedded in string **values** (a DB password inside a connection string, a Bearer token, an `sk-` key, the token in `/api/calendar/<token>` and `/api/inbound-email/<token>`) are masked by `lib/log-scrub.ts`, everywhere in the line. That includes a logged Error: `err` keeps its `type`, `message`, `stack`, `cause` and custom fields, scrubbed, and when a call passes no message (`logger.error({ err })`), the `msg` pino derives from `err.message` is scrubbed too.
```

- [ ] **Step 3: Commit**

```bash
git add docs/observability.md
git commit -m "docs(observability): dead-man monitors; what a logged error contains"
git log --oneline -1
```

---

### Task 7: Full verification

- [ ] **Step 1: The pre-push gate**

Run: `pnpm verify`
Expected: Biome, `lint:tokens`, `lint:worker-graph` and `lint:knip` pass; tsc clean; `test:unit` passes (122 files, 1457 tests).

- [ ] **Step 2: Every integration file whose code path moved, plus the two that left the unit run**

```bash
pnpm exec vitest run tests/integration/reminders-tick.test.ts tests/integration/search-reindex.test.ts tests/integration/missed-tick-recovery.test.ts tests/integration/pg-dump-restore.test.ts tests/integration/chat/apply.test.ts tests/integration/chat/apply-part.test.ts
```

Expected: 6 files, 45 tests pass. (`pg-dump-restore` needs a PostgreSQL 18 client on PATH; see `docs/TESTING.md`.)

- [ ] **Step 3: The worker still resolves at runtime the way the image runs it**

```bash
pnpm lint:worker-graph
pnpm exec tsx -e "import('./worker/monitored-jobs').then(() => console.log('ok'))"   # expect: ok
```

- [ ] **Step 4 (optional): coverage floor**

`pnpm test:coverage:check`. This PR adds tests for every new line and moves 21 worker tests into the unit run, so the merged floor can only rise. **Never lower a threshold in `vitest.config.ts`.**

No e2e run is needed: nothing under `app/` or `components/` changed.

---

### Task 8: Owner steps (list only; the implementer does NOT do these)

These run outside this repo. Put them in the PR body.

1. **uptime-kuma Push monitors**: type Push, Retries `0`.
   - `house-manager reminders.tick`: Heartbeat Interval `900` (15 min = three missed 5-min ticks)
   - `house-manager search.reindex`: Heartbeat Interval `90000` (25 h)

   Prefer the internal URL `http://uptime-kuma:3001/api/push/<token>?status=up&msg=OK&ping=` (same `dockge_default` network as the worker). Also confirm a Docker container monitor exists for `housemanager-worker` that treats anything but `healthy` as down.
2. **docker-piwine, via 1Password.** Add the two Push URLs as fields on the `piwine-housemanager` item, reference them from `compose.env` in the existing `HOUSEMANAGER_*` style (`HOUSEMANAGER_REMINDERS_TICK_HEARTBEAT_URL`, `HOUSEMANAGER_SEARCH_REINDEX_HEARTBEAT_URL`), and add to the **`housemanager-worker`** `environment` in `housemanager/compose.yaml`: `REMINDERS_TICK_HEARTBEAT_URL: ${HOUSEMANAGER_REMINDERS_TICK_HEARTBEAT_URL}` and `SEARCH_REINDEX_HEARTBEAT_URL: ${HOUSEMANAGER_SEARCH_REINDEX_HEARTBEAT_URL}`, as #508 did for `BACKUP_HEARTBEAT_URL`. Use `op run` with `${VAR}` placeholders; don't source `compose.env` over SSH. (The planning session could not read docker-piwine, because `gh api` timed out on authorization. Check names against the file first.)
3. **After the digest bump deploys this image**, recreate the worker (a restart keeps the old env). `reminders.tick` goes green within 5 minutes; `search.reindex` after the next 03:00 UTC run (pending until then).
4. **Look at the logs once.** `docker logs housemanager-worker 2>&1 | grep '"level":50' | tail -3`: any `err` now shows a `message` and `stack`. That is new information: four months of errors were logged as `{}`.

---

### Task 9: PR

- [ ] **Step 1: Rebase on current `main`**

```bash
git fetch origin
git rebase origin/main
```

Resolve conflicts without `--no-verify`. Likely overlaps: the `docs/README.md` env table and `CLAUDE.md`. Keep both sides. If anything was rebased, rerun Task 7 Steps 1–2.

- [ ] **Step 2: Check this plan for invisible characters and credentialed URLs, then copy it into the repo**

```bash
python3 - <<'EOF'
import re, sys, unicodedata
p = '.full-review/plans/2026-09-24-logging-and-heartbeats.md'
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
[ -n "$GITGUARDIAN_API_KEY" ] && ggshield secret scan path .full-review/plans/2026-09-24-logging-and-heartbeats.md
cp .full-review/plans/2026-09-24-logging-and-heartbeats.md docs/superpowers/plans/2026-09-24-logging-and-heartbeats.md
git add docs/superpowers/plans/2026-09-24-logging-and-heartbeats.md
git commit -m "docs(plans): logging and heartbeats implementation plan"
git log --oneline -1
```

Expected: `invisible: clean`, `credentialed URLs: none`, and ggshield (if the key is set) reports no incidents. The only credential-shaped URLs in this plan are built from `${…}` parts, plus the `u:p@localhost` fixture copied verbatim from `tests/unit/env.test.ts`, which CI's ggshield already passes. If the check lists anything else, rewrite it from parts in the source plan, then copy.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin fix/logging-and-heartbeats
gh pr create --title "fix(logging): logged errors keep message + stack; dead-man pings for reminders.tick + search.reindex" --body "$(cat <<'EOF'
First half of the review's P1 "production error reporting is effectively off": the part that needs no Sentry. The Sentry half is a follow-up PR built on this one.

**Logs.** Every logged `err` has been `{}` since #169: pino runs `formatters.log` before serializers, and the scrubber walked Errors as plain objects (message and stack are non-enumerable). Logged errors now keep `type`, `message`, `stack`, `cause` and custom fields, scrubbed. When a call passes no message, the `msg` pino derives from `err.message` was the one string no scrubbing layer touched; it's scrubbed now. The capability token in `/api/calendar/<token>` and `/api/inbound-email/<token>` is masked everywhere in a log line.

**Dead-man pings (O-H1).** #508's `pingHeartbeat` moves to `lib/heartbeat-ping.ts` (fail-soft, never logs the URL; `pg-dump`'s tests are unchanged and green). New optional `REMINDERS_TICK_HEARTBEAT_URL` and `SEARCH_REINDEX_HEARTBEAT_URL`, pinged only by the cron path and only after a run that completes. Startup missed-tick recovery doesn't ping, so a stopped cron can't hide behind restarts.

**Tests.** `test:unit`'s filters were substring matches: `worker/jobs` left `worker/heartbeat.test.ts` and `worker/health-server.test.ts` (21 tests) out of every CI job, and `app` pulled in `tests/integration/chat/apply*.test.ts`. Now `worker/` and `app/`.

**Owner steps after merge:**
1. uptime-kuma Push monitors: reminders.tick interval 900, search.reindex interval 90000, retries 0; internal `http://uptime-kuma:3001/api/push/<token>?status=up&msg=OK&ping=`.
2. docker-piwine: 1Password fields, `HOUSEMANAGER_REMINDERS_TICK_HEARTBEAT_URL` / `HOUSEMANAGER_SEARCH_REINDEX_HEARTBEAT_URL` in `compose.env`, both vars on `housemanager-worker` only.
3. After deploy: recreate the worker; both monitors go green (reindex after 03:00 UTC).

Plan: `docs/superpowers/plans/2026-09-24-logging-and-heartbeats.md`.

Test plan: `pnpm verify`; `pnpm exec vitest run tests/integration/reminders-tick.test.ts tests/integration/search-reindex.test.ts tests/integration/missed-tick-recovery.test.ts tests/integration/pg-dump-restore.test.ts tests/integration/chat/apply.test.ts tests/integration/chat/apply-part.test.ts`; CI image smoke test.
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

On a failure, fix it, push, and watch again. Once merged:

```bash
gh pr view --json state --jq .state      # expect MERGED
git checkout main && git pull --ff-only && git branch -d fix/logging-and-heartbeats
```

Then hand over to `2026-09-24-production-observability.md`, whose Task 0 starts from this merge.

---

## Acceptance criteria

- [ ] `docker logs` shows `type`, `message` and `stack` for every logged `err`, with secrets masked.
- [ ] A call with no message never writes an unscrubbed `err.message` as `msg`.
- [ ] `/api/calendar/<token>` and `/api/inbound-email/<token>` never appear with the real token in a log line.
- [ ] `reminders.tick` and `search.reindex` GET their URL after each completed cron run, never after a throw, never from startup recovery, and never log the URL. `pg-dump`'s behaviour and tests are unchanged.
- [ ] `pnpm test:unit` runs `worker/*.test.ts` and no `tests/integration/` file; `pnpm verify` is green.

## Deliberately out of scope

- **Everything Sentry**: `onRequestError`, the browser SDK, the Pino → Sentry bridge, event scrubbing, source maps. That's `2026-09-24-production-observability.md`.
- **Reporting pg-boss job failures**, and **job freshness in the worker's `/api/health`** (O-H1 item 2).
- **Log retention across deploys** (O-L4) and uptime-kuma's own single-host blind spot.
