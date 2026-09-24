# Backups

The worker writes a Postgres logical dump to `/backups` (in-container) every day at 03:00 UTC. The container path is bind-mounted to the host directory specified by `BACKUP_DIR` in `docker-compose.yml` (defaults to `./db-backups`, which is git- and docker-ignored). Duplicacy backs that host directory up off-host on its own schedule.

## What's protected

- **Postgres (housemanager DB)**: daily logical dumps via `pg_dump --format=custom`
- **Attachments (FILES_DIR)**: protected via Duplicacy's existing coverage of the appdata folder; this app does nothing extra
- **Meilisearch index**: NOT backed up; rebuildable from Postgres (Settings → Rebuild search index, or the nightly `search.reindex`)

## How a dump is made

`worker/jobs/pg-dump.ts`, in order:

1. `pg_dump` writes to a hidden temp file, `/backups/.housemanager-<ISO>.dump.partial`. It's given `--lock-wait-timeout=60s`, so a held table lock fails the run promptly instead of queueing silently behind it, and the process itself is killed (`SIGKILL`) if it runs past 10 minutes — comfortably under pg-boss's 15-minute attempt expiry, so a wedged `pg_dump` fails clean (temp file removed) rather than hanging forever while every daily retry piles on another one.
2. The temp file must be non-empty, and `pg_restore --list` (also bounded, 2 minutes) must read it and find table data in it.
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
