# House Manager

Self-hosted home information manager. See `superpowers/specs/2026-04-26-house-manager-design.md` for the full design and `superpowers/plans/` for implementation plans.

## Stack

- Next.js 16 (App Router, RSC) + TypeScript 7 (strict) — see [TypeScript toolchain](#typescript-toolchain)
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

### Health endpoints

| Endpoint | Served by | Contract |
|---|---|---|
| `/api/health` | **both** web and worker, on port 3000 | Container health. Postgres unreachable → 503. Meilisearch unreachable → still 200, reported in `checks.meilisearch`. The worker additionally reports 503 when its queue heartbeat goes stale. |
| `/api/health/ready` | web only | Strict readiness — db *and* meilisearch must both answer. |

The Dockerfile `HEALTHCHECK` probes `/api/health`. Both roles run from the same
image and both bind 3000; there is no collision because each container has its
own network namespace, which is what lets a single `HEALTHCHECK` line be correct
for both without role detection or an extra env var.

Meilisearch is deliberately non-fatal: search is eventually consistent by design
(`enqueueSearchIndex` swallows its errors and the nightly `search.reindex`
rebuilds the index), so a Meilisearch outage degrades search rather than marking
a container unhealthy — and the worker keeps running through it.

**Docker only probes running containers.** A container that crash-loops during
boot never leaves `starting` and never reports `unhealthy`, so alerting must
treat *anything other than `healthy`* as down. Waiting for `unhealthy` will miss
exactly the failure this healthcheck was added for.

For local development, `pnpm dev` and `pnpm worker:dev` both want port 3000 on
one host. Set `WORKER_HEALTH_PORT` (see `.env.example`) to move the worker's
health server aside. Containers leave it unset.

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

## TypeScript toolchain

`package.json` carries a single, plain TypeScript entry:

```jsonc
"typescript": "7.0.2"   // the Go port; owns bin `tsc`
```

`pnpm typecheck` (`tsc --noEmit`) is the only `tsc` invocation, and no first-party code
imports the `typescript` JS API.

### Why this used to be two aliased entries

Until Next 16.3 the repo installed TypeScript 6 and 7 side by side:

```jsonc
"@typescript/native": "npm:typescript@7.0.2",       // the Go port; owned bin `tsc`
"typescript": "npm:@typescript/typescript6@6.0.2",  // shim re-exporting the TS 6 JS API
```

TypeScript 7 is the Go rewrite and ships **no JavaScript API**. Next.js 16.2 and earlier
loaded `next.config.ts` through that API, so a plain bump to `typescript@7` built fine
locally but killed the dev server (`"It looks like you're trying to use TypeScript but do
not have the required package(s) installed"`) and timed out the Playwright `webServer`.
See PR #281 for the failure and #290 for the split.

The split bought back the speed (`pnpm typecheck` 7.78s → 1.29s) by letting `tsc` resolve
to TS 7 while `import ... from 'typescript'` still resolved to a TS 6 API.

### What changed in Next 16.3

Next added `experimental.useTypeScriptCli` (vercel/next.js#95639) specifically to support
TypeScript 7 while its JS API is unavailable, and made it the default in #96497. Two
consequences:

- `next build` runs the project-local `tsc` **binary** instead of loading the JS API. The
  old caveat that `next build` re-typechecked against TS 6 (~13s) no longer applies — the
  whole toolchain is now TS 7.
- `next.config.ts` is transpiled via Node native type-stripping with an SWC fallback, not
  the TS API.

That removed the last reason for the split, and #388 collapsed it. Before doing so, every
package previously named as a JS-API consumer was re-checked:

| Claimed consumer | Reality |
|---|---|
| Next.js | `tsc` CLI + SWC/native type-stripping as of 16.3 |
| Prisma | `typescript` is an *optional* peer; `prisma generate` runs fine on TS 7 |
| `@auth/prisma-adapter` | declares no `typescript` dependency or peer at all |
| shadcn | uses `ts-morph` → `@ts-morph/common`, which bundles its own TypeScript |

If a future dependency genuinely needs the TS 6 JS API, re-add the shim under an alias
(`"@typescript/typescript6": "npm:@typescript/typescript6@6.x"`) rather than downgrading
the `typescript` entry — and note that pinning `typescript` back to 6 while leaving
Next's `useTypeScriptCli` at its default is fine, but setting that flag to `false` while
on TS 7 hard-fails the build.

## Further docs

- [`docs/TESTING.md`](TESTING.md) — test tiers, decision matrix, per-feature checklist, `@critical` policy, coverage floor.
- [`docs/observability.md`](observability.md) — logging (Pino) and error reporting (Sentry/GlitchTip).
- [`docs/backups.md`](backups.md) — pg_dump backups, sweeper, missed-tick recovery.

## Architecture notes

- **Auth gate**: `app/(app)/layout.tsx` is the sole authentication boundary. Protected routes must live under that route group. `middleware.ts` was removed in Task 12 due to an Auth.js v5 JWE-vs-database-session incompatibility; if Plan 2+ adds many protected route groups, switch to JWT sessions and re-introduce middleware.
- **Worker**: runs via `tsx` directly in both dev and prod (no compile step). Avoids the path-alias / ESM-extension friction between tsc-emitted JS and Node ESM.
- **Env validation**: `lib/env.ts` exports a lazy `getEnv()` (Zod-validated). Eager validation would break tests on import; the lazy pattern fails fast at first call but doesn't fire during module load.
- **Dependency pinning**: exact-pinned (`x.y.z`, no range prefix), including `engines` and `packageManager`; `pnpm-workspace.yaml` enforces `savePrefix: ""`. Renovate (`renovate.json`, extending `github>owine/renovate-config`) drives updates with `rangeStrategy: pin`, and owns the release-age soak — pnpm's `minimumReleaseAge` is deliberately unset to avoid double-gating.
- **Commit signing**: SSH signing via 1Password's `op-ssh-sign` is enabled; `commit.gpgsign=true` in repo config.

## Plans status

- [x] Plan 1: Foundation
- [x] Plan 2a: Core CRUD entities
- [x] Plan 2b: Attachments / file uploads
- [x] Plan 2c: Attachment links
- [x] Plan 3: Reminders, Web Push, email, iCal feed
- [x] Plan 4a: Find — Meilisearch keyword search
- [x] Plan 4ab: UI redesign — design system, navigation, page templates
- [x] Plan 4b: Suggest — AI structured generation
- [x] Plan 4c: Ask — RAG over user documents + OCR (pgvector + Voyage + Tesseract.js)
- [x] Plan 5a: Observability (Pino + Sentry)
- [x] Plan 5b: Reliability (pg-dump backup, notify-log sweep, missed-tick recovery)

Organically shipped alongside the numbered plans:
- [x] Systems: System entity + multi-target events + multi-vendor links
- [x] Inbox: inbound email ingestion + classify + auto-stub draft service records
