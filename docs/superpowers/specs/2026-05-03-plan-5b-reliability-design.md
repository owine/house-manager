# Plan 5b — Reliability: notify-log sweeper + missed-tick recovery + Postgres dump

**Date:** 2026-05-03
**Status:** Draft for review
**Authors:** Oliver Wine (with Claude)
**Parent spec:** `docs/superpowers/specs/2026-04-26-house-manager-design.md`
**Builds on:** Plans 1, 2a, 2b, 2c, 3, 4a, 4ab, 4b, 5a — all shipped to main as of 2026-05-03.

## Overview

Plan 5b — the **Reliability** sub-plan of Plan 5. Closes three known fragile paths in the worker process:

1. **NotificationLog rows can get stuck in `'queued'`** if the worker hard-crashes between the INSERT (which establishes the dedupe primitive) and the channel send. The unique constraint then permanently blocks the next tick from re-attempting that cycle. Plan 5b adds a sweeper job that deletes stale `'queued'` rows after a 10-minute threshold so the next tick can retry.

2. **Worker downtime causes missed reminder ticks.** If the worker is down at the cron tick's scheduled fire time, pg-boss may not back-fill the missed schedule. The next normal tick eventually catches up (via the existing past-due scan), but reminders sit unhandled until then. Plan 5b adds a one-shot `handleRemindersTick` call during worker startup so missed cycles are processed immediately on recovery.

3. **No Postgres backups.** The `pgdata` named volume is covered by Duplicacy's file-level snapshots, but those snapshots catch a running database in physically inconsistent states (WAL mid-write). Logical backups via `pg_dump` are required. Plan 5b adds a daily pg-boss-scheduled job that writes timestamped `--format=custom` dumps to a bind-mounted `/backups` directory; Duplicacy handles the off-host transfer.

All three capabilities live inside the existing worker process — no new containers. The pg-boss job runner gains two new schedules; `worker/index.ts` gains one explicit startup call. The Dockerfile gains `postgresql16-client` (~6MB) so `pg_dump` is on PATH.

This is the second of four Plan 5 milestones. Plan 5a (Observability — Pino + Sentry) shipped at `1f915ae`. Plan 5c (UX polish — server-side autocomplete + type-aware metadata + a11y audit) and Plan 5d (Test infra — Meili opt-in + Anthropic E2E mock server) follow.

## Goals

1. Eliminate the "stuck-`'queued'` row blocks future cycles" failure mode for reminder notifications.
2. Eliminate the "reminder due during worker outage waits for next scheduled tick" gap.
3. Produce a daily Postgres logical backup that Duplicacy can transport off-host. App is responsible for the dump file landing in a known directory; Duplicacy is responsible for transport, dedup, and long-term retention.
4. Document the restore procedure in `docs/backups.md` so an operator can recover after data loss without reading code.
5. Stay within the existing worker process — no new long-running containers, no new dependencies beyond `postgresql16-client` in the Docker image.
6. Reuse Plan 5a's `getLogger` and `Sentry.captureException` for all observability — no new logging primitives.

## Non-goals

- **Streaming replication / point-in-time recovery (PITR).** Daily logical dumps are sufficient for solo self-host RPO; PITR is overkill for a household-scale dataset.
- **Encrypted dumps at rest.** Duplicacy handles encryption during off-host transport.
- **Backup of the Meilisearch index.** It can be rebuilt from Postgres via the existing `search-reindex` job. No separate backup needed.
- **Backup of the FILES_DIR (attachments) by this plan.** Duplicacy already covers it because it's part of the appdata folder. Plan 5b only documents the dependency in restore docs.
- **Operator-facing notifications when sweeper or backup fails.** Failures are logged via Pino and reported to Sentry (Plan 5a). Operator-facing notifications would be Plan 5e+ if we ever want them.
- **A separate "backup" container.** The `prodrigestivill/postgres-backup-local` sidecar option was considered and rejected during brainstorming — keeping backup orchestration inside the worker process keeps the container count low and reuses pg-boss's scheduling.
- **Configurable backup schedule via env.** The cron expression is hardcoded (`0 3 * * *`). If the user wants a different time, they can edit the worker code; YAGNI on env-driven scheduling.
- **Duplicate-notification protection in the sweeper.** A row stuck in `'queued'` is treated as "send did not succeed; retry"; in the rare case where the channel send actually completed before the crash, the user gets a duplicate notification on retry. Duplicate is annoying; missing is worse.
- **Pruning Sentry / log noise from the sweeper.** A sweep with 0 stale rows is silent at `info` level only when nothing was found; a sweep with > 5 deletions logs a `warn` because that suggests systemic issues. No alert escalation beyond Sentry's own grouping.

## Architecture

```
┌─ Worker startup (worker/index.ts) ─────────────────────────┐
│  1. Sentry.init  (existing — Plan 5a)                      │
│  2. boss.start()                                           │
│  3. ★ NEW: missed-tick recovery — handleRemindersTick()    │
│     fires once before normal job loop starts               │
│  4. Register all queues (existing)                         │
│  5. ★ NEW: schedule pg-dump (cron 0 3 * * *)               │
│  6. ★ NEW: schedule notification-log sweeper (cron */5)    │
│  7. boss.work loop (existing)                              │
└────────────────────────────────────────────────────────────┘

      ┌─ pg-boss recurring jobs ─────────────────┐
      │   reminders.tick     (existing, hourly)  │
      │   pg-dump            (NEW, daily 03:00)  │
      │   notify-log.sweep   (NEW, every 5 min)  │
      └──────────────────────────────────────────┘

      ┌─ /backups (bind-mount, host path arbitrary) ─┐
      │   housemanager-2026-05-04T03-00-00Z.dump     │
      │   housemanager-2026-05-03T03-00-00Z.dump     │
      │   ... (last 7 kept; older pruned by job)     │
      │   ↑ Duplicacy backs up this dir off-host     │
      └──────────────────────────────────────────────┘
```

Three changes to `worker/index.ts`:
1. After queue registration, before the worker enters its idle loop, call `handleRemindersTick({ enqueue })` once (wrapped in try/catch so failure doesn't crash the worker).
2. Schedule `pg-dump` via `boss.schedule('pg-dump', '0 3 * * *', {})`.
3. Schedule `notify-log.sweep` via `boss.schedule('notify-log.sweep', '*/5 * * * *', {})`.

Two new job handler files:
- `worker/jobs/notify-log-sweep.ts` — handles the sweeper job
- `worker/jobs/pg-dump.ts` — handles the backup job

One Dockerfile addition: `apk add --no-cache postgresql16-client`.

One docker-compose addition: `${BACKUP_DIR:-./db-backups}:/backups` volume mount on the worker service.

One new docs file: `docs/backups.md`.

## Components

### `worker/jobs/notify-log-sweep.ts` (new)

Single exported handler:

```ts
export async function handleNotifyLogSweep(): Promise<{ deleted: number }>;
```

Implementation:

```ts
import { prisma } from '@/lib/db';
import { getLogger } from '@/lib/logger';

const logger = getLogger('worker.notify-log-sweep');
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export async function handleNotifyLogSweep(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const result = await prisma.notificationLog.deleteMany({
    where: {
      status: 'queued',
      sentAt: { lt: cutoff },
    },
  });

  if (result.count > 0) {
    const level = result.count > 5 ? 'warn' : 'info';
    logger[level]({ deleted: result.count }, 'swept stale notification logs');
  }

  return { deleted: result.count };
}
```

**Tradeoff acknowledgement:** if the channel send actually succeeded but the worker crashed before updating `status='sent'`, deleting the row causes a duplicate notification on the next tick. Acceptable; the alternative (never retry) silently misses reminders.

### `worker/jobs/pg-dump.ts` (new)

Single exported handler:

```ts
export async function handlePgDump(): Promise<{ file: string; pruned: number }>;
```

Implementation outline:

1. Compute filename: `housemanager-${new Date().toISOString().replace(/[:.]/g, '-')}.dump` (e.g., `housemanager-2026-05-04T03-00-00-000Z.dump`).
2. Spawn `pg_dump` via `child_process.execFile` (the safe non-shell variant — passes args as an array, no shell interpolation): args = `['--format=custom', '--dbname=' + getEnv().DATABASE_URL, '--file=/backups/' + filename]`.
3. On non-zero exit: `logger.error({stderr, exitCode}, 'pg_dump failed')`, `Sentry.captureException(new Error('pg_dump exited ' + exitCode))`, throw so pg-boss marks the job failed.
4. On success: scan `/backups` for files matching `/^housemanager-.+\.dump$/`, sort by `mtimeMs` descending, take entries beyond index 7, `fs.unlink` each. Track deleted count.
5. Log success: `logger.info({file, sizeBytes, pruned}, 'pg_dump completed')`.

**Use the env's `DATABASE_URL` directly** — same connection string the rest of the worker uses. The worker container can already reach the `db` service; no network gymnastics.

**Why `child_process.execFile` and not the shell variant:** `execFile` passes the args array directly to the spawned process without shell interpretation. The `--file=` and `--dbname=` arg values are application-controlled (filename is a derived ISO timestamp; DATABASE_URL is from the validated env), but using the shell-free variant prevents shell-injection bugs from creeping in if those inputs ever broaden.

### `worker/index.ts` (modified)

Three additions:

```ts
// After existing boss.work registrations, before the worker enters its idle loop:

// 1. Missed-tick recovery — process any reminders that came due during a worker outage.
//    The existing handleRemindersTick scans past-due reminders and the NotificationLog
//    unique constraint deduplicates anything already notified. Failure here is non-fatal:
//    the next scheduled tick (within an hour) will recover.
try {
  const result = await handleRemindersTick({ enqueue: enqueueNotify });
  logger.info({ event: 'startup.tick.recovery', enqueued: result.enqueued }, 'missed-tick recovery complete');
} catch (e) {
  Sentry.captureException(e);
  logger.error({ err: e }, 'startup tick recovery failed');
  // Do not exit; the next scheduled tick will retry.
}

// 2. Schedule pg-dump daily at 03:00 UTC.
await boss.schedule('pg-dump', '0 3 * * *');

// 3. Schedule notify-log sweeper every 5 minutes.
await boss.schedule('notify-log.sweep', '*/5 * * * *');
```

(`enqueueNotify` is the existing closure that wraps `boss.send(Queue.Notify, payload)` — extract it from the existing `reminders.tick` schedule wiring or hand-roll a thin wrapper.)

### Dockerfile (modified)

Add to the base alpine image (line near `RUN corepack enable`):

```dockerfile
RUN apk add --no-cache postgresql16-client
```

`postgresql16-client` matches the major version of the running database (currently Postgres 16 per `docker-compose.yml`). When you bump Postgres major, bump this in lockstep. The package adds ~6MB to the image; acceptable.

### docker-compose.yml (modified)

Add to the `worker` service's `volumes:` block (web service does NOT need it):

```yaml
worker:
  volumes:
    - files:/data/files
    - ${BACKUP_DIR:-./db-backups}:/backups   # NEW
```

`BACKUP_DIR` is a host-side path. Default `./db-backups` is relative to the compose file so a fresh `docker compose up` works without env config. Operator sets `BACKUP_DIR=/srv/duplicacy-source/house-manager` (or whatever fits their existing Duplicacy layout) in `.env` to point at their actual backup root.

### docs/backups.md (new)

~50-line operator doc covering:
- What's protected: Postgres logical dumps + attachments dir (FILES_DIR via Duplicacy)
- Where dumps live: `/backups` inside worker container; bind-mounted to `BACKUP_DIR` on host; Duplicacy off-hosts them
- Retention: 7 local dumps kept; Duplicacy's policy handles long-term
- Restore commands (DB + attachments)
- Manual smoke-test command for verifying pg_dump works after deployment

## Data flow

**Notification sweeper (every 5 min):**

1. pg-boss fires `notify-log.sweep` job
2. `handleNotifyLogSweep` runs `DELETE FROM notification_logs WHERE status = 'queued' AND sentAt < (now - 10min)`
3. If any rows deleted, log at `info` (or `warn` if > 5)
4. Returns `{deleted: N}` (pg-boss records job result)

**Missed-tick recovery (worker startup):**

1. Worker starts; Sentry inits; queues register
2. `handleRemindersTick` fires once with the same `enqueue` callback the cron schedule uses
3. The function scans active reminders with `nextDueOn <= now + maxLead`, computes `notifyAt`, skips not-yet-due, and enqueues notify jobs for the rest
4. The `NotificationLog` unique constraint prevents double-firing for cycles already notified during the outage

**Postgres dump (daily 03:00 UTC):**

1. pg-boss fires `pg-dump` job
2. `handlePgDump` runs `pg_dump --format=custom --dbname=$DATABASE_URL --file=/backups/housemanager-<ISO>.dump` via the shell-free `child_process.execFile`
3. On non-zero exit, log error + Sentry capture + throw (pg-boss retries per its default policy; eventual permanent failure surfaces in Sentry)
4. On success, scan `/backups`, prune to the newest 7 dumps
5. Duplicacy's own scheduled run (independent of this app) detects the new file and ships it off-host

## Error handling

| Failure | Behavior |
|---|---|
| `notify-log.sweep` job throws | pg-boss retries per default policy; if it keeps failing, surfaces via Sentry |
| `pg_dump` exits non-zero | `logger.error` with stderr + exit code; `Sentry.captureException`; throw → pg-boss retry → eventual permanent failure visible in Sentry |
| `pg_dump` succeeds but pruning fails | Log `warn` with err; do NOT throw (the dump itself was the goal; pruning is best-effort cleanup); next day's run prunes |
| Missed-tick recovery throws | Logged at `error` + Sentry; worker keeps running; next scheduled tick recovers |
| `/backups` is read-only or missing | First `pg_dump` invocation fails; surfaces to Sentry; operator fixes the mount |
| Stale `'queued'` row that actually corresponds to a successful send | Sweeper deletes; next tick re-enqueues; user gets duplicate notification (acceptable tradeoff) |
| Worker dies during `pg_dump` | Partial dump file remains in `/backups`; next day's job overwrites with a fresh attempt; pruning eventually deletes the partial. Acceptable for daily-cadence backup |

## Testing strategy

| Test | What it covers |
|---|---|
| `tests/integration/notify-log-sweep.test.ts` (new) | Seed 3 NotificationLog rows: stale-queued, fresh-queued, sent. Call `handleNotifyLogSweep`. Assert only the stale-queued row is deleted; assert returned `{deleted: 1}`. |
| `tests/integration/missed-tick-recovery.test.ts` (new) | Seed a reminder with `nextDueOn` 2 hours past, no NotificationLog row. Call `handleRemindersTick({ enqueue })` directly with a captured-call enqueue stub. Assert the stub was called with the expected payload. |
| `worker/jobs/pg-dump.test.ts` (new — unit, NOT integration) | Test the pruning helper in isolation: give a fake list of `{filename, mtimeMs}` entries, assert which subset would be deleted for retention=7. Don't test the dump binary itself; trust it. |
| Manual smoke test for `pg_dump` end-to-end | Documented in `docs/backups.md`: `docker compose run --rm worker pnpm exec tsx -e "import('./worker/jobs/pg-dump').then(m => m.handlePgDump())"` should produce a dump file in `/backups`. |

Existing 226 unit + 142 integration tests must stay green.

## Operational surface

**New env var (one):**

| Var | Purpose | Default |
|---|---|---|
| `BACKUP_DIR` | Host path bind-mounted to `/backups` in the worker container. The operator sets this to whatever Duplicacy's source includes. | `./db-backups` (relative to docker-compose.yml) |

`BACKUP_DIR` is consumed only by `docker-compose.yml` (variable substitution in the volume mount). It does NOT need adding to `lib/env.ts` because the application code never reads it — only `pg_dump`'s `--file=` arg uses the in-container path `/backups`, which is invariant.

**Files that change:**

| File | Change |
|---|---|
| `Dockerfile` | Add `RUN apk add --no-cache postgresql16-client` to base image |
| `docker-compose.yml` | Add `${BACKUP_DIR:-./db-backups}:/backups` to worker service volumes |
| `worker/index.ts` | Add startup tick recovery + 2 schedule registrations + 2 boss.work registrations for new queues |
| `worker/jobs/notify-log-sweep.ts` | New — sweeper handler |
| `worker/jobs/pg-dump.ts` | New — backup handler + pruning logic |
| `worker/jobs/pg-dump.test.ts` | New — unit test for pruning helper |
| `tests/integration/notify-log-sweep.test.ts` | New — integration test for sweeper |
| `tests/integration/missed-tick-recovery.test.ts` | New — integration test for startup recovery |
| `docs/backups.md` | New — operator restore doc |

## Risks and open questions

1. **`pg_dump` version drift.** `postgresql16-client` is locked to major 16; if you bump Postgres major (16 → 17), the client must follow or `pg_dump` will fail on newer features. Mitigation: docs/backups.md notes the Postgres major version dependency; Renovate flags Dockerfile changes.

2. **Backup completes but is corrupt.** `pg_dump` could succeed without producing a usable dump (e.g., disk fills mid-write, network partition between worker and db). Mitigation: include a "test the restore" reminder in docs/backups.md — operator should periodically `pg_restore --list` a recent dump to verify integrity. Out of scope to automate.

3. **`/backups` accidentally backed up by Duplicacy AND backed up by something else.** If the `BACKUP_DIR` host path overlaps two backup source roots, you get duplicate work. Mitigation: docs/backups.md notes this trap explicitly.

4. **Sweeper race with notify-handler.** Two windows: (a) sweeper deletes a row at the exact moment notify-handler is mid-send → no harm, the channel send completes, status update fails because row is gone (silent). Acceptable. (b) sweeper races with the next tick's INSERT — unique constraint protects against duplicate INSERTs; one wins, one fails harmlessly. Acceptable.

5. **`pg-dump` job missed during long worker outage.** If the worker is down at 03:00 UTC, the daily backup doesn't fire. pg-boss's scheduling for missed runs is version-dependent. Mitigation: Plan 5b's missed-tick recovery only covers reminder ticks, not all schedules — but missing one daily backup is acceptable; Duplicacy still has yesterday's backup. If desired, a follow-up could add backup recovery on startup; YAGNI for now.

6. **Lock-in to pg-boss for backup scheduling.** If pg-boss is ever swapped out (e.g., for native Postgres LISTEN/NOTIFY or a different queue), the backup schedule moves with it. Acceptable; pg-boss is well-established in this codebase.

7. **`postgresql16-client` adds ~6MB to every image build.** Worth it; backup is a hard requirement. Image stays under conventional size budgets.

8. **The 10-min staleness threshold.** A real-world `notify` job that happens to hit a slow channel adapter (e.g., ForwardEmail timeout pushing to 30+ seconds) is well within 10 min. If a single notify attempt ever exceeds 10 min, the sweeper would delete an in-flight row mid-send, causing potential duplicates. Mitigation: rely on pg-boss's job timeout (default 60 seconds for non-batch jobs); jobs exceeding their timeout get retried by pg-boss and the original is abandoned, so the sweeper's deletion just cleans up the abandoned row.

## Acceptance criteria

- [ ] `worker/jobs/notify-log-sweep.ts` exports `handleNotifyLogSweep` that deletes `'queued'` rows with `sentAt < now - 10min`; returns `{deleted: N}`.
- [ ] `worker/jobs/pg-dump.ts` exports `handlePgDump` that spawns `pg_dump --format=custom` via `child_process.execFile`, writes to `/backups/housemanager-<ISO>.dump`, prunes to last 7, returns `{file, pruned}`.
- [ ] `worker/index.ts` calls `handleRemindersTick` once on startup (try/catch wrapped); schedules `pg-dump` daily at 03:00 UTC; schedules `notify-log.sweep` every 5 minutes.
- [ ] `Dockerfile` installs `postgresql16-client` in the base image.
- [ ] `docker-compose.yml` adds `${BACKUP_DIR:-./db-backups}:/backups` to the worker service.
- [ ] `docs/backups.md` documents what's protected, restore commands, manual smoke test, and the Postgres-major version dependency.
- [ ] New tests:
  - integration: notify-log sweeper (3 rows, only stale-queued deleted)
  - integration: missed-tick recovery (past-due reminder enqueues on startup)
  - unit: pg-dump pruning logic (with a fake file list)
- [ ] `pnpm verify` clean.
- [ ] Existing 226 unit + 142 integration tests stay green.
- [ ] Worker starts cleanly with both new schedules registered (manual smoke).
