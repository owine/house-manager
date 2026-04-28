# House Manager

Self-hosted home information manager. See `superpowers/specs/2026-04-26-house-manager-design.md` for the full design and `superpowers/plans/` for implementation plans.

## Stack

- Next.js 15 (App Router, RSC) + TypeScript 5 (strict)
- Auth.js v5 with Authelia OIDC (database session strategy via Prisma adapter)
- Prisma 7 + Postgres 16 + pgvector
- Meilisearch (typo-tolerant search; integration arrives in Plan 4)
- pg-boss worker (no jobs registered yet; arrives in Plan 3)
- Biome (lint + format), Vitest (unit + integration), Playwright (E2E with mock OIDC)

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
- [ ] Plan 2: Core CRUD + Attachments
- [ ] Plan 3: Reminders, Checklists & Notifications
- [ ] Plan 4: AI (Find, Ask, Suggest, OCR)
- [ ] Plan 5: Polish & Operations
