# House Manager

Self-hosted home information manager. See `superpowers/specs/2026-04-26-house-manager-design.md` for the full design and `superpowers/plans/` for implementation plans.

## Stack

- Next.js 16 (App Router, RSC) + TypeScript 6 (strict)
- Auth.js v5 with Authelia OIDC (database session strategy via Prisma adapter)
- Prisma 7 + Postgres 16 + pgvector
- Meilisearch 1.42 (unified `house` index across items, vendors, notes, services, reminders, attachments)
- pg-boss 12 worker (reminders tick, notify, search-index sync, thumbnails)
- Biome 2 (lint + format), Vitest 4 (unit + integration via Testcontainers), Playwright (E2E with mock OIDC)

## Quick start (development)

```bash
cp .env.example .env
# Edit .env: set AUTH_SECRET, MEILI_KEY/MEILI_MASTER_KEY, and Authelia OIDC vars.
pnpm install
docker compose up -d db meilisearch
pnpm db:migrate           # creates the local DB schema on first run
pnpm dev                  # web (in one terminal)
pnpm worker:dev           # worker (in another)
```

The first run prompts for `pnpm exec lefthook install` to wire git hooks; subsequent commits run `biome check --staged` and `tsc --noEmit` automatically.

## Production (full stack via Docker Compose)

```bash
docker compose up -d --build
```

This brings up `db`, `meilisearch`, `web`, and `worker`. The `web` service runs `pnpm db:deploy` on startup (idempotent), then `pnpm start`. The `worker` runs `pnpm worker:start` (`tsx worker/index.ts`).

Health endpoints (web): `/api/health` (liveness), `/api/health/ready` (db + meilisearch reachable).

## Environment variables

Validated at startup by `lib/env.ts` (Zod). The app fails fast on first `getEnv()` call if any required var is missing or malformed.

### Required at runtime

| Var | Constraint | Notes |
|---|---|---|
| `DATABASE_URL` | URL | Postgres connection string |
| `AUTH_SECRET` | ≥ 32 chars | Auth.js session signing key (`openssl rand -base64 32`) |
| `AUTH_OIDC_ISSUER` | URL | Authelia issuer URL |
| `AUTH_OIDC_CLIENT_ID` | non-empty | OIDC app id |
| `AUTH_OIDC_CLIENT_SECRET` | non-empty | OIDC app secret |
| `MEILI_HOST` | URL | e.g. `http://meilisearch:7700` |
| `MEILI_KEY` | non-empty | Meilisearch API key |
| `FILES_DIR` | non-empty | Attachment storage path; mounted as a volume in compose |
| `WEB_PUSH_VAPID_PUBLIC_KEY` | non-empty | Web Push (generate with `pnpm dlx web-push generate-vapid-keys`) |
| `WEB_PUSH_VAPID_PRIVATE_KEY` | non-empty | Web Push private key (pair with public above) |
| `WEB_PUSH_CONTACT_EMAIL` | `mailto:` prefix + valid email | e.g. `mailto:admin@example.com` |
| `FORWARDEMAIL_API_KEY` | non-empty | Reminder email delivery |
| `FORWARDEMAIL_FROM_ADDRESS` | non-empty | Sender address |

### Optional

| Var | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` (Zod) / `production` (set by Dockerfile in built image) | |
| `APP_URL` | unset | Used for absolute links in emails / push payloads |
| `AUTH_URL` | unset | Consumed by Auth.js itself (not in the Zod schema). Set when fronted by a reverse proxy that needs an explicit base URL |

### Set automatically by the Docker image

You don't pass these at runtime — they're baked into the image at build time.

| Var | Source | Notes |
|---|---|---|
| `NODE_ENV=production` | Dockerfile `ENV` | |
| `NEXT_TELEMETRY_DISABLED=1` | Dockerfile `ENV` | |
| `GIT_SHA` | `--build-arg GIT_SHA=...` | Server-side commit SHA. CI passes `${{ github.sha }}`; local builds default to `unknown`. Mirrors `org.opencontainers.image.revision` label |
| `NEXT_PUBLIC_GIT_SHA` | same `--build-arg` | Build-time only; inlined into the client JS bundle when any source file reads `process.env.NEXT_PUBLIC_GIT_SHA` |

### Compose-only (consumed by the `db` and `meilisearch` services, not the app)

| Var | Used by |
|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `db` service. The app reads `DATABASE_URL` instead |
| `MEILI_MASTER_KEY` | `meilisearch` service. The app reads `MEILI_KEY` |

> **Note:** the checked-in `.env.example` is somewhat stale (predates the `WEB_PUSH_VAPID_*` rename and includes a never-shipped `VOYAGE_API_KEY`). Trust this README until that file is refreshed.

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | Next.js dev server (turbo-prepended) |
| `pnpm build` | Production Next.js build |
| `pnpm start` | Run the production build |
| `pnpm worker:dev` / `pnpm worker:start` | Run the worker via tsx |
| `pnpm lint` / `pnpm lint:fix` / `pnpm format` | Biome |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test:unit` | Vitest unit + lib tests |
| `pnpm test:integration` | Vitest + Testcontainers (real Postgres + Meilisearch) |
| `pnpm test:e2e` | Playwright E2E with mock OIDC |
| `pnpm verify` | lint + typecheck + test:unit (run before pushing) |
| `pnpm db:generate` / `db:migrate` / `db:deploy` / `db:seed` | Prisma |

## Architecture notes

- **Auth gate**: `app/(app)/layout.tsx` is the sole authentication boundary. Protected routes must live under that route group. `middleware.ts` was removed in Task 12 due to an Auth.js v5 JWE-vs-database-session incompatibility; if Plan 2+ adds many protected route groups, switch to JWT sessions and re-introduce middleware.
- **Worker**: runs via `tsx` directly in both dev and prod (no compile step). Avoids the path-alias / ESM-extension friction between tsc-emitted JS and Node ESM.
- **Env validation**: `lib/env.ts` exports a lazy `getEnv()` (Zod-validated). Eager validation would break tests on import; the lazy pattern fails fast at first call but doesn't fire during module load.
- **Dependency pinning**: tilde-pinned to semver patch (`~x.y.z`); `.npmrc` enforces `save-prefix=~`. Renovate (`renovate.json5`) drives updates with `rangeStrategy: bump`.
- **Commit signing**: SSH signing via 1Password's `op-ssh-sign` is enabled; `commit.gpgsign=true` in repo config.

## Plans status

- [x] Plan 1: Foundation
- [x] Plan 2a: Core CRUD entities
- [x] Plan 2b: Attachments / file uploads
- [x] Plan 2c: Attachment links
- [x] Plan 3: Reminders, Web Push, email, iCal feed
- [x] Plan 4a: Find — Meilisearch keyword search
- [ ] Plan 4b: Suggest — AI structured generation (spec + plan landed; implementation pending)
- [ ] Plan 4c: Ask — RAG over user documents + OCR
- [ ] Plan 5: Polish & Operations
