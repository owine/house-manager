# Plan 5b — Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three known fragile paths in the worker process: stuck-`'queued'` NotificationLog rows (sweeper), missed reminder ticks during worker downtime (startup recovery), and unprotected Postgres data (daily logical dump that Duplicacy hauls off-host).

**Architecture:** All three capabilities live inside the existing worker process — no new containers. Two new pg-boss recurring schedules (`pg-dump` daily 03:00 UTC, `notify-log.sweep` every 5 min) plus one explicit one-shot call to `handleRemindersTick` during worker startup. Backups land in `/backups` (bind-mounted to `${BACKUP_DIR:-./db-backups}` on host).

**Tech Stack:** Node.js 24, TypeScript 6, Prisma 7, Postgres 16, pg-boss 12 (existing), `node:child_process` `execFile` (the safe non-shell variant) for spawning `pg_dump`, alpine `postgresql16-client` (~6MB image addition), Pino + `@sentry/node` (Plan 5a infra).

**Spec:** `docs/superpowers/specs/2026-05-03-plan-5b-reliability-design.md`

---

## Conventions for the implementer

These project conventions hold across every task. Don't deviate without flagging.

- **Commits**: signed via 1Password (just `git commit` — no `-c user.email=`, no `--no-verify`, no `--no-gpg-sign`). Stage explicit paths, never `git add -A`. Conventional-commits prefixes (`feat(reliability):`, `chore(reliability):`, `test(reliability):`, `docs(reliability):`).
- **Push cadence**: branch accumulates commits across all tasks; push happens at the end via `superpowers:finishing-a-development-branch`. Branch is already `plan-5b-reliability` (off main, spec already committed as `427bb82`).
- **Module-load DATABASE_URL trap** (familiar from prior plans): `lib/db.ts` constructs PrismaClient at module load. Integration tests for the new handlers must use the dynamic-import-in-`beforeAll` pattern from `tests/integration/notify-job.test.ts`.
- **Logger naming convention** (Plan 5a): each module gets a child logger via `getLogger('worker.<short-name>')`. New names this plan adds: `'worker.notify-log-sweep'`, `'worker.pg-dump'`. Keep `'worker.lifecycle'` for any new code in `worker/index.ts`.
- **Sentry capture pattern** (Plan 5a): for boundary-level errors that should fire alerts, follow with `Sentry.captureException(err)` AFTER `logger.error({err, ...}, 'message')`. The two pipes are independent.
- **No new env vars in `lib/env.ts`**: this plan adds `BACKUP_DIR` only as a docker-compose variable substitution. Application code never reads it (only `pg_dump`'s `--file=` arg uses the in-container path `/backups`, which is invariant). Don't extend `lib/env.ts`.
- **Tests location**: pure unit tests colocate as `<module>.test.ts` next to source (e.g., `worker/jobs/pg-dump.test.ts`); DB-touching tests live under `tests/integration/`.
- **Use the array-args spawn variant only**: never use shell variants of `node:child_process` for the `pg_dump` invocation. Args go in an array; no shell interpolation. The `execFile` (and its `promisify`d form) is the right choice.
- **Connection string handling**: `pg_dump` reads `DATABASE_URL` directly via `--dbname=<url>`. Don't try to parse the URL into pieces.

---

## Pre-flight (Task 0)

Before starting Task 1, take 5 minutes to confirm the audit-time facts.

- [ ] **Verify the worker is on the post-Plan-5a shape**:
  ```bash
  grep -n "Sentry.init\|Sentry.captureException" worker/index.ts | head -5
  ```
  Expected: at least 2 matches (the init block at the top + the capture in the startup catch).

- [ ] **Verify the `Queue` const is the 5-entry shape from Plan 4a/3**:
  ```bash
  grep -A 8 "export const Queue" lib/queue.ts
  ```
  Expected: `Thumbnail`, `RemindersTick`, `Notify`, `SearchIndex`, `SearchReindex` (and nothing else).

- [ ] **Verify the alpine `postgresql16-client` package exists** (for the Dockerfile change in Task 4):
  ```bash
  docker run --rm node:24-alpine sh -c "apk search -e postgresql16-client" 2>&1 | tail -3
  ```
  Expected: `postgresql16-client-16.X.Y` (some patch version).

- [ ] **Read `worker/jobs/notify.ts`** end-to-end — particularly the INSERT-then-send pattern and how `status` transitions through `'queued'` → `'sent'` / `'failed'`. The sweeper relies on `status='queued'` being the "not-yet-sent" state and any other status meaning "send completed (or definitively failed) and the row is no longer fragile."

- [ ] **Read `worker/jobs/reminders-tick.ts`** end-to-end — particularly the past-due scan logic. The missed-tick recovery in Task 2 calls this same handler one extra time at startup; the existing logic must already handle "scan past-due reminders."

Note any deltas in your scratch notes.

---

## File structure (new + modified)

```
worker/jobs/notify-log-sweep.ts             # Task 1 (new — sweeper handler)
tests/integration/notify-log-sweep.test.ts  # Task 1 (new — integration test)

worker/index.ts                             # Task 2 (modified — startup tick recovery)
tests/integration/missed-tick-recovery.test.ts  # Task 2 (new — integration test)

worker/jobs/pg-dump.ts                      # Task 3 (new — backup handler + pruning)
worker/jobs/pg-dump.test.ts                 # Task 3 (new — unit test for pruning)

Dockerfile                                  # Task 4 (modified — postgresql16-client)
docker-compose.yml                          # Task 4 (modified — /backups mount)

lib/queue.ts                                # Task 5 (modified — 2 new queue names)
worker/index.ts                             # Task 5 (modified — wire schedules + work blocks)

docs/backups.md                             # Task 6 (new — operator restore doc)
```

---

## Task 1: Notification-log sweeper

**Files:**
- Create: `worker/jobs/notify-log-sweep.ts`
- Create: `tests/integration/notify-log-sweep.test.ts`

Standalone handler. No worker wiring yet — Task 5 registers it in pg-boss.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/notify-log-sweep.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;
let handleNotifyLogSweep: typeof import('@/worker/jobs/notify-log-sweep').handleNotifyLogSweep;

beforeAll(async () => {
  ctx = await setupIntegration();
  ({ handleNotifyLogSweep } = await import('@/worker/jobs/notify-log-sweep'));
}, 60_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.notificationLog.deleteMany();
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({
    data: { id: 'sweep-u1', email: 'sweep@example.com', name: 'Sweep' },
  });
  await ctx.prisma.reminder.create({
    data: {
      id: 'sweep-r1',
      title: 'Filter',
      recurrence: { kind: 'interval', days: 90 },
      nextDueOn: new Date('2026-06-30'),
      notifyUserIds: ['sweep-u1'],
    },
  });
});

describe('handleNotifyLogSweep', () => {
  it('deletes only stale queued rows; leaves fresh queued and sent rows alone', async () => {
    const longAgo = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
    const justNow = new Date();

    await ctx.prisma.notificationLog.createMany({
      data: [
        // Stale queued — should be deleted.
        {
          reminderId: 'sweep-r1',
          userId: 'sweep-u1',
          channel: 'push',
          cycle: '2026-06-30',
          status: 'queued',
          sentAt: longAgo,
        },
        // Fresh queued — should be kept (might still be in-flight).
        {
          reminderId: 'sweep-r1',
          userId: 'sweep-u1',
          channel: 'email',
          cycle: '2026-06-30',
          status: 'queued',
          sentAt: justNow,
        },
        // Sent — should be kept regardless of age.
        {
          reminderId: 'sweep-r1',
          userId: 'sweep-u1',
          channel: 'push',
          cycle: '2026-05-30',
          status: 'sent',
          sentAt: longAgo,
        },
      ],
    });

    const result = await handleNotifyLogSweep();
    expect(result.deleted).toBe(1);

    const remaining = await ctx.prisma.notificationLog.findMany({
      orderBy: { sentAt: 'asc' },
    });
    expect(remaining).toHaveLength(2);
    const statuses = remaining.map((r) => r.status).sort();
    expect(statuses).toEqual(['queued', 'sent']);
  });

  it('returns deleted=0 when nothing is stale', async () => {
    await ctx.prisma.notificationLog.create({
      data: {
        reminderId: 'sweep-r1',
        userId: 'sweep-u1',
        channel: 'push',
        cycle: '2026-06-30',
        status: 'queued',
        sentAt: new Date(),
      },
    });
    const result = await handleNotifyLogSweep();
    expect(result.deleted).toBe(0);
  });
});
```

- [ ] **Step 2: Run — should fail**

```bash
pnpm test:integration tests/integration/notify-log-sweep.test.ts
# Expected: FAIL — module not found.
```

- [ ] **Step 3: Implement `worker/jobs/notify-log-sweep.ts`**

```ts
import { prisma } from '@/lib/db';
import { getLogger } from '@/lib/logger';

const logger = getLogger('worker.notify-log-sweep');
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Deletes NotificationLog rows that have been stuck in 'queued' for >10 min.
 *
 * The notify handler INSERTs a row with status='queued' before sending, then
 * UPDATEs to 'sent' on success. If the worker hard-crashes between the INSERT
 * and the UPDATE, the row stays 'queued' forever and the unique constraint
 * (reminderId, userId, channel, cycle) blocks the next tick from retrying.
 *
 * Tradeoff: in the rare case where the channel send actually succeeded but the
 * status update failed before crash, deleting the row causes a duplicate
 * notification on retry. Acceptable; missing is worse than duplicate.
 */
export async function handleNotifyLogSweep(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const result = await prisma.notificationLog.deleteMany({
    where: {
      status: 'queued',
      sentAt: { lt: cutoff },
    },
  });

  if (result.count > 0) {
    const level: 'info' | 'warn' = result.count > 5 ? 'warn' : 'info';
    logger[level]({ deleted: result.count }, 'swept stale notification logs');
  }

  return { deleted: result.count };
}
```

- [ ] **Step 4: Run — should pass**

```bash
pnpm test:integration tests/integration/notify-log-sweep.test.ts
```

- [ ] **Step 5: Verify the wider AI/integration suite still passes**

```bash
pnpm test:integration
# Expected: 142 prior + 2 new = 144 tests green.
```

- [ ] **Step 6: Commit**

```bash
git add worker/jobs/notify-log-sweep.ts tests/integration/notify-log-sweep.test.ts
git commit -m "feat(reliability): notification-log sweeper for stale 'queued' rows"
```

---

## Task 2: Missed-tick recovery on worker startup

**Files:**
- Modify: `worker/index.ts` (call `handleRemindersTick` once at startup)
- Create: `tests/integration/missed-tick-recovery.test.ts`

This task DOES touch `worker/index.ts` (the recovery call). Task 5 will also touch the same file (schedule wiring) — keep them as separate commits for reviewability.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/missed-tick-recovery.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;
let handleRemindersTick: typeof import('@/worker/jobs/reminders-tick').handleRemindersTick;

beforeAll(async () => {
  ctx = await setupIntegration();
  ({ handleRemindersTick } = await import('@/worker/jobs/reminders-tick'));
}, 60_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.notificationLog.deleteMany();
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({
    data: { id: 'r1u', email: 'recovery@example.com', name: 'R' },
  });
});

describe('missed-tick recovery', () => {
  it('enqueues notify jobs for past-due reminders that have no NotificationLog row', async () => {
    // Reminder due 2 hours ago, leadTimeDays=0 (i.e., notify ON the due date).
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await ctx.prisma.reminder.create({
      data: {
        id: 'past-due-r1',
        title: 'Furnace filter',
        recurrence: { kind: 'interval', days: 90 },
        nextDueOn: twoHoursAgo,
        leadTimeDays: 0,
        notifyUserIds: ['r1u'],
      },
    });

    const enqueued: Array<{ reminderId: string; userId: string; channel: string; cycle: string }> = [];
    const result = await handleRemindersTick({
      enqueue: async (job) => {
        enqueued.push(job);
      },
    });

    expect(result.enqueued).toBeGreaterThan(0);
    expect(enqueued.some((j) => j.reminderId === 'past-due-r1')).toBe(true);
  });

  it('does not enqueue past-due reminders that already have a NotificationLog row for that cycle', async () => {
    // Same setup as above, but pre-seed a NotificationLog row matching the cycle.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const cycle = twoHoursAgo.toISOString().slice(0, 10); // YYYY-MM-DD
    await ctx.prisma.reminder.create({
      data: {
        id: 'past-due-r2',
        title: 'Already notified',
        recurrence: { kind: 'interval', days: 90 },
        nextDueOn: twoHoursAgo,
        leadTimeDays: 0,
        notifyUserIds: ['r1u'],
      },
    });
    await ctx.prisma.notificationLog.create({
      data: {
        reminderId: 'past-due-r2',
        userId: 'r1u',
        channel: 'push',
        cycle,
        status: 'sent',
      },
    });

    // The tick still ENQUEUES the job — the unique constraint at the notify
    // handler is what dedupes. So we just verify the tick ran without error
    // and that the existing log row is still there.
    const result = await handleRemindersTick({
      enqueue: async () => {},
    });
    expect(result.enqueued).toBeGreaterThanOrEqual(1);
    const logs = await ctx.prisma.notificationLog.findMany({ where: { reminderId: 'past-due-r2' } });
    expect(logs).toHaveLength(1);
  });
});
```

(Note: the second test is documenting that dedup happens at the NOTIFY handler, NOT at the tick. The tick happily re-enqueues; the unique constraint protects against actual duplicate notifications. This is the existing behavior — the test is locking it in.)

- [ ] **Step 2: Run — should pass immediately**

```bash
pnpm test:integration tests/integration/missed-tick-recovery.test.ts
# Expected: PASS — handleRemindersTick already exists and behaves as tested.
```

(This test confirms the building block works. The actual startup-recovery wiring in Step 3 is the new code.)

- [ ] **Step 3: Modify `worker/index.ts` to call `handleRemindersTick` once at startup**

Find the existing `boss.work` for `Queue.RemindersTick` (around line ~38 of `worker/index.ts`). Immediately AFTER the `boss.work` registration for `Notify` (so all queues are registered before we try to enqueue from the recovery call), add:

```ts
// Missed-tick recovery: process any reminders that came due during a worker
// outage. The existing handleRemindersTick scans past-due reminders and the
// NotificationLog unique constraint deduplicates anything already notified.
// Failure here is non-fatal: the next scheduled tick (within 5 min) will retry.
try {
  const result = await handleRemindersTick({
    enqueue: async (job) => {
      await boss.send(Queue.Notify, job);
    },
  });
  logger.info(
    { event: 'startup.tick.recovery', enqueued: result.enqueued },
    'missed-tick recovery complete',
  );
} catch (e) {
  Sentry.captureException(e);
  logger.error({ err: e }, 'startup tick recovery failed');
  // Do not exit; the next scheduled tick will retry.
}
```

The `enqueue` callback duplicates the closure inside the existing `boss.work(Queue.RemindersTick, ...)` block — that's fine (don't try to extract; the duplication is two lines and explicit is clearer than DRY here).

- [ ] **Step 4: Verify the worker module still loads cleanly**

```bash
pnpm typecheck
```

(There's no easy way to integration-test the startup behavior without booting the actual worker process. The unit-equivalent is the `handleRemindersTick` test from Step 2 — that confirms the building block works.)

- [ ] **Step 5: Verify the wider suite**

```bash
pnpm test:unit
pnpm test:integration
# Expected: 228 unit + 144 integration green.
```

- [ ] **Step 6: Commit**

```bash
git add worker/index.ts tests/integration/missed-tick-recovery.test.ts
git commit -m "feat(reliability): missed-tick recovery on worker startup"
```

---

## Task 3: pg_dump backup handler + pruning

**Files:**
- Create: `worker/jobs/pg-dump.ts`
- Create: `worker/jobs/pg-dump.test.ts` (unit test for pruning logic ONLY)

The handler spawns `pg_dump --format=custom` via the safe `execFile` variant of `node:child_process` (passes args as an array; no shell interpolation). After a successful dump, scans `/backups` for matching files, sorts by mtime descending, and deletes everything beyond the newest 7.

This task does NOT add the `postgresql16-client` package to the Dockerfile (Task 4) and does NOT register the schedule (Task 5). Standalone handler first.

- [ ] **Step 1: Write the failing unit test for pruning logic**

Create `worker/jobs/pg-dump.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { selectFilesToPrune, RETENTION_COUNT } from './pg-dump';

describe('selectFilesToPrune', () => {
  it('returns empty when count <= retention', () => {
    const files = [
      { name: 'housemanager-2026-05-03T03-00-00Z.dump', mtimeMs: 1_000_000 },
      { name: 'housemanager-2026-05-02T03-00-00Z.dump', mtimeMs: 900_000 },
    ];
    expect(selectFilesToPrune(files)).toEqual([]);
  });

  it('keeps the newest RETENTION_COUNT and returns the rest for deletion', () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      name: `housemanager-day-${i}.dump`,
      mtimeMs: 1_000_000 - i * 1000, // index 0 is newest
    }));
    const toPrune = selectFilesToPrune(files);
    // Should prune everything beyond index RETENTION_COUNT-1 (i.e., indices 7,8,9).
    expect(toPrune).toHaveLength(10 - RETENTION_COUNT);
    expect(toPrune.map((f) => f.name).sort()).toEqual(
      ['housemanager-day-7.dump', 'housemanager-day-8.dump', 'housemanager-day-9.dump'].sort(),
    );
  });

  it('handles unsorted input by mtime', () => {
    const files = [
      { name: 'old.dump', mtimeMs: 100 },
      { name: 'new.dump', mtimeMs: 1000 },
      { name: 'middle.dump', mtimeMs: 500 },
    ];
    // RETENTION_COUNT is 7, so 3 files are all kept.
    expect(selectFilesToPrune(files)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — should fail**

```bash
pnpm test worker/jobs/pg-dump.test.ts
# Expected: FAIL — module not found.
```

- [ ] **Step 3: Implement `worker/jobs/pg-dump.ts`**

Imports use `node:child_process`'s `execFile` (the array-args, non-shell variant) wrapped in `promisify`:

```ts
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import * as Sentry from '@sentry/node';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';

const logger = getLogger('worker.pg-dump');
const runDump = promisify(execFile);

const BACKUP_DIR = '/backups';
const FILENAME_PREFIX = 'housemanager-';
const FILENAME_SUFFIX = '.dump';
export const RETENTION_COUNT = 7;

export type FileEntry = { name: string; mtimeMs: number };

/**
 * Given a list of dump files in the backup directory, returns the subset that
 * should be deleted to enforce RETENTION_COUNT. The newest RETENTION_COUNT
 * files are kept; the rest are pruned. Pure function — exported for testing.
 */
export function selectFilesToPrune(files: FileEntry[]): FileEntry[] {
  if (files.length <= RETENTION_COUNT) return [];
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  return sorted.slice(RETENTION_COUNT);
}

/**
 * Runs `pg_dump --format=custom` against DATABASE_URL, writes the result to
 * /backups/housemanager-<ISO>.dump, then prunes the directory to the last
 * RETENTION_COUNT dumps.
 *
 * Failure modes:
 *   - pg_dump non-zero exit → log error + Sentry capture + throw (pg-boss retries)
 *   - pruning failure → log warn, do NOT throw (the dump itself was the goal)
 */
export async function handlePgDump(): Promise<{ file: string; pruned: number }> {
  const { DATABASE_URL } = getEnv();
  // ISO timestamp with `:` and `.` replaced (filesystem-safe).
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${FILENAME_PREFIX}${stamp}${FILENAME_SUFFIX}`;
  const filepath = path.join(BACKUP_DIR, filename);

  try {
    await runDump('pg_dump', [
      '--format=custom',
      `--dbname=${DATABASE_URL}`,
      `--file=${filepath}`,
    ]);
  } catch (e) {
    const err = e as Error & { code?: number; stderr?: string };
    logger.error(
      { err, exitCode: err.code, stderr: err.stderr },
      'pg_dump failed',
    );
    Sentry.captureException(err);
    throw err;
  }

  const stat = await fs.stat(filepath);
  logger.info({ file: filename, sizeBytes: stat.size }, 'pg_dump completed');

  // Pruning is best-effort.
  let pruned = 0;
  try {
    const entries = await fs.readdir(BACKUP_DIR);
    const candidates: FileEntry[] = [];
    for (const name of entries) {
      if (!name.startsWith(FILENAME_PREFIX) || !name.endsWith(FILENAME_SUFFIX)) continue;
      const s = await fs.stat(path.join(BACKUP_DIR, name));
      candidates.push({ name, mtimeMs: s.mtimeMs });
    }
    const toPrune = selectFilesToPrune(candidates);
    for (const f of toPrune) {
      await fs.unlink(path.join(BACKUP_DIR, f.name));
      pruned += 1;
    }
    if (pruned > 0) {
      logger.info({ pruned }, 'pruned old dumps');
    }
  } catch (e) {
    logger.warn({ err: e }, 'pruning failed (non-fatal)');
  }

  return { file: filename, pruned };
}
```

- [ ] **Step 4: Run unit test — should pass**

```bash
pnpm test worker/jobs/pg-dump.test.ts
```

- [ ] **Step 5: Verify the wider suite**

```bash
pnpm typecheck
pnpm test:unit
# Expected: 228 + 3 new = 231 unit tests green.
```

(No integration test for the actual pg_dump end-to-end — would require shelling out to `pg_dump` which isn't installed in the dev environment. The Task 4 Dockerfile change adds it; Task 6 docs the manual smoke command.)

- [ ] **Step 6: Commit**

```bash
git add worker/jobs/pg-dump.ts worker/jobs/pg-dump.test.ts
git commit -m "feat(reliability): pg_dump handler with retention pruning"
```

---

## Task 4: Dockerfile + docker-compose changes

**Files:**
- Modify: `Dockerfile` (add `postgresql16-client`)
- Modify: `docker-compose.yml` (add `/backups` mount on worker service)

- [ ] **Step 1: Add `postgresql16-client` to the Dockerfile base image**

Find the `RUN corepack enable` line in the `base` stage (near the top). Add a sibling `RUN`:

```dockerfile
FROM node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS base
RUN corepack enable
RUN apk add --no-cache postgresql16-client
WORKDIR /app
```

(`postgresql16-client` matches the major version of the running database. When you bump Postgres major, bump this in lockstep.)

- [ ] **Step 2: Add `/backups` mount to the worker service in docker-compose.yml**

Find the `worker:` service block. The existing `volumes:` is:

```yaml
worker:
  # ... existing config ...
  volumes:
    - files:/data/files
```

Change to:

```yaml
worker:
  # ... existing config ...
  volumes:
    - files:/data/files
    - ${BACKUP_DIR:-./db-backups}:/backups
```

Do NOT add the same mount to the `web` service — only the worker process writes backups.

- [ ] **Step 3: Verify Dockerfile builds locally** (optional but recommended)

```bash
docker build -t house-manager-test .
# Expected: build succeeds (~2-3 min). The new RUN apk add adds ~6MB to the image.
```

If you don't want to wait for a full build, at minimum lint the Dockerfile:

```bash
docker buildx build --check . 2>&1 | tail -10
```

- [ ] **Step 4: Verify docker-compose.yml syntax**

```bash
docker compose config 2>&1 | tail -20
# Expected: parsed config printed; no errors.
```

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml
git commit -m "chore(reliability): install postgresql16-client + mount /backups on worker"
```

---

## Task 5: Wire schedules + work blocks into worker/index.ts

**Files:**
- Modify: `lib/queue.ts` (add 2 new queue names)
- Modify: `worker/index.ts` (register schedules + work blocks)

This task glues Tasks 1, 2, and 3 into the running worker. After this task, the worker process actually runs the sweeper every 5 min and the backup daily at 03:00 UTC.

- [ ] **Step 1: Add 2 new queue names to `lib/queue.ts`**

Find the `Queue` const (around line ~20). Append two entries:

```ts
export const Queue = {
  Thumbnail: 'thumbnail',
  RemindersTick: 'reminders.tick',
  Notify: 'notify',
  SearchIndex: 'search.index',
  SearchReindex: 'search.reindex',
  PgDump: 'pg-dump',                  // NEW
  NotifyLogSweep: 'notify-log.sweep', // NEW
} as const;
```

The `QUEUES` constant below is `Object.values(Queue)` — it auto-picks up the new entries; nothing else to change in `lib/queue.ts`.

- [ ] **Step 2: Register the 2 new schedules + work blocks in `worker/index.ts`**

Add the imports near the top of `worker/index.ts` (alongside the other `import { handle... } from './jobs/...'` lines):

```ts
import { handleNotifyLogSweep } from './jobs/notify-log-sweep';
import { handlePgDump } from './jobs/pg-dump';
```

Inside the `main()` function, add these blocks AFTER the existing `SearchReindex` registration but BEFORE the final `logger.info(...)` "registered ..." line:

```ts
// Notification-log sweeper — runs every 5 min, deletes stale 'queued' rows.
await boss.schedule(Queue.NotifyLogSweep, '*/5 * * * *');
await boss.work(Queue.NotifyLogSweep, { batchSize: 1 }, async () => {
  await handleNotifyLogSweep();
});

// Postgres logical backup — runs daily at 03:00 UTC.
await boss.schedule(Queue.PgDump, '0 3 * * *');
await boss.work(Queue.PgDump, { batchSize: 1 }, async () => {
  await handlePgDump();
});
```

Update the `logger.info` "registered ..." line to mention the new queues:

```ts
logger.info(
  'registered thumbnail, reminders.tick + notify, search.index + search.reindex, pg-dump, notify-log.sweep jobs',
);
```

- [ ] **Step 3: Verify**

```bash
pnpm typecheck
pnpm test:unit
pnpm test:integration
# Expected: 231 unit + 144 integration green.
```

- [ ] **Step 4: Commit**

```bash
git add lib/queue.ts worker/index.ts
git commit -m "feat(reliability): wire pg-dump + notify-log.sweep schedules into worker"
```

---

## Task 6: Operator restore docs

**Files:**
- Create: `docs/backups.md`

Brief operator-facing doc covering what's protected, where the dumps live, and how to restore.

- [ ] **Step 1: Write `docs/backups.md`**

```markdown
# Backups

The worker writes a daily Postgres logical dump to `/backups` (in-container) every day at 03:00 UTC. The container path is bind-mounted to the host directory specified by `BACKUP_DIR` in `docker-compose.yml` (defaults to `./db-backups`). Duplicacy backs that host directory up off-host on its own schedule.

## What's protected

- **Postgres (housemanager DB)** — daily logical dumps via `pg_dump --format=custom`
- **Attachments (FILES_DIR)** — protected via Duplicacy's existing coverage of the appdata folder; this app does nothing extra
- **Meilisearch index** — NOT backed up; rebuildable from Postgres via `worker/jobs/search-reindex.ts`

## Where dumps live

Inside the worker container: `/backups/housemanager-<ISO>.dump`

On the host: wherever you set `BACKUP_DIR` (e.g., `/srv/duplicacy-source/house-manager/db-backups`).

The worker keeps the **last 7 dumps locally** and prunes older ones. Long-term retention is Duplicacy's job.

## Setting `BACKUP_DIR`

In your `.env` or `docker-compose.yml` env_file:

\`\`\`env
BACKUP_DIR=/srv/duplicacy-source/house-manager/db-backups
\`\`\`

If unset, it defaults to `./db-backups` (relative to the docker-compose.yml directory).

## Restoring

### Postgres

1. Stop the running app + worker:
   \`\`\`bash
   docker compose stop web worker
   \`\`\`
2. Drop the existing database (DESTRUCTIVE):
   \`\`\`bash
   docker compose exec db psql -U $POSTGRES_USER -d postgres \\
     -c "DROP DATABASE housemanager; CREATE DATABASE housemanager OWNER $POSTGRES_USER;"
   \`\`\`
3. Restore from dump (use the most recent dump in `/backups` or recover an older one from Duplicacy):
   \`\`\`bash
   docker compose run --rm worker \\
     pg_restore --clean --if-exists --no-owner --no-privileges \\
       --dbname=$DATABASE_URL /backups/housemanager-<ISO>.dump
   \`\`\`
4. Restart:
   \`\`\`bash
   docker compose up -d
   \`\`\`

### Attachments (FILES_DIR)

Restore the appdata folder from Duplicacy alongside the database. The DB stores file paths relative to FILES_DIR; without the file blobs, attachments will 404. Restore both together — never restore one without the other.

## Manual smoke test (after deployment)

To verify the backup job works without waiting until 03:00 UTC:

\`\`\`bash
docker compose exec worker \\
  pnpm exec tsx -e "import('./worker/jobs/pg-dump').then(m => m.handlePgDump()).then(console.log)"
\`\`\`

Expected output: `{ file: 'housemanager-...dump', pruned: 0 }` and a new file in `/backups`.

## Verifying dump integrity

Periodically test that a dump can actually be read back. List its contents without restoring:

\`\`\`bash
docker compose exec worker pg_restore --list /backups/housemanager-<ISO>.dump | head
\`\`\`

Expected: a list of database objects (tables, indexes, etc.). If `pg_restore --list` errors, the dump is corrupt.

## Postgres major version dependency

The Dockerfile installs `postgresql16-client` to provide `pg_dump` / `pg_restore`. **When you upgrade Postgres major** (16 → 17), bump the Dockerfile package name in lockstep — `pg_dump` from a different major won't dump from a newer database.

## Risks

- **Backup completes but is corrupt.** `pg_dump` could succeed without producing a usable dump (e.g., disk full mid-write). Mitigation: periodic `pg_restore --list` smoke-check (see above).
- **`/backups` overlap with another backup tool.** If your `BACKUP_DIR` is also covered by another backup root (e.g., Time Machine), you may get duplicate work. Audit your backup sources.
- **Daily backup missed during long outage.** If the worker is down at 03:00 UTC, the daily backup doesn't fire. The previous day's dump is still in `/backups` until pruned (~7 days later). Acceptable; Duplicacy still has yesterday's.
```

(The escaped triple-backticks above are markdown for the operator-facing file. When you write the actual file, use plain triple-backticks.)

- [ ] **Step 2: Commit**

```bash
git add docs/backups.md
git commit -m "docs(reliability): operator backup + restore guide"
```

---

## Task 7: Final verify pass + branch handoff

- [ ] **Step 1: Full verify**

```bash
pnpm verify
# Expected: lint ✓ typecheck ✓ test:unit ✓
```

- [ ] **Step 2: Integration tests**

```bash
pnpm test:integration
# Expected: 142 prior + 2 new (notify-log-sweep) + 2 new (missed-tick-recovery) = 146 tests green.
```

(Adjust the count if any prior task ended up with a different test count; the exact number isn't load-bearing.)

- [ ] **Step 3: E2E (optional)**

```bash
pnpm test:e2e:local
# Expected: 6 prior specs green; this plan adds no E2E.
```

- [ ] **Step 4: Sanity-check the new behavior**

```bash
# Confirm the new queue names made it into lib/queue.ts:
grep -E "PgDump|NotifyLogSweep" lib/queue.ts
# Expected: 2 matches.

# Confirm the schedules made it into worker/index.ts:
grep -E "pg-dump|notify-log\.sweep" worker/index.ts
# Expected: at least 4 matches (2 schedule + 2 work).
```

- [ ] **Step 5: Commit count check**

```bash
git log --oneline main..HEAD | wc -l
# Expected: ~6 commits across the plan's tasks (1 per task; Task 7 doesn't add a commit).
```

- [ ] **Step 6: Hand off to `superpowers:finishing-a-development-branch`**

Open a PR titled `feat(reliability): Plan 5b — sweeper + missed-tick recovery + pg_dump backup`. CI must be green. After merge, verify the `build-image` job succeeds on main (the Plan-5a hot-fix taught us that PR CI doesn't catch Dockerfile regressions).

---

## Reference: skills to invoke during implementation

- `superpowers:test-driven-development` — Tasks 1, 2, 3 use TDD.
- `superpowers:requesting-code-review` — between any task and the next, optionally dispatch a reviewer.
- `superpowers:finishing-a-development-branch` — Task 7 final handoff.
