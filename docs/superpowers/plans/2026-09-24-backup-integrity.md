# Backup Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the nightly Postgres backup trustworthy end to end. Today a failed dump can silently prune every good one (O-M4), nobody would notice (O-H1), and the restore runbook fails at step 2 (D-H2, O-L5). After this PR: a failed dump never leaves a file or deletes one, success is reported to a dead-man monitor, the runbook is correct and copy-pasteable, and CI proves a real dump restores with every hand-written constraint and index intact (T-M7). Also: stop dumps from landing in a public repo's working tree and Docker build context (O-M5).

**Architecture:** `handlePgDump` (`worker/jobs/pg-dump.ts`) becomes dump → validate → atomic rename. `pg_dump` writes a hidden `.housemanager-<ISO>.dump.partial`; the job requires it to be non-empty and `pg_restore --list` to read it and find `TABLE DATA`; only then does `fs.rename` give it its final name. On any failure the temp file is removed and the job throws **before** pruning or pinging. Retention counts only non-empty `housemanager-*.dump` files. On success the job logs `sizeBytes`/`durationMs` and GETs an optional `BACKUP_HEARTBEAT_URL` (uptime-kuma Push monitor), fail-soft with `AbortSignal.timeout`. The runner, `fetch`, backup directory and timeout are injectable through an optional `overrides` argument, so unit tests use a real temp dir with a fake `pg_dump`, and a new integration test runs the real job with real host binaries against Testcontainers, then restores into a second container. The runbook uses plain `docker exec` into the DB container: no `docker compose run`, no secrets, and the old database is renamed aside rather than dropped.

**Tech Stack:** TypeScript 7, Node 24 (`node:child_process`, `node:fs`, global `fetch`), pg-boss 12 worker under tsx, Postgres 18 + pgvector (`pg_dump`/`pg_restore` 18), Zod, Vitest 5.0.1 + Testcontainers 12, `pg` 8, bash (`scripts/smoke-image.sh`), uptime-kuma 2.5 Push monitors.

**Source findings:** `.full-review/05-final-report.md` (P0 "Backups can fail silently…"), `.full-review/04b-cicd-devops.md` (O-H1 backup slice, O-M4, O-M5, O-L5), `.full-review/03b-documentation.md` (DOC-H2), `.full-review/03a-testing.md` (M7 = T-M7).

---

## Background the implementer needs

**Findings verified against the code (2026-09-24, `main` @ `b7b1bbf`):**
- **O-M4 is correct, and slightly understated.** Reproduced again with host `pg_dump` 18.6 against an unreachable host: exit 1, and a 0-byte `--file` is left behind (pg_dump opens its output before connecting). `handlePgDump` writes straight to the final name (`worker/jobs/pg-dump.ts:72-80`), and the pruner keeps the newest 7 name matches by mtime with no size check (`:96-107`). The queue has no policy, so each failing night makes 3 attempts and leaves 3 empty files (`lib/queue.ts:32-34`). **Two** bad nights (6 empties), not three, are enough for the next success to leave exactly one real dump.
- **O-M5 is correct.** `git check-ignore -v db-backups/housemanager-x.dump` exits 1, and `gh api repos/owine/house-manager -q .visibility` returns `public`. `./db-backups` exists locally and is empty. `.dockerignore` doesn't list it either, and the Dockerfile does `COPY . .` (`Dockerfile:27`).
- **DOC-H2 is correct on all four points** (multi-statement `psql -c` with `DROP DATABASE`; host-shell expansion; `compose run` starting web through `depends_on: web: service_healthy`, which is `docker-compose.yml:126-127` and also in prod; no pnpm in the image). **Its recommended fix is incomplete for production.** Prod's `DATABASE_URL` is interpolated from `${HOUSEMANAGER_DB_PASSWORD}` when compose parses the file (docker-piwine `housemanager/compose.yaml`), so any `docker compose run` on the prod host without the `op run` environment gets an empty password. It also drops the live database with no way back. This plan's runbook avoids compose entirely: `docker exec` into the DB container, which already has `POSTGRES_USER`/`POSTGRES_DB` and socket trust auth, and the old database is **renamed aside**.
- **O-L5 is correct.** `docs/backups.md:41` ("retry every ~2s") is false: the queue gets pg-boss defaults (2 immediate retries), and missed-tick recovery covers reminders only (`worker/index.ts:95-113`). `:107` ("kept until pruned ~7 days later") is false under O-M4.
- **T-M7 is correct.** `handlePgDump` never runs in a test. **Additional finding:** `tests/integration/migration-invariants.test.ts` checks only 6 CHECKs and 4 NULLS NOT DISTINCT indexes. It omits `Attachment_file_metadata_required`, `Attachment_storage_xor_link`, `IncomingEmailTarget_parent_xor`, the `incoming_email_targets…_key` NULLS NOT DISTINCT index and the IVFFlat index. The new round-trip test asserts all of them, on the source DB as well as the restored one.
- **Tooling in the image (checked, not assumed).** `postgresql18-client=18.6-r0` (`Dockerfile:105-107`) provides `pg_dump`, `pg_restore`, `psql`, `createdb`. In the local `house-manager:dev` image, `which` finds all four in `/usr/bin`. The image runs as uid 0, has no pnpm, and `node_modules/.bin/tsx -e "import('./worker/jobs/pg-dump')…"` from `/app` loads the module. That last point makes DOC-H2's smoke command valid.
- **Prod topology (docker-piwine `housemanager/compose.yaml`, read-only).** Services and container names are `housemanager-web`, `housemanager-worker`, `housemanager-postgres`, and `housemanager-meili`. The worker mounts `${APPDATA_PATH}/config/housemanager/backups:/backups`. Postgres runs as `user: ${UID}:${GID}` with `POSTGRES_USER`/`POSTGRES_DB` = `housemanager`. No service has `SENTRY_DSN` or any `env_file`. Uptime-kuma 2.5.5 is on the same `dockge_default` network as `uptime-kuma:3001`.

**How the code below was checked.** Every code block was type-checked with the repo's `tsc` (TS 7) and formatted and linted with the repo's Biome config. The tests were run against `main` @ `b7b1bbf` in a scratch harness that aliased only the changed files:
- The unit suite passes 22/22. Against the current `pg-dump.ts`, 15 fail, as Task 3 Step 2 describes.
- The env test passes 9/9.
- The integration round-trip passes 7/7 against real Testcontainers in about 9s. It was run twice, and pg-boss start → `createQueue` → stop included.
- Mutating the restore to `--section=pre-data` fails 4 of the 7.
- Putting `err.message` back into the heartbeat log fails the no-secrets test, and letting the current dump be pruned fails the clock-step test.
- Every `sh -c '…'` line in the runbook was expanded through a stubbed `psql`. `POSTGRES_USER`, `POSTGRES_DB` and `PGDATA` expand inside the container, and the SQL identifiers arrive double-quoted.
- The smoke-script insertion passes `bash -n` and `shellcheck`, but was **not** run against a built image.

**Design decisions (double-check these):**
1. **Validation = non-empty + `pg_restore --list` exits 0 + the listing contains ` TABLE DATA `.** The last check is beyond the brief. It rejects a dump of an empty database (for example a wrong `DATABASE_URL` database), which would otherwise pass as a "backup". `--list` reads the header and TOC, not every data block. The atomic rename already covers truncation, and the CI round-trip covers restorability.
2. **Legacy 0-byte `housemanager-*.dump` files are deleted, not just ignored.** They carry no data. Left alone, they would sit in `/backups` (and in Duplicacy) forever, because they are never retention candidates. This self-heals any prod directory the old job already polluted.
3. **Stale `.partial` threshold = 24h.** A partial from a killed run is removed by the next *successful* run once it is a day old. It can never be a run in flight: the job is daily and pg-boss expires an attempt after 15 min.
4. **Heartbeat is a verbatim GET, 10s timeout, non-2xx counts as failure (logged with `status` only).** No `msg`/`ping` query rewriting, so the job works with any push-style monitor (uptime-kuma, healthchecks.io). **Nothing that can contain the URL is ever logged.** undici puts the request URL in some error messages, and `httpUrlSchema` accepts `user:pass@`, so on a thrown error the job logs only `err.name` and `err.cause?.code` (e.g. `ECONNREFUSED`), never `err.message`. A unit test feeds it an error whose message and cause both embed a credentialed URL, and asserts no part of it reaches any log call. The env var is validated with `httpUrlSchema` (http/https only) inside `optionalEnv`, so an empty string means unset.
4a. **Tonight's dump is never a prune candidate.** Retention sorts by mtime, so a clock that stepped backwards (NTP correction, a host restored from a snapshot) would make the fresh dump the "oldest" and delete it. `pruneBackupDir` skips the current filename, and the remaining dumps are cut to `RETENTION_COUNT - 1`, which keeps the total at 7. `selectFilesToPrune` gained an optional `keep` parameter (default `RETENTION_COUNT`), and its existing tests are unchanged.
5. **Integration test uses host `pg_dump`/`pg_restore`, not `docker exec` into the container.** It is the code path production runs (`execFile` on PATH, `PGPASSWORD`, a TCP URL built by `buildDumpInvocation`), with no test-only seam. Running the tools inside the container would need either argv rewriting (different host and port) or a bind mount whose ownership differs on Linux CI (uid 999 writing into a runner-owned 0700 `mkdtemp`). Availability was checked: the `ubuntu-26.04` runner image ships **PostgreSQL 18.6** (actions/runner-images `Ubuntu2604-Readme.md`, "PostgreSQL service is disabled by default", and the client binaries are on PATH), and this Mac has Homebrew `pg_dump (PostgreSQL) 18.6`. A preflight compares the client major against `SHOW server_version_num` and **fails** (not skips) with an install hint. A pg19 bump of the test image will then fail legibly, not with "server version mismatch".
5a. **The round-trip includes pg-boss's schema.** Before the dump, the test starts a real `PgBoss` against the source, creates a test-only queue and stops it (in `finally`, so no instance outlives the hook). It then asserts the `pgboss` tables and that queue survive the restore. That adds about 1s. It matters because the dump carries pg-boss's jobs and cron schedules, and the runbook relies on that.
6. **The restore feeds the dump on stdin** (`docker exec -i … < "$DUMP"`), so the runbook never copies files into containers or worries about the prod DB container's non-root uid. The integration test restores the same way (`execFileSync(..., { input })`) with the runbook's exact flags. That proves a custom-format archive restores from a non-seekable pipe.
7. **Restore flags:** `--no-owner --no-privileges --exit-on-error --single-transaction`. A failed restore rolls back completely, and the runbook's "if it fails" path puts the renamed database back.
8. **`BACKUP_HEARTBEAT_URL` goes into the dev compose's shared `x-app-env` anchor** as `${BACKUP_HEARTBEAT_URL:-}`. Web receives it too and ignores it. That is simpler than splitting the anchor with a YAML merge key, and it matches how `VOYAGE_API_KEY` is passed.
9. **The image smoke test runs the real job inside the built image** against the smoke Postgres. This covers O-H1 item 4 (a `pg_dump --version` check) and more: major compatibility, `pg_restore` presence, and the documented manual smoke command.
10. **Out of scope** (separate PRs, listed at the end): Sentry DSN / Pino bridge, heartbeats for other jobs, a `pg-dump` retry-delay policy, a pre-migration dump (O-M1).

**Repo rules that apply to every task:**
- `pnpm`, never `npx`/`npm`. Run a single file with `pnpm exec vitest run <path>` (`pnpm test:unit`/`test:integration` *widen* when given a path).
- Never `--no-verify`. After **every** `git commit`, run `git log --oneline -1` and confirm HEAD moved: the Biome pre-commit hook can fail silently.
- Stage explicit paths only (`git add <paths>`), never `-A` or `.`.
- Run `pnpm lint:fix` before committing any file whose imports changed. Biome orders imports and specifiers, and the code below is already in Biome's order.
- **Vitest 5.0.1 defaults `clearMocks: true`** (checked in `node_modules/vitest/dist/chunks`): call counts reset between tests, so call and assert in the same `it`.
- **Integration tests must `vi.mock('@/lib/env')` with only the fields read.** An unmocked `getEnv()` passes locally (via `.env`, see `vitest.env.ts`) and fails in CI, which has no `.env`.
- Integration tests import the module under test *after* `setupIntegration()` (the `lib/db` module-load trap). `pg-dump.ts` doesn't import `lib/db`, but keep the pattern.
- **Worker imports must stay inside `lib/`, `worker/` or `prisma/`, and be production dependencies.** `pnpm lint:worker-graph` (part of `pnpm lint`) checks this. `worker/jobs/pg-dump.ts` gains no new package. `lib/env.ts` gains `./http-url` (zod only).
- **A new env var goes in three places:** `lib/env.ts`, `.env.example`, and the `docs/README.md` env table.
- Integration tests need Docker running. This PR needs no e2e: no UI changes, and the e2e harness leaks its worker.
- Don't use git worktrees in this repo (knip hangs on pre-push, and there is no `.env`). Work in the main checkout.
- `.full-review/` is excluded via `.git/info/exclude`, so it never shows in `git status`. Nothing there gets committed.

## File structure

| File | Responsibility |
|---|---|
| `.gitignore`, `.dockerignore` *(modify)* | Ignore `db-backups` (O-M5). |
| `lib/env.ts` *(modify)* | `BACKUP_HEARTBEAT_URL: optionalEnv(httpUrlSchema)`. |
| `tests/unit/env.test.ts` *(modify)* | Optional / empty-is-unset / http(s)-only. |
| `.env.example`, `docker-compose.yml`, `docs/README.md` *(modify)* | Document and pass the new var. README's docs index line is corrected too. |
| `worker/jobs/pg-dump.ts` *(rewrite)* | Temp file → validate → rename; prune only valid dumps and only after success; stale-partial cleanup; heartbeat; structured success log; injectable deps. |
| `worker/jobs/pg-dump.test.ts` *(rewrite; existing 6 tests kept verbatim)* | Orchestration tests in a real temp dir with a fake runner and fake `fetch`. |
| `Dockerfile` *(modify, comment only)* | Records that `pg_restore` is now load-bearing too. |
| `tests/integration/setup.ts` *(modify)* | Extract `startPostgres()` so a test can start a second, empty server. |
| `tests/integration/pg-dump-restore.test.ts` *(create)* | Real `handlePgDump` → real `pg_restore` into a fresh container; rows, CHECKs, indexes, `pgboss` schema + a probe queue, extension, migration state compared. |
| `docs/TESTING.md` *(modify)* | The host `pg_dump`/`pg_restore` ≥ 18 prerequisite. |
| `scripts/smoke-image.sh` *(modify)* | Run the backup job inside the built image. |
| `docs/backups.md` *(rewrite)* | Accurate behaviour, Monitoring section, working restore runbook, restore drill. |

`worker/index.ts` is **unchanged**. It calls `handlePgDump()` with no arguments and ignores the result, and both stay compatible.

---

### Task 0: Branch

- [ ] **Step 1: Start from a clean, current `main`**

```bash
git checkout main
git pull --ff-only
git status --short          # expect: empty
git checkout -b fix/backup-integrity
docker info >/dev/null && echo docker-ok      # Testcontainers needs the daemon
pg_dump --version && pg_restore --version     # expect: (PostgreSQL) 18.x or newer
```

If `pg_dump` is missing or older than 18 on this machine, install a PostgreSQL 18 client before Task 4 (macOS: `brew install libpq`, then put `$(brew --prefix libpq)/bin` on PATH, since libpq is keg-only).

---

### Task 1: O-M5 — keep dumps out of git and the Docker build context

**Files:**
- Modify: `.gitignore` (after line 12, `/data`)
- Modify: `.dockerignore` (after line 16, `data`)

- [ ] **Step 1: Confirm the gap**

```bash
git check-ignore -v db-backups/housemanager-x.dump; echo "exit=$?"
```

Expected: no output, `exit=1`.

- [ ] **Step 2: Add the entries**

In `.gitignore`, directly after the `/data` line:

```gitignore
/db-backups
```

In `.dockerignore`, directly after the `data` line (Docker anchors bare patterns to the context root, matching the file's own header comment):

```
db-backups
```

- [ ] **Step 3: Verify**

```bash
git check-ignore -v db-backups/housemanager-x.dump
```

Expected: `.gitignore:13:/db-backups` followed by the path. Any match is fine.

- [ ] **Step 4: Commit**

```bash
git add .gitignore .dockerignore
git commit -m "chore: ignore db-backups in git and the docker build context"
git log --oneline -1   # confirm HEAD moved
```

---

### Task 2: `BACKUP_HEARTBEAT_URL` env var

**Files:**
- Modify: `lib/env.ts` (import at line 1; new key after `APP_URL` at line 54)
- Test: `tests/unit/env.test.ts` (append one `it` inside the `describe`)
- Modify: `.env.example` (after line 46), `docker-compose.yml` (after line 26), `docs/README.md` (Optional table, after line 130; docs index line 245)

- [ ] **Step 1: Write the failing test**

Append inside the `describe('parseEnv', …)` block in `tests/unit/env.test.ts`, just before its final `});`:

```ts
  // BACKUP_HEARTBEAT_URL is the pg-dump dead-man ping. Optional like the rest,
  // but http(s) only: the worker fetch()es it, and a bare `.url()` would accept
  // `ftp:` or `javascript:` and only fail at 03:00.
  it('BACKUP_HEARTBEAT_URL: optional, empty is unset, http(s) only', () => {
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
    expect(parseEnv(baseValid).BACKUP_HEARTBEAT_URL).toBeUndefined();
    expect(
      parseEnv({ ...baseValid, BACKUP_HEARTBEAT_URL: '' }).BACKUP_HEARTBEAT_URL,
    ).toBeUndefined();
    const url = 'https://kuma.example.com/api/push/Ab12Cd34?status=up&msg=OK&ping=';
    expect(parseEnv({ ...baseValid, BACKUP_HEARTBEAT_URL: url }).BACKUP_HEARTBEAT_URL).toBe(url);
    expect(() =>
      parseEnv({ ...baseValid, BACKUP_HEARTBEAT_URL: 'ftp://kuma.example.com/x' }),
    ).toThrow();
    expect(() => parseEnv({ ...baseValid, BACKUP_HEARTBEAT_URL: 'not a url' })).toThrow();
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm exec vitest run tests/unit/env.test.ts
```

Expected: 1 failed, 8 passed. The new test fails at `expected undefined to be 'https://kuma.example.com/api/push/…'`, because `z.object` strips the unknown key.

- [ ] **Step 3: Implement**

In `lib/env.ts`, add the import under the zod import:

```ts
import { z } from 'zod';
import { httpUrlSchema } from './http-url';
```

and add the key directly after `APP_URL: optionalEnv(z.string().url()),`:

```ts
  // Dead-man switch for the nightly backup (worker/jobs/pg-dump.ts). The job
  // GETs this after every VALIDATED dump and never after a failure, so the
  // monitor behind it (an uptime-kuma Push monitor) goes red by silence rather
  // than by anything this process has to remember to send. Unset means no
  // ping. The URL carries the monitor's push token: never log it.
  BACKUP_HEARTBEAT_URL: optionalEnv(httpUrlSchema),
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm exec vitest run tests/unit/env.test.ts
```

Expected: 9 passed.

- [ ] **Step 5: Document and pass the var**

`.env.example`: directly after the `# APP_URL=…` line:

```env
# BACKUP_HEARTBEAT_URL=   # worker: GET after each validated nightly dump (uptime-kuma Push URL); see docs/backups.md § Monitoring
```

`docker-compose.yml`: directly after `  OCR_BACKEND: ${OCR_BACKEND:-tesseract}` in the `x-app-env` anchor:

```yaml
  # Dead-man ping for the nightly backup (docs/backups.md § Monitoring). Only
  # the worker reads it; empty means unset.
  BACKUP_HEARTBEAT_URL: ${BACKUP_HEARTBEAT_URL:-}
```

`docs/README.md`: in the `### Optional` table, add this row directly after the `APP_URL` row:

```markdown
| `BACKUP_HEARTBEAT_URL` | unset | Worker. http(s) URL the nightly backup GETs after each validated dump, never after a failure, e.g. an uptime-kuma Push monitor. See [backups.md § Monitoring](backups.md#monitoring) |
```

and change the docs-index line (currently line 245):

```markdown
- [`docs/backups.md`](backups.md) — pg_dump backups, the dead-man monitor, and the restore runbook.
```

- [ ] **Step 6: Verify the compose file still parses, then commit**

```bash
docker compose config >/dev/null && echo compose-ok
pnpm lint:fix
git add lib/env.ts tests/unit/env.test.ts .env.example docker-compose.yml docs/README.md
git commit -m "feat(env): optional BACKUP_HEARTBEAT_URL for the backup dead-man monitor"
git log --oneline -1   # confirm HEAD moved
```

---

### Task 3: Atomic, validated dumps; prune only after success; heartbeat

**Files:**
- Rewrite: `worker/jobs/pg-dump.ts` (all 115 lines)
- Rewrite: `worker/jobs/pg-dump.test.ts`. The existing `buildDumpInvocation` and `selectFilesToPrune` tests are kept verbatim, and the orchestration tests are new.
- Modify: `Dockerfile:92-94` (comment only)

- [ ] **Step 1: Write the failing tests**

Replace the whole of `worker/jobs/pg-dump.test.ts` with:

```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Sentry from '@sentry/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDumpInvocation,
  handlePgDump,
  RETENTION_COUNT,
  type RunCommand,
  STALE_PARTIAL_MS,
  selectFilesToPrune,
} from './pg-dump';

// Only the two fields handlePgDump reads. Mutable per test via `env`.
const env = vi.hoisted(() => ({
  DATABASE_URL: 'postgresql://housemanager:pw@db:5432/housemanager',
  BACKUP_HEARTBEAT_URL: undefined as string | undefined,
}));
vi.mock('@/lib/env', () => ({ getEnv: () => env }));
vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));
// Captured so tests can assert what is (and is never) logged.
const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/logger', () => ({ getLogger: () => log }));

describe('buildDumpInvocation', () => {
  const URL_WITH_PW =
    'postgresql://housemanager:s3cr3tP%40ss@db-host:5432/housemanager?sslmode=require';

  it('keeps the password out of argv and returns it separately for PGPASSWORD', () => {
    const { args, password } = buildDumpInvocation(URL_WITH_PW, '/backups/x.dump');
    expect(password).toBe('s3cr3tP@ss'); // decoded for libpq
    const argv = args.join(' ');
    expect(argv).not.toContain('s3cr3tP'); // no password anywhere in argv
    expect(argv).not.toContain('%40ss');
    // dbname keeps host/user/db/params, drops the password
    expect(args).toContainEqual(
      '--dbname=postgresql://housemanager@db-host:5432/housemanager?sslmode=require',
    );
    expect(args).toContain('--format=custom');
    expect(args).toContain('--file=/backups/x.dump');
  });

  it('does not throw on malformed percent-encoding in the password', () => {
    // A literal '%' (invalid escape) would make decodeURIComponent throw.
    const url = 'postgresql://user:ab%cd@host:5432/db';
    expect(() => buildDumpInvocation(url, '/backups/z.dump')).not.toThrow();
    const { args, password } = buildDumpInvocation(url, '/backups/z.dump');
    expect(password).toBe('ab%cd'); // raw fallback
    expect(args.join(' ')).not.toContain('ab%cd'); // still absent from argv
  });

  it('returns no password when the URL has none', () => {
    const { args, password } = buildDumpInvocation(
      'postgresql://user@host:5432/db',
      '/backups/y.dump',
    );
    expect(password).toBeUndefined();
    expect(args).toContainEqual('--dbname=postgresql://user@host:5432/db');
  });
});

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
    expect(selectFilesToPrune(files)).toEqual([]);
  });
});

// --- handlePgDump orchestration -------------------------------------------
//
// A real temp directory and a fake `run`, so every assertion is about files
// that actually exist on disk. The fake mimics the real tools' observable
// behaviour, including the one that caused O-M4: pg_dump creates its --file
// BEFORE connecting, so a failed run leaves a 0-byte file behind (reproduced
// with pg_dump 18.6 against an unreachable host).

type FakeOpts = {
  dumpFails?: boolean;
  dumpBytes?: number;
  listFails?: boolean;
  listOutput?: string;
};

const GOOD_LISTING =
  ';\n; Archive created at 2026-09-24 03:00:00 UTC\n;\n' +
  '3391; 0 16415 TABLE DATA public items housemanager\n';

function fakeRun(opts: FakeOpts = {}) {
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const run: RunCommand = async (file, args, options) => {
    calls.push({ file, args, env: options.env });
    if (file === 'pg_dump') {
      const fileArg = args.find((a) => a.startsWith('--file='));
      if (!fileArg) throw new Error('fake pg_dump: no --file');
      const target = fileArg.slice('--file='.length);
      await fs.writeFile(target, Buffer.alloc(opts.dumpFails ? 0 : (opts.dumpBytes ?? 64), 1));
      if (opts.dumpFails) {
        throw Object.assign(new Error('Command failed: pg_dump'), {
          code: 1,
          stderr: 'connection refused',
        });
      }
      return { stdout: '', stderr: '' };
    }
    if (file === 'pg_restore') {
      if (opts.listFails) {
        throw Object.assign(new Error('Command failed: pg_restore --list'), {
          code: 1,
          stderr: 'pg_restore: error: input file is too short',
        });
      }
      return { stdout: opts.listOutput ?? GOOD_LISTING, stderr: '' };
    }
    throw new Error(`fake run: unexpected command ${file}`);
  };
  return { run, calls };
}

const okFetch = () => vi.fn(async () => new Response('{"ok":true}', { status: 200 }));

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-dump-test-'));
  env.BACKUP_HEARTBEAT_URL = undefined;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** A pre-existing file with a chosen age. */
async function seedFile(name: string, ageMs: number, bytes = 64): Promise<void> {
  const full = path.join(dir, name);
  await fs.writeFile(full, Buffer.alloc(bytes, 1));
  const t = new Date(Date.now() - ageMs);
  await fs.utimes(full, t, t);
}

/** Seven valid dumps, 1..7 days old. */
async function seedSevenGoodDumps(): Promise<string[]> {
  const names = Array.from({ length: RETENTION_COUNT }, (_, i) => `housemanager-old-${i + 1}.dump`);
  for (const [i, name] of names.entries()) await seedFile(name, (i + 1) * 86_400_000);
  return names;
}

const listDir = async () => (await fs.readdir(dir)).sort();

describe('handlePgDump', () => {
  it('dumps to a .partial, validates it, then renames it into place', async () => {
    const { run, calls } = fakeRun();
    const result = await handlePgDump({ backupDir: dir, run, fetch: okFetch() });

    expect(result.file).toMatch(/^housemanager-\d{4}-\d{2}-\d{2}T[\d-]+Z\.dump$/);
    expect(result.sizeBytes).toBe(64);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(await listDir()).toEqual([result.file]);

    const partial = path.join(dir, `.${result.file}.partial`);
    expect(calls.map((c) => c.file)).toEqual(['pg_dump', 'pg_restore']);
    expect(calls[0].args).toContain(`--file=${partial}`);
    expect(calls[0].env.PGPASSWORD).toBe('pw');
    expect(calls[1].args).toEqual(['--list', partial]);
  });

  it('on pg_dump failure: leaves no file, does not prune, reports, and rethrows', async () => {
    const survivors = await seedSevenGoodDumps();
    await seedFile('housemanager-old-8.dump', 8 * 86_400_000); // would be pruned on success
    const fetch = okFetch();
    env.BACKUP_HEARTBEAT_URL = 'https://kuma.example/api/push/abc';

    await expect(
      handlePgDump({ backupDir: dir, run: fakeRun({ dumpFails: true }).run, fetch }),
    ).rejects.toThrow('Command failed: pg_dump');

    expect(await listDir()).toEqual([...survivors, 'housemanager-old-8.dump'].sort());
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an empty dump even when pg_dump exits 0', async () => {
    await expect(
      handlePgDump({ backupDir: dir, run: fakeRun({ dumpBytes: 0 }).run, fetch: okFetch() }),
    ).rejects.toThrow(/empty file/);
    expect(await listDir()).toEqual([]);
  });

  it('rejects a dump that pg_restore --list cannot read, and does not prune', async () => {
    const survivors = await seedSevenGoodDumps();
    await seedFile('housemanager-old-8.dump', 8 * 86_400_000);

    await expect(
      handlePgDump({ backupDir: dir, run: fakeRun({ listFails: true }).run, fetch: okFetch() }),
    ).rejects.toThrow(/pg_restore --list/);
    expect(await listDir()).toEqual([...survivors, 'housemanager-old-8.dump'].sort());
  });

  it('rejects a dump whose listing has no table data', async () => {
    const run = fakeRun({ listOutput: ';\n; Archive created at 2026-09-24\n' }).run;
    await expect(handlePgDump({ backupDir: dir, run, fetch: okFetch() })).rejects.toThrow(
      /no TABLE DATA/,
    );
    expect(await listDir()).toEqual([]);
  });

  it('prunes to RETENTION_COUNT valid dumps after a success, newest kept', async () => {
    const old = await seedSevenGoodDumps(); // old-1 newest … old-7 oldest
    const result = await handlePgDump({ backupDir: dir, run: fakeRun().run, fetch: okFetch() });

    expect(result.pruned).toBe(1);
    expect(await listDir()).toEqual([result.file, ...old.slice(0, RETENTION_COUNT - 1)].sort());
  });

  // O-M4: two bad nights under the old job left six 0-byte dumps NEWER than
  // every good one, and the pruner then deleted the good ones to make room.
  it('never counts 0-byte dumps toward retention, and removes them', async () => {
    const old = await seedSevenGoodDumps();
    for (let i = 0; i < 3; i++) await seedFile(`housemanager-empty-${i}.dump`, 3_600_000, 0);

    const result = await handlePgDump({ backupDir: dir, run: fakeRun().run, fetch: okFetch() });

    expect(result.pruned).toBe(1); // only old-7 goes; the empties never displaced a good dump
    expect(await listDir()).toEqual([result.file, ...old.slice(0, RETENTION_COUNT - 1)].sort());
  });

  // Retention sorts by mtime. If the clock stepped backwards, every existing
  // dump looks newer than tonight's, and a plain newest-7 would delete it.
  it('never prunes the dump it just made, even if the clock stepped backwards', async () => {
    const future = Array.from(
      { length: RETENTION_COUNT },
      (_, i) => `housemanager-future-${i + 1}.dump`,
    );
    for (const [i, name] of future.entries()) await seedFile(name, -(i + 1) * 86_400_000);

    const result = await handlePgDump({ backupDir: dir, run: fakeRun().run, fetch: okFetch() });

    expect(result.pruned).toBe(1); // future-1, the oldest of the others
    expect(await listDir()).toEqual([result.file, ...future.slice(1)].sort());
  });

  it('never touches files outside the housemanager-*.dump pattern', async () => {
    await seedSevenGoodDumps();
    await seedFile('notes.txt', 30 * 86_400_000);
    await seedFile('other-app.dump', 30 * 86_400_000);
    await seedFile('housemanager-manual.sql', 30 * 86_400_000);

    await handlePgDump({ backupDir: dir, run: fakeRun().run, fetch: okFetch() });

    const names = await listDir();
    expect(names).toContain('notes.txt');
    expect(names).toContain('other-app.dump');
    expect(names).toContain('housemanager-manual.sql');
  });

  it('removes stale .partial leftovers but not recent ones', async () => {
    await seedFile('.housemanager-killed.dump.partial', STALE_PARTIAL_MS + 3_600_000);
    await seedFile('.housemanager-recent.dump.partial', 60_000);

    await handlePgDump({ backupDir: dir, run: fakeRun().run, fetch: okFetch() });

    const names = await listDir();
    expect(names).not.toContain('.housemanager-killed.dump.partial');
    expect(names).toContain('.housemanager-recent.dump.partial');
  });

  describe('heartbeat', () => {
    const PUSH_URL = 'https://kuma.example/api/push/abc123?status=up&msg=OK&ping=';

    it('is skipped when BACKUP_HEARTBEAT_URL is unset', async () => {
      const fetch = okFetch();
      const result = await handlePgDump({ backupDir: dir, run: fakeRun().run, fetch });
      expect(result.heartbeat).toBe('skipped');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('GETs the URL verbatim, with a timeout signal, after a validated dump', async () => {
      env.BACKUP_HEARTBEAT_URL = PUSH_URL;
      const fetch = okFetch();
      const result = await handlePgDump({ backupDir: dir, run: fakeRun().run, fetch });
      expect(result.heartbeat).toBe('sent');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(PUSH_URL, { signal: expect.any(AbortSignal) });
    });

    it('is fail-soft on a non-2xx response', async () => {
      env.BACKUP_HEARTBEAT_URL = PUSH_URL;
      const fetch = vi.fn(async () => new Response('{"ok":false}', { status: 404 }));
      const result = await handlePgDump({ backupDir: dir, run: fakeRun().run, fetch });
      expect(result.heartbeat).toBe('failed');
      expect(await listDir()).toEqual([result.file]);
    });

    it('is fail-soft on a network error', async () => {
      env.BACKUP_HEARTBEAT_URL = PUSH_URL;
      const fetch = vi.fn(async () => {
        throw new TypeError('fetch failed');
      });
      const result = await handlePgDump({ backupDir: dir, run: fakeRun().run, fetch });
      expect(result.heartbeat).toBe('failed');
      expect(await listDir()).toEqual([result.file]);
    });

    // undici puts the request URL in some error messages, and this URL carries
    // the push token (and could carry user:pass@). Only the error's name and
    // its cause's code may reach the log.
    it('never logs the URL or its secrets when the ping throws', async () => {
      // Built from parts: the single literal trips the ggshield pre-commit hook
      // ("Basic Auth String"). Same runtime value.
      const user = 'kuma-user';
      const pass = 's3cretPass';
      const secretUrl = `https://${user}:${pass}@kuma.example/api/push/tok3nSecret?status=up`;
      env.BACKUP_HEARTBEAT_URL = secretUrl;
      const fetch = vi.fn(async () => {
        throw Object.assign(new TypeError(`fetch failed: ${secretUrl}`), {
          cause: Object.assign(new Error(`connect ECONNREFUSED ${secretUrl}`), {
            code: 'ECONNREFUSED',
          }),
        });
      });

      const result = await handlePgDump({ backupDir: dir, run: fakeRun().run, fetch });

      expect(result.heartbeat).toBe('failed');
      expect(log.warn).toHaveBeenCalledWith(
        { event: 'pg-dump.heartbeat.failed', errName: 'TypeError', causeCode: 'ECONNREFUSED' },
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

    it('is fail-soft when the monitor never answers (timeout)', async () => {
      env.BACKUP_HEARTBEAT_URL = PUSH_URL;
      // Never settles on its own; only the abort signal ends it.
      const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          if (signal) signal.addEventListener('abort', () => reject(signal.reason));
        });
      });
      const result = await handlePgDump({
        backupDir: dir,
        run: fakeRun().run,
        fetch,
        heartbeatTimeoutMs: 20,
      });
      expect(result.heartbeat).toBe('failed');
    });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm exec vitest run worker/jobs/pg-dump.test.ts
```

Expected: **15 failed, 7 passed.** The 6 pure-helper tests pass. The current `handlePgDump` ignores its argument and shells out to the real `pg_dump` against `/backups` and host `db`. Most new tests therefore fail with `Command failed: pg_dump --format=custom --dbname=postgresql://housemanager@db:5432/housemanager --file=/backups/housemanager-….dump` (or `ENOENT` if `pg_dump` isn't installed). The three rejection tests fail with `expected … to throw error matching /empty file/` (and `/pg_restore --list/`, `/no TABLE DATA/`) `but got 'Command failed: pg_dump …'`. `on pg_dump failure` **passes by accident**, because the real `pg_dump` fails too. The clock-step and no-secrets tests fail the same way as the others, before reaching their own assertions. That is expected. Nothing touches the network except a DNS lookup of `db`.

- [ ] **Step 3: Implement**

Replace the whole of `worker/jobs/pg-dump.ts` with:

```ts
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import * as Sentry from '@sentry/node';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';

const logger = getLogger('worker.pg-dump');
const execFileAsync = promisify(execFile);

const BACKUP_DIR = '/backups';
const FILENAME_PREFIX = 'housemanager-';
const FILENAME_SUFFIX = '.dump';
// In-flight output is written as `.housemanager-<ISO>.dump.partial`. The
// leading dot and the extra suffix mean it can never match the retention
// pattern, so a dump that dies mid-write can never be counted as a backup.
const PARTIAL_PREFIX = `.${FILENAME_PREFIX}`;
const PARTIAL_SUFFIX = '.partial';
export const RETENTION_COUNT = 7;
/**
 * A `.partial` older than this is debris from a killed run (SIGKILL, OOM, a
 * container stop mid-dump), never a run still in flight: the job is daily and
 * pg-boss expires an attempt after 15 minutes.
 */
export const STALE_PARTIAL_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

export type FileEntry = { name: string; mtimeMs: number };

/** execFile, narrowed to what this job needs. Injectable so tests need no pg_dump. */
export type RunCommand = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

type PgDumpDeps = {
  backupDir: string;
  run: RunCommand;
  fetch: typeof fetch;
  heartbeatTimeoutMs: number;
};

const defaultRun: RunCommand = (file, args, options) =>
  // 16 MiB: `pg_restore --list` prints one line per archive object, and
  // execFile's 1 MiB default would kill it on a large schema.
  execFileAsync(file, args, { env: options.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

export type PgDumpResult = {
  file: string;
  sizeBytes: number;
  durationMs: number;
  pruned: number;
  heartbeat: 'sent' | 'skipped' | 'failed';
};

/**
 * Split the DB password out of the connection string so it never lands in
 * `pg_dump`'s argv (which would otherwise be logged on error / sent to Sentry
 * via the Error's `cmd`/`spawnargs`). The password is passed to pg_dump through
 * the `PGPASSWORD` env var instead; the `--dbname` URL keeps host/user/db/params
 * but not the password. Pure + exported for testing.
 */
export function buildDumpInvocation(
  databaseUrl: string,
  filepath: string,
): { args: string[]; password?: string } {
  const u = new URL(databaseUrl);
  let password: string | undefined;
  if (u.password) {
    try {
      password = decodeURIComponent(u.password);
    } catch {
      // Malformed percent-encoding (e.g. a literal '%' in the password) would
      // make decodeURIComponent throw and abort the backup. Fall back to the raw
      // value — still kept out of argv, just not URL-decoded.
      password = u.password;
    }
  }
  u.password = '';
  return {
    args: ['--format=custom', `--dbname=${u.toString()}`, `--file=${filepath}`],
    password,
  };
}

/**
 * Given a list of dump files in the backup directory, returns the subset that
 * should be deleted so that only the newest `keep` (default RETENTION_COUNT)
 * remain. Pure function — exported for testing. Callers must pass only
 * VALIDATED dumps (see pruneBackupDir).
 */
export function selectFilesToPrune(files: FileEntry[], keep = RETENTION_COUNT): FileEntry[] {
  if (files.length <= keep) return [];
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  return sorted.slice(keep);
}

/**
 * Dump to a temp file, prove it is a readable archive, then rename it into
 * place. `rename` within one directory is atomic, so a `housemanager-*.dump`
 * either is a complete, validated archive or does not exist.
 */
async function dumpAndValidate(
  deps: PgDumpDeps,
  databaseUrl: string,
  partialPath: string,
  finalPath: string,
): Promise<number> {
  const { args, password } = buildDumpInvocation(databaseUrl, partialPath);
  await deps.run('pg_dump', args, {
    env: password ? { ...process.env, PGPASSWORD: password } : process.env,
  });

  // pg_dump creates its output file before it connects, so an early failure
  // leaves an empty file. Exit 0 with zero bytes should not happen; if it does,
  // it is not a backup.
  const { size } = await fs.stat(partialPath);
  if (size === 0) throw new Error('pg_dump exited 0 but wrote an empty file');

  // Reads the archive header and table of contents. That catches a truncated
  // or foreign file, and a dump with no table data (e.g. DATABASE_URL pointing
  // at an empty database) is not a backup either.
  const { stdout } = await deps.run('pg_restore', ['--list', partialPath], { env: process.env });
  if (!stdout.includes(' TABLE DATA ')) {
    throw new Error('pg_restore --list found no TABLE DATA entries in the dump');
  }

  await fs.rename(partialPath, finalPath);
  return size;
}

/**
 * Enforce retention over VALIDATED dumps only, and clear debris. Best-effort:
 * returns the number of dumps pruned, logs and swallows its own failures.
 *
 * - `housemanager-*.dump` with size > 0 → retention candidate. Since the
 *   rename above, a file of that name is always a validated archive.
 * - `housemanager-*.dump` with size 0 → left by the pre-fix job when pg_dump
 *   failed. Carries no data; removed, never counted.
 * - `.housemanager-*.dump.partial` older than STALE_PARTIAL_MS → removed.
 * - anything else → never touched.
 *
 * `current` (the dump this run just validated) is never a prune candidate and
 * takes one of the RETENTION_COUNT slots. Ordering is by mtime, so without
 * this a clock that stepped backwards (NTP correction, a host restored from a
 * snapshot) would make tonight's dump look like the oldest and delete it.
 */
async function pruneBackupDir(backupDir: string, current: string): Promise<number> {
  let pruned = 0;
  try {
    const now = Date.now();
    const candidates: FileEntry[] = [];
    for (const name of await fs.readdir(backupDir)) {
      const full = path.join(backupDir, name);
      if (name.startsWith(PARTIAL_PREFIX) && name.endsWith(PARTIAL_SUFFIX)) {
        const s = await fs.stat(full);
        if (now - s.mtimeMs > STALE_PARTIAL_MS) {
          await fs.rm(full, { force: true });
          logger.warn(
            { event: 'pg-dump.partial.removed', file: name },
            'removed stale partial dump',
          );
        }
        continue;
      }
      if (name === current) continue;
      if (!name.startsWith(FILENAME_PREFIX) || !name.endsWith(FILENAME_SUFFIX)) continue;
      const s = await fs.stat(full);
      if (!s.isFile()) continue;
      if (s.size === 0) {
        await fs.rm(full, { force: true });
        logger.warn({ event: 'pg-dump.empty.removed', file: name }, 'removed empty dump');
        continue;
      }
      candidates.push({ name, mtimeMs: s.mtimeMs });
    }
    for (const f of selectFilesToPrune(candidates, RETENTION_COUNT - 1)) {
      await fs.unlink(path.join(backupDir, f.name));
      pruned += 1;
    }
    if (pruned > 0) logger.info({ event: 'pg-dump.pruned', pruned }, 'pruned old dumps');
  } catch (e) {
    logger.warn({ err: e }, 'pruning failed (non-fatal)');
  }
  return pruned;
}

/**
 * Dead-man ping. Fail-soft: a monitor outage must never fail the backup, and a
 * missed ping is exactly what the monitor alerts on.
 *
 * Never logs the URL, and never logs an error's `message`: undici puts the full
 * request URL in some of its errors, and this URL carries the push token (and
 * could carry `user:pass@` — httpUrlSchema allows credentials). Only the error's
 * name and its cause's `code` (e.g. ECONNREFUSED, ENOTFOUND) are logged.
 */
async function pingHeartbeat(
  url: string | undefined,
  deps: PgDumpDeps,
): Promise<PgDumpResult['heartbeat']> {
  if (!url) return 'skipped';
  try {
    const res = await deps.fetch(url, { signal: AbortSignal.timeout(deps.heartbeatTimeoutMs) });
    if (!res.ok) {
      logger.warn(
        { event: 'pg-dump.heartbeat.failed', status: res.status },
        'backup heartbeat rejected (non-fatal)',
      );
      return 'failed';
    }
    return 'sent';
  } catch (e) {
    const err = e as Error;
    logger.warn(
      {
        event: 'pg-dump.heartbeat.failed',
        errName: err.name,
        causeCode: (err.cause as { code?: string } | undefined)?.code,
      },
      'backup heartbeat failed (non-fatal)',
    );
    return 'failed';
  }
}

/**
 * Runs `pg_dump --format=custom` against DATABASE_URL into a temp file,
 * validates it, renames it to <backupDir>/housemanager-<ISO>.dump, prunes the
 * directory to the last RETENTION_COUNT valid dumps, then pings
 * BACKUP_HEARTBEAT_URL if set.
 *
 * Failure modes:
 *   - pg_dump fails, output empty, or `pg_restore --list` rejects it → temp
 *     file deleted, NO prune, NO heartbeat, log error + Sentry + throw (pg-boss
 *     retries). The monitor goes red because the ping never comes.
 *   - pruning failure → log warn, do NOT throw (the dump itself was the goal)
 *   - heartbeat failure → log warn, do NOT throw
 *
 * `overrides` exists for tests. The worker calls this with no arguments.
 */
export async function handlePgDump(overrides: Partial<PgDumpDeps> = {}): Promise<PgDumpResult> {
  const deps: PgDumpDeps = {
    backupDir: BACKUP_DIR,
    run: defaultRun,
    fetch: globalThis.fetch,
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
    ...overrides,
  };
  const { DATABASE_URL, BACKUP_HEARTBEAT_URL } = getEnv();
  const startedAt = Date.now();
  // ISO timestamp with `:` and `.` replaced (filesystem-safe).
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
  const filename = `${FILENAME_PREFIX}${stamp}${FILENAME_SUFFIX}`;
  const finalPath = path.join(deps.backupDir, filename);
  const partialPath = path.join(deps.backupDir, `.${filename}${PARTIAL_SUFFIX}`);

  let sizeBytes: number;
  try {
    sizeBytes = await dumpAndValidate(deps, DATABASE_URL, partialPath, finalPath);
  } catch (e) {
    await fs.rm(partialPath, { force: true }).catch(() => undefined);
    const err = e as Error & { code?: number | string; stderr?: string };
    // Log only safe fields — the raw Error carries `cmd`/`spawnargs`. Those no
    // longer contain the password (it's in PGPASSWORD), but keep the log narrow.
    logger.error(
      { event: 'pg-dump.failed', message: err.message, code: err.code, stderr: err.stderr },
      'pg_dump failed',
    );
    Sentry.captureException(err);
    throw err;
  }

  const durationMs = Date.now() - startedAt;
  logger.info(
    { event: 'pg-dump.completed', file: filename, sizeBytes, durationMs },
    'pg_dump completed',
  );

  const pruned = await pruneBackupDir(deps.backupDir, filename);
  const heartbeat = await pingHeartbeat(BACKUP_HEARTBEAT_URL, deps);
  return { file: filename, sizeBytes, durationMs, pruned, heartbeat };
}
```

- [ ] **Step 4: Run them and watch them pass**

```bash
pnpm exec vitest run worker/jobs/pg-dump.test.ts
```

Expected: 22 passed.

- [ ] **Step 5: Update the Dockerfile comment**

Replace `Dockerfile` lines 92-94:

```dockerfile
# postgresql18-client provides pg_dump for the worker's nightly DB backup job
# (worker/jobs/pg-dump.ts). pg_dump must be >= the server major; server is
# pgvector:pg18, matched.
```

with:

```dockerfile
# postgresql18-client provides pg_dump AND pg_restore for the worker's nightly
# DB backup job (worker/jobs/pg-dump.ts validates every dump with
# `pg_restore --list` before giving it its final name). pg_dump must be >= the
# server major; server is pgvector:pg18, matched. scripts/smoke-image.sh runs
# the job against PG_IMAGE, so a mismatch fails the image smoke test.
```

- [ ] **Step 6: Worker graph, types, lint**

```bash
pnpm typecheck
pnpm lint
```

Expected: both clean. `lint:worker-graph` still passes: no new package in the worker graph, and `lib/env.ts → lib/http-url.ts` stays inside `lib/`. knip is satisfied: `RunCommand` and `STALE_PARTIAL_MS` are imported by the test, and exported types used in their own file (`PgDumpResult`, like the existing `FileEntry`) are not flagged here. `pnpm lint:knip` is clean on `main` with `FileEntry` in exactly that position.

- [ ] **Step 7: Commit**

```bash
git add worker/jobs/pg-dump.ts worker/jobs/pg-dump.test.ts Dockerfile
git commit -m "fix(backup): atomic validated dumps; prune only after success; dead-man heartbeat"
git log --oneline -1   # confirm HEAD moved
```

---

### Task 4: Integration round-trip — real dump, restored into a fresh server

**Files:**
- Modify: `tests/integration/setup.ts:31-36` (extract `startPostgres`)
- Create: `tests/integration/pg-dump-restore.test.ts`
- Modify: `docs/TESTING.md:21` (the `pnpm test:integration` row)

This test runs green on first execution, because Task 3 already made the job correct. Step 4 proves it isn't vacuous by breaking the restore on purpose.

- [ ] **Step 1: Extract `startPostgres()`**

In `tests/integration/setup.ts`, replace:

```ts
export async function startStack(): Promise<TestStack> {
  const postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('housemanager')
    .withUsername('housemanager')
    .withPassword('test')
    .start();
```

with:

```ts
/**
 * A bare Postgres from the stack's image, credentials and database name. The
 * stack uses it, and so does any test that needs a second, empty server --
 * e.g. restoring a dump somewhere other than where it was taken.
 */
export function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('housemanager')
    .withUsername('housemanager')
    .withPassword('test')
    .start();
}

export async function startStack(): Promise<TestStack> {
  const postgres = await startPostgres();
```

Leave the `// renovate:` annotation and the `POSTGRES_IMAGE` constant exactly as they are. The Renovate customManager matches that shape.

- [ ] **Step 2: Create the test**

Create `tests/integration/pg-dump-restore.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PgDumpResult } from '@/worker/jobs/pg-dump';
import {
  calDaysOut,
  type IntegrationContext,
  setupIntegration,
  teardownIntegration,
} from './helpers';
import { startPostgres } from './setup';

// Backups are the only recovery path, and nothing else proves a dump can be
// restored with the hand-written SQL that `prisma migrate diff` cannot
// regenerate (CLAUDE.md § Migrations carry SQL that Prisma cannot regenerate).
//
// Runs the REAL handlePgDump -- real pg_dump / pg_restore from PATH, the same
// way the worker does -- against a migrated + seeded source, restores the
// result into a SECOND, fresh Postgres with the runbook's flags
// (docs/backups.md), and compares the two.
//
// pg_dump / pg_restore come from the host, not the container, because that is
// the code path production runs (execFile on PATH, PGPASSWORD, a TCP URL).
// They must be >= the server major (18): the ubuntu-26.04 runner image ships
// PostgreSQL 18.6; on macOS, Homebrew's libpq (keg-only) or postgresql@18
// provides them. The preflight below fails with that hint instead of a
// pg_dump "server version mismatch".

// Only the fields handlePgDump reads. An unmocked getEnv() passes locally via
// .env and fails in CI, which has no .env.
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ DATABASE_URL: process.env.DATABASE_URL, BACKUP_HEARTBEAT_URL: undefined }),
}));

// The runbook's pg_restore flags. Keep in step with docs/backups.md § Restoring.
const RESTORE_FLAGS = ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction'];

// Every hand-written object the migrations add with raw SQL.
const HAND_WRITTEN_CHECKS = [
  'Attachment_file_metadata_required',
  'Attachment_storage_xor_link',
  'service_record_targets_parent_xor',
  'warranty_targets_parent_xor',
  'reminder_targets_parent_at_most_one',
  'IncomingEmailTarget_parent_xor',
  'item_vendors_link_xor',
  'system_vendors_link_xor',
  'part_links_parent_xor',
];
const NULLS_NOT_DISTINCT_INDEXES = [
  'sr_targets_record_item_system_part_key',
  'warranty_targets_warrantyId_itemId_systemId_key',
  'reminder_targets_reminder_item_system_part_key',
  'incoming_email_targets_incomingEmailId_itemId_systemId_key',
  'part_links_partId_itemId_systemId_key',
];
const IVFFLAT_INDEX = 'embeddings_embedding_cosine_idx';
// A queue that exists only in this test, so finding it after the restore can
// only mean the dump carried pg-boss's schema.
const PROBE_QUEUE = 'backup-restore-probe';

let ctx: IntegrationContext;
let target: StartedPostgreSqlContainer;
let backupDir: string;
let result: PgDumpResult;
let source: Client;
let restored: Client;

function clientMajor(bin: 'pg_dump' | 'pg_restore'): number {
  let out: string;
  try {
    out = execFileSync(bin, ['--version'], { encoding: 'utf8' });
  } catch {
    throw new Error(
      `${bin} is not on PATH. Install a PostgreSQL 18+ client -- on macOS, \`brew install libpq\` and put "$(brew --prefix libpq)/bin" on PATH (libpq is keg-only).`,
    );
  }
  const m = /\(PostgreSQL\)\s+(\d+)/.exec(out);
  if (!m) throw new Error(`cannot parse \`${bin} --version\`: ${out}`);
  return Number(m[1]);
}

async function seedRepresentativeRows(): Promise<void> {
  const p = ctx.prisma;
  const user = await p.user.create({
    data: { email: 'backup-restore@example.com', name: 'Backup Restore' },
  });
  const category = await p.category.findUniqueOrThrow({ where: { slug: 'plumbing' } });
  // From prisma/seed.ts, which also seeded three parts and two part_links.
  const systemId = 'seed-system-hvac';
  const item = await p.item.create({
    data: {
      name: 'Water heater',
      categoryId: category.id,
      systemId,
      purchaseDate: calDaysOut(-400),
      purchasePrice: '1299.00',
      metadata: { capacityGallons: 50 },
    },
  });
  const vendor = await p.vendor.create({ data: { name: 'Acme Plumbing', tags: ['plumbing'] } });

  // item_vendors_link_xor / system_vendors_link_xor: both arms.
  await p.itemVendor.create({ data: { itemId: item.id, vendorId: vendor.id, role: 'INSTALLER' } });
  await p.itemVendor.create({
    data: { itemId: item.id, freeformName: 'Previous owner', role: 'PURCHASE' },
  });
  await p.systemVendor.create({
    data: {
      systemId,
      vendorId: vendor.id,
      role: 'SERVICE',
      serviceContract: true,
      contractEndsOn: calDaysOut(200),
    },
  });

  await p.warranty.create({
    data: {
      provider: 'Rheem',
      startsOn: calDaysOut(-400),
      endsOn: calDaysOut(2000),
      targets: { create: [{ itemId: item.id }, { systemId }] },
    },
  });

  // service_record_targets: all three parent arms.
  await p.serviceRecord.create({
    data: {
      summary: 'Annual flush',
      performedOn: calDaysOut(-30),
      vendorId: vendor.id,
      cost: '149.00',
      targets: {
        create: [{ itemId: item.id }, { systemId }, { partId: 'seed-part-air-filter' }],
      },
    },
  });

  // reminder_targets: a linked REMINDER, and a standalone CHORE's both-NULL row
  // (the relaxed "at most one" constraint).
  await p.reminder.create({
    data: {
      title: 'Flush water heater',
      recurrence: { kind: 'interval', every: 1, unit: 'year' },
      notifyUserIds: [user.id],
      targets: { create: [{ itemId: item.id, nextDueOn: calDaysOut(335) }] },
    },
  });
  await p.reminder.create({
    data: {
      title: 'Clean gutters',
      kind: 'CHORE',
      recurrence: { kind: 'interval', every: 6, unit: 'month' },
      notifyUserIds: [],
      targets: { create: [{ nextDueOn: calDaysOut(14) }] },
    },
  });

  // Attachment_storage_xor_link + Attachment_file_metadata_required: a stored
  // file and an external link.
  await p.attachment.create({
    data: {
      filename: 'manual.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1234,
      storagePath: 'backup-test/original.pdf',
      uploadedById: user.id,
      itemId: item.id,
    },
  });
  await p.attachment.create({
    data: {
      externalUrl: 'https://example.com/manual',
      displayLabel: 'Online manual',
      uploadedById: user.id,
      itemId: item.id,
    },
  });

  // A real vector(1024), so the restore has to rebuild the IVFFlat index over data.
  const vec = `[${Array.from({ length: 1024 }, (_, i) => ((i % 7) / 10).toFixed(1)).join(',')}]`;
  await p.$executeRaw`
    INSERT INTO embeddings (id, "entityType", "entityId", "chunkIndex", text, embedding, "tokenCount", "contentHash", "createdAt")
    VALUES (${randomUUID()}, 'ITEM'::"EmbeddingEntityType", ${item.id}, 0, 'Water heater', ${vec}::vector(1024), 3, 'backup-test', NOW())
  `;
}

/** Row count + content hash of every base table in `public`, keyed by table. */
async function tableFingerprints(db: Client): Promise<Record<string, string>> {
  const { rows: tables } = await db.query<{ t: string }>(
    `SELECT table_name AS t FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`,
  );
  const out: Record<string, string> = {};
  for (const { t } of tables) {
    const quoted = `"public"."${t.replace(/"/g, '""')}"`;
    const { rows } = await db.query<{ n: string; h: string | null }>(
      `SELECT count(*)::text AS n, md5(string_agg(x::text, E'\\n' ORDER BY x::text)) AS h FROM ${quoted} x`,
    );
    out[t] = `${rows[0].n}:${rows[0].h ?? 'empty'}`;
  }
  return out;
}

async function checkConstraints(db: Client) {
  const { rows } = await db.query<{ tbl: string; conname: string; def: string }>(
    `SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE contype = 'c' AND connamespace = 'public'::regnamespace
     ORDER BY 1, 2`,
  );
  return rows;
}

async function indexes(db: Client) {
  const { rows } = await db.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`,
  );
  return rows;
}

beforeAll(async () => {
  ctx = await setupIntegration();
  execFileSync('pnpm', ['exec', 'tsx', 'prisma/seed.ts'], {
    env: { ...process.env, DATABASE_URL: ctx.stack.databaseUrl },
    stdio: 'inherit',
  });
  await seedRepresentativeRows();

  // pg-boss keeps its queues, jobs and cron schedules in a `pgboss` schema in
  // the same database, so a restore has to carry that too. Stopped before the
  // dump, and in `finally`, so no instance outlives this hook.
  const boss = new PgBoss({ connectionString: ctx.stack.databaseUrl });
  try {
    await boss.start();
    await boss.createQueue(PROBE_QUEUE);
  } finally {
    await boss.stop();
  }

  source = new Client({ connectionString: ctx.stack.databaseUrl });
  await source.connect();
  const { rows } = await source.query<{ v: string }>('SHOW server_version_num');
  const serverMajor = Math.floor(Number(rows[0].v) / 10_000);
  for (const bin of ['pg_dump', 'pg_restore'] as const) {
    const major = clientMajor(bin);
    if (major < serverMajor) {
      throw new Error(`${bin} ${major} on PATH cannot handle a PostgreSQL ${serverMajor} server.`);
    }
  }

  backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-dump-restore-'));
  const { handlePgDump } = await import('@/worker/jobs/pg-dump');
  result = await handlePgDump({ backupDir });

  target = await startPostgres();
  // Archive on stdin, exactly as the runbook's `docker exec -i … < "$DUMP"`
  // feeds it. A custom-format archive restores from a non-seekable input only
  // in archive order, so this also proves the runbook's pipe works.
  execFileSync('pg_restore', [...RESTORE_FLAGS, `--dbname=${target.getConnectionUri()}`], {
    input: await fs.readFile(path.join(backupDir, result.file)),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  restored = new Client({ connectionString: target.getConnectionUri() });
  await restored.connect();
}, 300_000);

afterAll(async () => {
  await restored?.end();
  await source?.end();
  await target?.stop();
  if (backupDir) await fs.rm(backupDir, { recursive: true, force: true });
  await teardownIntegration(ctx);
});

describe('pg_dump → pg_restore round-trip', () => {
  it('the job leaves exactly one validated dump and no temp file', async () => {
    expect(await fs.readdir(backupDir)).toEqual([result.file]);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.heartbeat).toBe('skipped');
  });

  it('every table has identical rows', async () => {
    const before = await tableFingerprints(source);
    // Not vacuous: the tables the hand-written SQL guards actually hold rows.
    for (const t of [
      'items',
      'item_vendors',
      'warranty_targets',
      'service_record_targets',
      'reminder_targets',
      'attachments',
      'part_links',
      'embeddings',
      '_prisma_migrations',
    ]) {
      expect(before[t], t).not.toMatch(/^0:/);
    }
    expect(await tableFingerprints(restored)).toEqual(before);
  });

  it('every CHECK constraint survives, including the hand-written ones', async () => {
    const before = await checkConstraints(source);
    const after = await checkConstraints(restored);
    expect(after).toEqual(before);
    const names = after.map((r) => r.conname);
    for (const c of HAND_WRITTEN_CHECKS) expect(names, c).toContain(c);
  });

  it('every index survives, including NULLS NOT DISTINCT and IVFFlat', async () => {
    const before = await indexes(source);
    const after = await indexes(restored);
    expect(after).toEqual(before);
    const byName = new Map(after.map((r) => [r.indexname, r.indexdef]));
    for (const name of NULLS_NOT_DISTINCT_INDEXES) {
      expect(byName.get(name), name).toMatch(/NULLS NOT DISTINCT/);
    }
    expect(byName.get(IVFFLAT_INDEX)).toMatch(/USING ivfflat/);
  });

  it("pg-boss's schema and queues survive", async () => {
    const tables = `SELECT tablename FROM pg_tables WHERE schemaname = 'pgboss' ORDER BY 1`;
    const before = (await source.query(tables)).rows;
    expect(before.length).toBeGreaterThan(0);
    expect((await restored.query(tables)).rows).toEqual(before);
    const probe = await restored.query('SELECT name FROM pgboss.queue WHERE name = $1', [
      PROBE_QUEUE,
    ]);
    expect(probe.rows).toHaveLength(1);
  });

  it('the vector extension is installed', async () => {
    const { rows } = await restored.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
    expect(rows).toHaveLength(1);
  });

  it('prisma sees the restored database as fully migrated', () => {
    // Web runs `migrate deploy` on boot after a restore. It must be a no-op.
    // `migrate status` exits non-zero when anything is pending or failed.
    expect(() =>
      execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'status'], {
        env: { ...process.env, DATABASE_URL: target.getConnectionUri() },
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 3: Run it**

```bash
pnpm exec vitest run tests/integration/pg-dump-restore.test.ts
```

Expected: 7 passed, in about 10s after images are cached. The log shows the migrations, then `Seeded 9 categories.`, `Seeded system-auto-complete user.`, and `Seeded 3 demo parts (…)`. `pg_restore` prints nothing.

- [ ] **Step 4: Prove it isn't vacuous (then revert)**

Temporarily make the restore skip everything after table definitions. Edit `RESTORE_FLAGS` to start with `'--section=pre-data', ` and rerun:

```bash
pnpm exec vitest run tests/integration/pg-dump-restore.test.ts
```

Expected: **4 failed, 3 passed.** `every table has identical rows`, `every index survives…`, `pg-boss's schema and queues survive` and `prisma sees the restored database as fully migrated` fail. CHECK constraints are inline in `CREATE TABLE`, which is pre-data, so that test still passes. Revert the edit (`grep -n "const RESTORE_FLAGS" tests/integration/pg-dump-restore.test.ts` must show exactly the four original flags), then confirm 7 pass again:

```bash
pnpm exec vitest run tests/integration/pg-dump-restore.test.ts
```

- [ ] **Step 5: The stack still starts for everyone else**

`startStack` changed shape, so run two unrelated suites:

```bash
pnpm exec vitest run tests/integration/migration-invariants.test.ts tests/integration/health.test.ts
```

Expected: all pass.

- [ ] **Step 6: Document the prerequisite**

In `docs/TESTING.md`, replace the `pnpm test:integration` row:

```markdown
| `pnpm test:integration` | Integration tests: `tests/integration`. Vitest + Testcontainers (real Postgres). |
```

with:

```markdown
| `pnpm test:integration` | Integration tests: `tests/integration`. Vitest + Testcontainers (real Postgres). `pg-dump-restore.test.ts` also needs a PostgreSQL client ≥ the server major (18) on PATH (`pg_dump`, `pg_restore`). The ubuntu-26.04 CI runner ships 18.6. On macOS, `brew install libpq` and put `$(brew --prefix libpq)/bin` on PATH. The test fails with that hint, rather than skipping, when the client is missing or too old. |
```

- [ ] **Step 7: Commit**

```bash
pnpm lint:fix
git add tests/integration/setup.ts tests/integration/pg-dump-restore.test.ts docs/TESTING.md
git commit -m "test(backup): pg_dump → pg_restore round-trip preserves rows, CHECKs, indexes, vector"
git log --oneline -1   # confirm HEAD moved
```

---

### Task 5: Image smoke test runs the backup job

**Files:**
- Modify: `scripts/smoke-image.sh` (insert after line 209, `echo "  ✓ worker /api/health"`, before the final `echo "SMOKE PASS: $IMAGE"`)

- [ ] **Step 1: Insert the check**

```bash
# The backup job, run for real inside the real image against the smoke DB
# (web has migrated and seeded it, so it holds table data). Proves the apk
# client exists and is major-compatible with PG_IMAGE -- pg_dump refuses a
# newer server -- and that dump -> pg_restore --list -> rename works end to
# end. The tsx command is also the manual smoke command in docs/backups.md.
# The worker has no /backups mount here, so create it first (the image runs as
# root).
echo "→ backup job"
docker exec "$WORKER" pg_dump --version
docker exec "$WORKER" mkdir -p /backups
dump_out="$(docker exec "$WORKER" node_modules/.bin/tsx -e \
  "import('./worker/jobs/pg-dump').then((m) => m.handlePgDump()).then((r) => console.log('SMOKE-DUMP ' + r.file))" \
  2>&1)" || { printf '%s\n' "$dump_out" >&2; fail "handlePgDump failed inside the image"; }
case "$dump_out" in
  *"SMOKE-DUMP housemanager-"*) echo "  ✓ backup job wrote a validated dump" ;;
  *) printf '%s\n' "$dump_out" >&2; fail "handlePgDump did not report a dump" ;;
esac
```

- [ ] **Step 2: Static checks**

```bash
bash -n scripts/smoke-image.sh && echo syntax-ok
shellcheck scripts/smoke-image.sh   # if installed; expect no findings (the current file has none)
```

- [ ] **Step 3 (optional, about 5 min): run it against a local build**

CI runs this on every PR (`build-image` → "Smoke test"), so a local run is optional:

```bash
docker build -t house-manager:smoke .
scripts/smoke-image.sh house-manager:smoke
```

Expected: `→ backup job`, a `pg_dump (PostgreSQL) 18.x` line, `✓ backup job wrote a validated dump`, then `SMOKE PASS`.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-image.sh
git commit -m "ci(smoke): run the real backup job inside the built image"
git log --oneline -1   # confirm HEAD moved
```

---

### Task 6: Rewrite `docs/backups.md`

**Files:**
- Rewrite: `docs/backups.md` (all 107 lines)

Every command below was checked against the facts in "Background": image tools, uid 0, no pnpm, `tsx -e` loading from `/app`; the pgvector image's socket trust auth, as `scripts/smoke-image.sh` already relies on; prod container names and the `/backups` mount; and uptime-kuma's `/api/push/:pushToken`, which returns `200 {"ok":true}` or `404 {"ok":false,…}` for an unknown or paused monitor, with no maximum heartbeat interval in the 2.x UI. The `pg_restore` flags and stdin feed are exactly what Task 4's test runs. The runbook also covers disk headroom before renaming the database aside, finding who blocks the rename, staging Duplicacy-recovered dumps outside `BACKUP_DIR`, and rolling back after the app has restarted.

- [ ] **Step 1: Replace the file**

Replace the whole of `docs/backups.md` with:

````markdown
# Backups

The worker writes a Postgres logical dump to `/backups` (in-container) every day at 03:00 UTC. The container path is bind-mounted to the host directory specified by `BACKUP_DIR` in `docker-compose.yml` (defaults to `./db-backups`, which is git- and docker-ignored). Duplicacy backs that host directory up off-host on its own schedule.

## What's protected

- **Postgres (housemanager DB)**: daily logical dumps via `pg_dump --format=custom`
- **Attachments (FILES_DIR)**: protected via Duplicacy's existing coverage of the appdata folder; this app does nothing extra
- **Meilisearch index**: NOT backed up; rebuildable from Postgres (Settings → Rebuild search index, or the nightly `search.reindex`)

## How a dump is made

`worker/jobs/pg-dump.ts`, in order:

1. `pg_dump` writes to a hidden temp file, `/backups/.housemanager-<ISO>.dump.partial`.
2. The temp file must be non-empty, and `pg_restore --list` must read it and find table data in it.
3. Only then is it renamed to `/backups/housemanager-<ISO>.dump`. The rename is atomic, so **a file with that name is always a complete, validated archive**.
4. Retention: the newest 7 `housemanager-*.dump` files are kept, older ones deleted. This step runs **only after a successful dump**, so failing nights never delete a good one.
5. If `BACKUP_HEARTBEAT_URL` is set, the job GETs it (see [Monitoring](#monitoring)).

On success the worker logs `"event":"pg-dump.completed"` with `sizeBytes` and `durationMs`.

On any failure in steps 1–3, the temp file is deleted, nothing is pruned, no heartbeat is sent, and the job logs `"event":"pg-dump.failed"` and throws. pg-boss retries it twice immediately (its default policy for this queue). If all three attempts fail, the job stays failed until the next 03:00 run. **Nothing re-runs a missed or failed backup early**: the worker's missed-tick recovery covers reminders only.

Housekeeping, also after a successful dump only: empty `housemanager-*.dump` files (left by the job before 2026-09, when a failed `pg_dump` left a 0-byte file) are deleted, and `.partial` files older than a day (from a run that was killed mid-dump) are deleted. No other file in the directory is touched.

## Where dumps live

Inside the worker container: `/backups/housemanager-<ISO>.dump`

On the host: wherever you set `BACKUP_DIR` (e.g., `/srv/duplicacy-source/house-manager/db-backups`).

The worker keeps the **last 7 valid dumps locally**. Long-term retention is Duplicacy's job.

## Setting `BACKUP_DIR`

In the `.env` next to `docker-compose.yml`:

```env
BACKUP_DIR=/srv/duplicacy-source/house-manager/db-backups
```

If unset, it defaults to `./db-backups` (relative to the docker-compose.yml directory).

## Monitoring

A backup that silently stops is the failure that matters, so the job reports success to a dead-man switch. It never reports failure. The monitor goes red when the success pings **stop**, which also covers a worker that is down, wedged, or never scheduled the job.

Set up once, in uptime-kuma:

1. **Add New Monitor** → Monitor Type **Push**. Name it e.g. `house-manager backup`.
2. **Heartbeat Interval**: `90000` seconds (25 hours: one daily run plus slack). **Retries**: `0`.
3. Save, and copy the **Push URL** it shows (`https://<kuma>/api/push/<token>?status=up&msg=OK&ping=`).
4. Set it as `BACKUP_HEARTBEAT_URL` on the **worker** container, then **recreate** the worker so it picks up the new environment: `docker compose up -d` (in production, your normal deploy). `docker restart` keeps the old environment.
5. Send the first ping by running the [manual smoke test](#manual-smoke-test-after-deployment). The monitor stays pending until then.

The URL is fetched verbatim with a 10-second timeout. A monitor that is down or slow logs `"event":"pg-dump.heartbeat.failed"` and never fails the backup. The URL carries the push token, so the job never logs it; treat it as a secret.

## Production deployments

The in-repo `docker-compose.yml` is the dev shape. If you run the app from a hand-curated production compose (not the in-repo file), you must mirror the worker's backup mount yourself. No CI check catches drift between the two.

The worker block needs both mounts, plus the heartbeat URL:

```yaml
    volumes:
      - <host-files-path>:/data/files
      - <host-backups-path>:/backups
    environment:
      BACKUP_HEARTBEAT_URL: <uptime-kuma push URL>
```

If `/backups` is missing inside the worker container, `pg_dump` fails with `could not open output file ... No such file or directory`. The job then fails as described above, and the heartbeat monitor alerts about 25 hours after the last good dump.

Quick check on the deploy host:

```bash
docker exec <worker-container> ls -la /backups
docker inspect <worker-container> --format '{{json .Mounts}}' | jq
```

## Restoring

### Postgres

`tests/integration/pg-dump-restore.test.ts` runs a real dump through these same `pg_restore` flags into a fresh Postgres 18 on every CI run. It checks that every row, CHECK constraint and index (including the hand-written ones) comes back. The steps below only wrap that in `docker`.

Every command uses plain `docker`, never `docker compose run`. So nothing re-reads the compose file, no secrets are needed on the command line (don't source the production env file), and nothing starts a dependency behind your back. Variables inside **single quotes** are expanded by the shell **inside the container**, where the Postgres image sets `POSTGRES_USER` and `POSTGRES_DB`. The host shell only expands `$DB`, `$WEB`, `$WORKER` and `$DUMP`.

0. **Set the names once** in your shell:

   ```bash
   # Dev (this repo's docker-compose.yml):
   DB=$(docker compose ps -aq db); WEB=$(docker compose ps -aq web); WORKER=$(docker compose ps -aq worker)
   # A production compose with fixed container_name values, e.g.:
   # DB=housemanager-postgres; WEB=housemanager-web; WORKER=housemanager-worker

   DUMP=/path/on/host/housemanager-<ISO>.dump   # from BACKUP_DIR, or recovered from Duplicacy
   ```

   Recover an older dump from Duplicacy to a directory **outside** `BACKUP_DIR` (e.g. `/tmp/hm-restore/`). Inside it, the file's old mtime makes it the oldest dump, and the next successful nightly run can prune it. The restore streams the file from the host, so it can live anywhere.

1. **Check the dump** before touching anything. This uses the database container's own `pg_restore`, which matches the server's major version:

   ```bash
   docker exec -i "$DB" pg_restore --list < "$DUMP" | head
   ```

   Expected: a `; Archive created at …` header, then a list of objects. An error here means the dump is unusable. Pick another one.

2. **Stop the app.** In production, also make sure no deploy runs until you are done. A deploy recreates and starts both containers.

   ```bash
   docker stop "$WORKER" "$WEB"
   ```

3. **Move the current database aside.** This keeps it, so the restore can be undone. For a while, two copies coexist, so first check that the volume holding `PGDATA` has room for a second copy of the database:

   ```bash
   docker exec "$DB" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT pg_size_pretty(pg_database_size(current_database()));"'
   docker exec "$DB" sh -c 'df -h "$PGDATA"'
   ```

   Then rename it aside and create an empty one. Each statement is its own `psql` call, because `CREATE`/`ALTER DATABASE` cannot run inside a transaction block:

   ```bash
   docker exec "$DB" sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "ALTER DATABASE \"$POSTGRES_DB\" RENAME TO \"${POSTGRES_DB}_before_restore\";"'
   docker exec "$DB" sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE \"$POSTGRES_DB\" OWNER \"$POSTGRES_USER\";"'
   ```

   `ERROR: database "…" is being accessed by other users` means something still holds a connection. This read-only query shows what:

   ```bash
   docker exec "$DB" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT pid, application_name, client_addr, backend_start FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid();"'
   ```

   Stop whatever it names, whether a container `docker ps` still lists, a local `pnpm dev`, or Prisma Studio. Then retry. `… already exists` means an earlier restore left its `_before_restore` copy. Drop that one first (step 7) if you no longer need it.

4. **Restore.** The dump is streamed on stdin, so it never has to be copied into a container:

   ```bash
   docker exec -i "$DB" sh -c 'pg_restore --no-owner --no-privileges --exit-on-error --single-transaction -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$DUMP"
   ```

   No output means success. With `--single-transaction` and `--exit-on-error`, any error rolls the whole restore back and leaves the new database empty. Go to [If the restore fails](#if-the-restore-fails-or-you-need-to-roll-back-later).

5. **Start web, then the worker.** Web's boot runs `prisma migrate deploy`, which is a no-op because the dump carries `_prisma_migrations`. It applies only migrations newer than the dump, then runs the idempotent seed. Start the worker only once web is healthy, the same ordering compose enforces:

   ```bash
   docker start "$WEB"
   until [ "$(docker inspect -f '{{.State.Health.Status}}' "$WEB")" = healthy ]; do sleep 5; done
   docker start "$WORKER"
   ```

   If web isn't healthy within about 2 minutes, press Ctrl-C and read `docker logs "$WEB"`.

6. **Check, and rebuild search.**
   - Settings → **Rebuild search index**. The Meilisearch index is not in the dump and still holds pre-restore documents.
   - Spot-check the data:
     ```bash
     docker exec "$DB" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM items;"'
     ```
   - Restore attachments to the same point in time (below).

7. **Drop the old copy** once you are satisfied:

   ```bash
   docker exec "$DB" sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE \"${POSTGRES_DB}_before_restore\";"'
   ```

#### If the restore fails, or you need to roll back later

A failed restore applied nothing (single transaction). To roll back **after step 5** has started the app, do step 2 (`docker stop "$WORKER" "$WEB"`) first. The drop and rename fail while the app holds connections. Anything written since the restore is lost. Rolling back is possible only until step 7 drops the old copy. Put the old database back and restart:

```bash
docker exec "$DB" sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE \"$POSTGRES_DB\";"'
docker exec "$DB" sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "ALTER DATABASE \"${POSTGRES_DB}_before_restore\" RENAME TO \"$POSTGRES_DB\";"'
docker start "$WEB"   # then the worker, as in step 5
```

### Attachments (FILES_DIR)

Restore the appdata folder from Duplicacy alongside the database. The DB stores file paths relative to FILES_DIR, so without the file blobs, attachments will 404. Always restore both together, from the same point in time.

## Manual smoke test (after deployment)

To run the backup job now instead of waiting for 03:00 UTC:

```bash
docker exec <worker-container> node_modules/.bin/tsx -e "import('./worker/jobs/pg-dump').then((m) => m.handlePgDump()).then(console.log)"
```

(In dev: `docker compose exec worker node_modules/.bin/tsx -e "…"`, with the same quoted script.) The image ships no pnpm, so `tsx` is called by path.

Expected output, after the JSON log lines: `{ file: 'housemanager-….dump', sizeBytes: …, durationMs: …, pruned: 0, heartbeat: 'sent' }` (`'skipped'` if `BACKUP_HEARTBEAT_URL` is unset), and a new file in `/backups`. CI runs this same command inside every built image (`scripts/smoke-image.sh`).

## Verifying dump integrity

Every dump is checked with `pg_restore --list` before it gets its final name. That reads the archive's header and table of contents, not every data block. To prove a dump restores, rehearse on a throwaway server, never on the live database:

```bash
docker run -d --rm --name hm-restore-drill -e POSTGRES_PASSWORD=drill pgvector/pgvector:pg18
until docker exec hm-restore-drill psql -h 127.0.0.1 -U postgres -c 'select 1' >/dev/null 2>&1; do sleep 1; done
docker exec -i hm-restore-drill pg_restore --no-owner --no-privileges --exit-on-error --single-transaction -U postgres -d postgres < "$DUMP"
docker exec hm-restore-drill psql -U postgres -c 'SELECT count(*) FROM items;'
docker stop hm-restore-drill
```

(`-h 127.0.0.1` in the wait loop: during first boot the image runs a temporary socket-only server, then restarts. TCP answers only once the real server is up.)

## Postgres major version dependency

The Dockerfile installs `postgresql18-client` to provide `pg_dump` / `pg_restore`. **When you upgrade Postgres major** (18 → 19), bump the Dockerfile package name in lockstep, because `pg_dump` from an older major can't dump from a newer server. The image smoke test runs the backup job against `PG_IMAGE`, so a mismatch fails CI. The integration round-trip test uses the host's `pg_dump`, which must also be ≥ the server major (see `docs/TESTING.md`).

## Risks

- **A dump passes `pg_restore --list` but cannot be restored.** The job's check reads the table of contents, not every data block. Mitigation: the CI round-trip test proves the format and flags restore cleanly, and the drill above proves a specific dump.
- **`/backups` overlap with another backup tool.** If your `BACKUP_DIR` is also covered by another backup root (e.g., Time Machine), you may get duplicate work. Audit your backup sources.
- **Daily backup missed during a long outage.** If the worker is down at 03:00 UTC, that day's dump never happens, and nothing re-runs it. Existing dumps are safe: pruning only runs after a successful dump. The heartbeat monitor alerts about 25 hours after the last good dump.
- **Error reporting is not the alert.** A failed dump calls `Sentry.captureException`, which does nothing unless `SENTRY_DSN` is set (see `observability.md`). The heartbeat monitor does not depend on it.
````

- [ ] **Step 2: Check the quoting by eye, then with a dry run in dev**

Every `sh -c` argument must be single-quoted on the host. Confirm with:

```bash
grep -n "sh -c" docs/backups.md
```

Every hit should read `sh -c '…'`. Then dry-run the only side-effect-free commands against the dev stack. **Do not run steps 2–7 against any database you care about.**

```bash
docker compose up -d db
DB=$(docker compose ps -aq db)
docker exec "$DB" sh -c 'echo "user=$POSTGRES_USER db=$POSTGRES_DB"'   # expands INSIDE the container
docker exec "$DB" sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "SELECT current_user, \"$POSTGRES_DB\" IS NULL;"' 2>&1 | head -3
```

The first command prints the dev values. The second errors with `column "housemanager" does not exist` (or your DB name). That is fine: it proves the `\"$POSTGRES_DB\"` quoting reaches SQL as a quoted identifier, the same form the runbook's `ALTER`/`CREATE`/`DROP` statements use.

- [ ] **Step 3: Commit**

```bash
git add docs/backups.md
git commit -m "docs(backups): working restore runbook, dead-man monitoring, accurate failure behaviour"
git log --oneline -1   # confirm HEAD moved
```

---

### Task 7: Full verification

- [ ] **Step 1: The pre-push gate**

```bash
pnpm verify
```

Expected: Biome, `lint:tokens`, `lint:worker-graph` and `lint:knip` pass; `tsc --noEmit` is clean; every unit test passes, including the 22 in `worker/jobs/pg-dump.test.ts` and 9 in `tests/unit/env.test.ts`.

- [ ] **Step 2: Every touched integration file, plus a stack-shape canary**

```bash
pnpm exec vitest run tests/integration/pg-dump-restore.test.ts tests/integration/migration-invariants.test.ts tests/integration/health.test.ts
```

Expected: all pass.

- [ ] **Step 3 (optional): coverage floor**

This PR adds tests and no untested code, so the merged floor can only rise. To check locally anyway: `pnpm test:coverage:check`. **Never lower a threshold in `vitest.config.ts`.**

No e2e run is needed: nothing under `app/` or `components/` changed.

---

### Task 8: Owner steps (list only — the implementer does NOT do these)

These run outside this repo. Hand them to the owner in the PR body.

1. **Create the uptime-kuma Push monitor** as in `docs/backups.md` § Monitoring: Push type, Heartbeat Interval `90000`, Retries `0`. **Prefer the internal URL** `http://uptime-kuma:3001/api/push/<token>?status=up&msg=OK&ping=`. Uptime-kuma and `housemanager-worker` share the `dockge_default` network, so the ping never leaves the host or depends on SWAG/Cloudflare. `httpUrlSchema` accepts `http://`.
2. **Wire it into docker-piwine through the normal flow.** Store the URL as a new field on the `piwine-housemanager` 1Password item. Add a `HOUSEMANAGER_BACKUP_HEARTBEAT_URL=op://…` reference to `compose.env`. Add `BACKUP_HEARTBEAT_URL: ${HOUSEMANAGER_BACKUP_HEARTBEAT_URL}` to the **`housemanager-worker`** `environment` in `housemanager/compose.yaml`, following the style of the existing `HOUSEMANAGER_*` keys. Open that as a docker-piwine PR. Don't source `compose.env` over SSH; `op run` with `${VAR}` placeholders is the pattern.
3. **After the image with this PR is deployed** (via the docker-piwine digest bump; prod was on `sha-b7a87cd` at review time), send the first ping with the manual smoke command from `docs/backups.md` and watch the monitor turn green:
   `docker exec housemanager-worker node_modules/.bin/tsx -e "import('./worker/jobs/pg-dump').then((m) => m.handlePgDump()).then(console.log)"`
4. **Read-only look at the prod backup dir** for damage the old job may already have done: `ls -la ${APPDATA_PATH}/config/housemanager/backups`. Zero-byte `housemanager-*.dump` files are cleaned up by the first successful run after deploy. If *no* non-empty dump is present, take one now (step 3) rather than waiting for 03:00.
5. **Once, when convenient:** rehearse a restore with the drill in `docs/backups.md` § Verifying dump integrity, against a throwaway container, never prod.

---

### Task 9: PR

- [ ] **Step 1: Rebase on current `main`**

```bash
git fetch origin
git rebase origin/main
```

Resolve any conflicts (never `--no-verify`). The only likely overlap is the `docs/README.md` env table, if the D-H1 "quick wins" PR lands first: keep both sets of rows. If anything was rebased, rerun Task 7 Steps 1–2.

- [ ] **Step 2: Copy this plan into the repo, and check it for invisible characters first**

```bash
python3 - <<'EOF'
import sys, unicodedata
p = '.full-review/plans/2026-09-24-backup-integrity.md'
bad = [(i + 1, f'U+{ord(c):04X}') for i, line in enumerate(open(p, encoding='utf-8'))
       for c in line if unicodedata.category(c) in ('Cf', 'Zl', 'Zp') or (unicodedata.category(c) == 'Zs' and c != ' ')]
print(bad or 'clean'); sys.exit(1 if bad else 0)
EOF
cp .full-review/plans/2026-09-24-backup-integrity.md docs/superpowers/plans/2026-09-24-backup-integrity.md
git add docs/superpowers/plans/2026-09-24-backup-integrity.md
git commit -m "docs(plans): backup integrity implementation plan"
git log --oneline -1   # confirm HEAD moved
```

Expected: `clean`. If it lists code points, replace those characters in the source plan with plain ASCII, then copy.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin fix/backup-integrity
gh pr create --title "fix(backup): atomic validated dumps, dead-man heartbeat, working restore runbook" --body "$(cat <<'EOF'
Fixes the review's P0 "backups can fail silently and can't be restored by the runbook" (O-M4, O-H1 backup slice, DOC-H2, O-L5, T-M7) plus O-M5.

- **O-M4** `pg_dump` now writes `.housemanager-<ISO>.dump.partial`. The file must be non-empty and pass `pg_restore --list` with table data in it, and only then is it renamed into place. Any failure deletes the temp file and throws **before** pruning, so failing nights can never evict a good dump. Retention counts only non-empty `housemanager-*.dump`. Legacy 0-byte dumps and day-old `.partial` leftovers are cleaned after a success.
- **O-H1 (backup slice)** New optional `BACKUP_HEARTBEAT_URL` (worker). The job GETs it after each validated dump, fail-soft with a 10s timeout, and never after a failure, so an uptime-kuma Push monitor goes red by silence. Success logs `event: pg-dump.completed` with `sizeBytes` and `durationMs`. Sentry wiring is a separate PR.
- **DOC-H2 / O-L5** Restore runbook rewritten. Plain `docker exec` into the DB container (no `compose run`, no secrets), variables expand inside the container, one DDL statement per `psql`, the old DB is renamed aside so the restore can be undone, `--single-transaction --exit-on-error`, and the dump is fed on stdin. Failure/retry/retention behaviour is described accurately.
- **T-M7** `worker/jobs/pg-dump.test.ts` covers the orchestration. New `tests/integration/pg-dump-restore.test.ts` runs the real job with host `pg_dump`/`pg_restore` 18, restores into a second fresh Postgres with the runbook's flags, and compares every table's rows, every CHECK (incl. all 9 hand-written), every index (incl. 5 NULLS NOT DISTINCT + IVFFlat), the `pgboss` schema and a probe queue, `vector`, and `prisma migrate status`. Mutation-checked: a `--section=pre-data` restore fails 4 of 7. Heartbeat errors log only `err.name` + `cause.code` (undici messages can contain the URL), and tonight's dump is never a prune candidate (clock step-back).
- **O-H1 item 4** `scripts/smoke-image.sh` runs the backup job inside the built image against `PG_IMAGE`.
- **O-M5** `db-backups` ignored in `.gitignore` and `.dockerignore` (public repo).

**Owner steps after merge** (not in this PR):
1. uptime-kuma: Push monitor, Heartbeat Interval 90000, Retries 0. Prefer the internal URL `http://uptime-kuma:3001/api/push/<token>?status=up&msg=OK&ping=` (same `dockge_default` network).
2. docker-piwine: 1Password field, then `HOUSEMANAGER_BACKUP_HEARTBEAT_URL` in `compose.env`, then `BACKUP_HEARTBEAT_URL: ${HOUSEMANAGER_BACKUP_HEARTBEAT_URL}` on `housemanager-worker` only.
3. After the digest bump deploys this image, send the first ping: `docker exec housemanager-worker node_modules/.bin/tsx -e "import('./worker/jobs/pg-dump').then((m) => m.handlePgDump()).then(console.log)"`.
4. Read-only `ls -la` of the prod backup dir. The first successful run cleans up any 0-byte dumps.

Plan: `docs/superpowers/plans/2026-09-24-backup-integrity.md`.

Test plan: `pnpm verify`; `pnpm exec vitest run tests/integration/pg-dump-restore.test.ts tests/integration/migration-invariants.test.ts tests/integration/health.test.ts`; CI image smoke test.
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

**Sourcery is budget-limited this week.** The check reports pass/skipping even when it hit its per-PR (150k) or weekly (500k) limit, so read the review **body**. If the body says it was rate-limited or skipped, there is nothing to address. Otherwise address real comments with new commits (explicit `git add`, verify HEAD moved, push). If Sourcery doesn't show up within about 20 minutes, check the PR page directly and continue.

- [ ] **Step 5: Enable auto-merge, then watch CI (background)**

```bash
gh pr merge --auto --squash
gh pr checks --watch --fail-fast   # run_in_background: true
```

On a failure, fix it, push, and watch again. The most likely CI-only failure is the integration preflight. If it says `pg_dump is not on PATH` or reports a major below 18, the runner image changed. Add a `sudo apt-get install -y postgresql-client-18` step to the `integration` job (PGDG), rather than skipping the test.

Once merged:

```bash
gh pr view --json state --jq .state      # expect MERGED
git checkout main && git pull --ff-only && git branch -d fix/backup-integrity
```

---

## Acceptance criteria

- [ ] A failed `pg_dump` (or an empty or unreadable dump) leaves no `housemanager-*.dump` and no `.partial`, deletes nothing, sends no heartbeat, and throws.
- [ ] Retention keeps the newest 7 **non-empty** dumps and runs only after a successful dump. Files outside the pattern are never touched.
- [ ] With `BACKUP_HEARTBEAT_URL` set, a validated dump GETs it once. A monitor error or timeout never fails the job. Neither the URL nor any error message that could contain it is ever logged.
- [ ] The dump a run just made is never pruned by that run, whatever the file mtimes say.
- [ ] `tests/integration/pg-dump-restore.test.ts` restores a real dump into a fresh server with rows, all CHECKs, all indexes (incl. NULLS NOT DISTINCT + IVFFlat), the `pgboss` schema, `vector` and migration state identical. It runs in CI.
- [ ] The image smoke test runs the backup job inside the built image.
- [ ] Every command in `docs/backups.md` is correct for both dev compose and a production compose with fixed container names, needs no secrets, and never uses `docker compose run`.
- [ ] `db-backups` is ignored by git and excluded from the Docker build context.
- [ ] `pnpm verify` is green.

## Deliberately out of scope

- **Setting `SENTRY_DSN` in prod, `onRequestError`, the Pino→Sentry bridge** (O-H1 item 3, D-M2, O-M6): the P1 observability PR. `Sentry.captureException` on failure is kept as-is.
- **Heartbeats for `reminders.tick` and `search.reindex`** (O-H1 item 1) and job freshness in `/api/health` (item 2). If they come, lift `pingHeartbeat` into `lib/` rather than copying it.
- **A retry delay for `pg-dump`** (`QUEUE_POLICY`). Today's 3 immediate attempts all land inside one DB blip. `{ retryLimit: 2, retryDelay: 300 }` would be a one-line follow-up with a `tests/integration/queue-policy.test.ts` update, but it changes queue policy, so it deserves its own review.
- **A pre-migration dump at deploy** (O-M1).
- **Listing all required monitors in `docs/observability.md`** (O-H1 item 5). `docs/backups.md` § Monitoring covers this one.
- **The monitor's own blind spot.** Uptime-kuma runs on the same host as the app, so a dead host alerts no one. That is homelab work.
- **Extending `migration-invariants.test.ts`** with the 5 objects it omits. The round-trip test now asserts them against the freshly migrated source as well.
