# Remove the prod `-migrate` container

**Status:** Draft
**Date:** 2026-05-24

## Problem

The prod compose file (on the deploy host — outside this repo, e.g. `/opt/compose/compose.yml`) currently runs a short-lived `house-manager-migrate` service that executes `sh -c "pnpm db:deploy && pnpm db:seed"` once on each `docker compose up`. The `web` and `worker` services wait for it via `depends_on: <migrate>: service_completed_successfully` before starting.

The in-repo `docker-compose.yml` (used for local dev) does *not* have this container — `web.command` is `sh -c "pnpm db:deploy && pnpm db:seed && pnpm start"`, running migrations + seed inline as part of `web` startup. The dev compose and prod compose have diverged in shape for no operational benefit.

Goal: collapse the prod `-migrate` container by folding its work into `web`'s startup, so the prod compose structurally matches the dev compose and one container is removed.

## Approach

Make `web` own migration + seed in prod, the same way it already does in dev. Worker waits on web's healthcheck instead of the now-removed `-migrate` container.

```
db ──► web (sh -c "pnpm db:deploy && pnpm db:seed && pnpm start")
              │
              ▼  (depends_on: web: service_healthy)
              worker
```

### Why this shape

- **No new abstractions.** No entrypoint script, no leader-election logic, no out-of-band operator step. Just a `command:` change and a `depends_on:` re-target.
- **Prod = dev.** The in-repo `docker-compose.yml` already runs migrations this way; the deploy host will use the same shape.
- **Failure mode preserved.** A failed migration → web exits non-zero → docker restart-loops it → worker never sees a healthy web → worker stays parked. Same failure surface as today; logs live in `docker compose logs web` instead of a separate `-migrate` service.
- **Solo self-hoster context.** Multi-replica `web` deployments would race on migrations — irrelevant here (single web replica). Per [user_profile](memory:user_profile) this is a single-host deploy.

## Changes

### 1. Prod compose file (deploy host)

Remove the `migrate` (or `-migrate` / `house-manager-migrate`) service entirely.

Update `web`:
- `command: sh -c "pnpm db:deploy && pnpm db:seed && pnpm start"`
- `depends_on:` keep `db: service_healthy`; remove the `<migrate>: service_completed_successfully` line.
- `healthcheck.start_period:` raise to `120s` so a future longer migration set doesn't trip an early healthcheck failure. The healthcheck itself (`curl -fsS http://localhost:3000/api/health`, interval 30s, retries 3) is unchanged.

Update `worker`:
- `depends_on:` remove `<migrate>: service_completed_successfully`; add `web: { condition: service_healthy }`. Worker also keeps `db: service_healthy`.

The image referenced by `web` and `worker` already contains everything needed to run `prisma migrate deploy` and `prisma db seed` — see `Dockerfile:86-94` (prisma schema, migrations, config, and the `tsx` runner for the seed). No image change required.

### 2. In-repo `docker-compose.yml`

No change. Already in target shape (line 70: `command: sh -c "pnpm db:deploy && pnpm db:seed && pnpm start"`).

Optional clarity tweak: bump local `web.healthcheck.start_period` from `30s` to `120s` to match prod. Not strictly necessary — dev migrations are fast — but keeping the two compose files identical on this field is one fewer source of dev/prod drift.

### 3. Repo docs

Update `docs/README.md` deploy section (if it documents the `-migrate` container) to describe the new shape. Spot-check `docs/backups.md` for any mention of the migrate container's role in restore flows — there shouldn't be one, but verify.

### 4. Memory / runbook hygiene

Note in the PR description that operators following the old "wait for `-migrate` to exit 0 before tailing web logs" runbook now look at `web` logs directly from `docker compose up -d`.

## Cutover

This is a deploy-host-only change. The repo PR carries the docs + (optional) local-compose start_period bump; the prod compose edit happens on the host with operator credentials. Sequence:

1. Merge the docs PR.
2. On the deploy host, edit the prod compose file (`-migrate` service removal + `web`/`worker` changes described above).
3. `docker compose down` (stops all services; safer than `up -d` mid-edit because dependency graph changes).
4. `docker compose pull && docker compose up -d`.
5. Tail `docker compose logs -f web` and watch for: `prisma migrate deploy` output (no pending migrations expected — they ship with the image), seed output, then "ready - started server on …".
6. Once web is healthy, worker starts automatically; tail `docker compose logs -f worker` to confirm.
7. Verify `/api/health` returns 200 and a sample request works through to the DB.

Per [feedback_op_run_secrets](memory:feedback_op_run_secrets), give the operator the `${VAR}`-placeholder commands rather than sourcing `compose.env` over SSH.

## Out of scope

- Changing what `pnpm db:deploy` or `pnpm db:seed` do.
- Moving seed out of compose startup (a future change could make seed opt-in, but the current "seed every restart" idempotency is preserved).
- Multi-replica web (still a single replica per [user_profile](memory:user_profile)).
- Postgres advisory-lock guards around migration (not needed for single-replica web).
- Rolling-deploy / zero-downtime migration semantics (out of scope for solo self-hosted; current behavior is brief web downtime during restart, which is acceptable).
- Touching CI / GHCR build pipelines — the image already ships everything needed.

## Risks

- **Slow migration trips healthcheck.** Mitigation: `start_period: 120s` (Section 1). If a single migration ever crosses 2 minutes, web restart-loops indefinitely. At that point a separate `-migrate` shape would be reconsidered. Today's migration set runs in well under a second.
- **Seed-on-every-restart is non-idempotent.** Assumption preserved from current dev/prod parity; if seed ever stops being idempotent, this design breaks. Mitigation: the change doesn't introduce this risk (already exists in dev compose), but worth verifying once during cutover by checking the seed log on a second `docker compose restart web`.
- **Worker stranded if web crashlooping.** Acceptable: worker has nothing useful to do if web (and therefore the schema migrations web owns) is broken.

## Open questions

None — design is small and the trade-offs are explicit.
