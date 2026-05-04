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

```env
BACKUP_DIR=/srv/duplicacy-source/house-manager/db-backups
```

If unset, it defaults to `./db-backups` (relative to the docker-compose.yml directory).

## Restoring

### Postgres

1. Stop the running app + worker:
   ```bash
   docker compose stop web worker
   ```
2. Drop the existing database (DESTRUCTIVE):
   ```bash
   docker compose exec db psql -U $POSTGRES_USER -d postgres \
     -c "DROP DATABASE housemanager; CREATE DATABASE housemanager OWNER $POSTGRES_USER;"
   ```
3. Restore from dump (use the most recent dump in `/backups` or recover an older one from Duplicacy):
   ```bash
   docker compose run --rm worker \
     pg_restore --clean --if-exists --no-owner --no-privileges \
       --dbname=$DATABASE_URL /backups/housemanager-<ISO>.dump
   ```
4. Restart:
   ```bash
   docker compose up -d
   ```

### Attachments (FILES_DIR)

Restore the appdata folder from Duplicacy alongside the database. The DB stores file paths relative to FILES_DIR; without the file blobs, attachments will 404. Restore both together — never restore one without the other.

## Manual smoke test (after deployment)

To verify the backup job works without waiting until 03:00 UTC:

```bash
docker compose exec worker \
  pnpm exec tsx -e "import('./worker/jobs/pg-dump').then(m => m.handlePgDump()).then(console.log)"
```

Expected output: `{ file: 'housemanager-...dump', pruned: 0 }` and a new file in `/backups`.

## Verifying dump integrity

Periodically test that a dump can actually be read back. List its contents without restoring:

```bash
docker compose exec worker pg_restore --list /backups/housemanager-<ISO>.dump | head
```

Expected: a list of database objects (tables, indexes, etc.). If `pg_restore --list` errors, the dump is corrupt.

## Postgres major version dependency

The Dockerfile installs `postgresql16-client` to provide `pg_dump` / `pg_restore`. **When you upgrade Postgres major** (16 → 17), bump the Dockerfile package name in lockstep — `pg_dump` from a different major won't dump from a newer database.

## Risks

- **Backup completes but is corrupt.** `pg_dump` could succeed without producing a usable dump (e.g., disk full mid-write). Mitigation: periodic `pg_restore --list` smoke-check (see above).
- **`/backups` overlap with another backup tool.** If your `BACKUP_DIR` is also covered by another backup root (e.g., Time Machine), you may get duplicate work. Audit your backup sources.
- **Daily backup missed during long outage.** If the worker is down at 03:00 UTC, the daily backup doesn't fire. The previous day's dump is still in `/backups` until pruned (~7 days later). Acceptable; Duplicacy still has yesterday's.
