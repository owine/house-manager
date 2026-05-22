# Testing

The app has four test surfaces — **unit**, **integration**, **e2e**, and **smoke** — wired into a deliberate lean-CI / thorough-local split. Per-PR CI runs a fast gate; the full suite runs locally before merge; the smoke tests (which call the real Anthropic API) are opt-in and never run in PR CI.

## Tiers — when to run what

| Tier | Command | What it runs | When |
|---|---|---|---|
| PR gate (CI) | (automatic on push / PR) | lint, typecheck, migrate-check, ggshield, **unit**, **integration**, and **e2e `@critical` only** | Every push and PR. Heavy jobs skip on docs-only changes (see CI tiers below). |
| Pre-merge (local) | `pnpm test:local` | unit → integration → **full** e2e → coverage check | Before opening a PR / before merge. The umbrella command. |
| Smoke (opt-in) | `pnpm test:smoke` | Real-Anthropic-API contract checks | Manually, when touching AI prompt/response code or verifying the live contract. Needs `ANTHROPIC_API_KEY`. Never in PR CI. |

`pnpm test:local` is the single command to run before merge — it chains `test:unit && test:integration && test:e2e:local && test:coverage:check`. CI runs only the cheap subset (e2e is restricted to `@critical`), so the full e2e suite and the coverage floor are your responsibility locally.

### Script reference

| Script | Purpose |
|---|---|
| `pnpm test` | `vitest run` — bare run of all unit + integration includes (rarely used directly). |
| `pnpm test:unit` | Unit tests: `tests/unit`, `lib`, `worker/jobs`, `components`. Mocked (`vitest.setup.ts`). |
| `pnpm test:integration` | Integration tests: `tests/integration`. Vitest + Testcontainers (real Postgres). |
| `pnpm test:smoke` | Smoke tests via the separate `vitest.smoke.config.ts` — real Anthropic API, no mocks. |
| `pnpm test:watch` | `vitest` in watch mode. |
| `pnpm test:coverage` | Run with V8 coverage (text/json/html reporters). |
| `pnpm test:coverage:check` | Run with coverage and **enforce the configured thresholds**. |
| `pnpm test:e2e` | `playwright test` — full Playwright suite (assumes env already wired). |
| `pnpm test:e2e:local` | `bash tests/e2e/run-local.sh` — full local suite with the env wrapper + seed. |
| `pnpm test:e2e:critical` | `playwright test --grep @critical` — the must-not-break subset CI runs. |
| `pnpm test:local` | Umbrella pre-merge: unit → integration → full e2e (`:local`) → coverage check. |

## Decision matrix — what each layer owns

| Layer | Owns | Dependencies |
|---|---|---|
| **unit** | Pure logic — Zod schemas, formatters, recurrence math (rrule), small lib/worker helpers. | Fully mocked (`vitest.setup.ts`). No DB, no network. |
| **integration** | Server actions, queries, worker jobs; multi-row behavior, DB constraints, dedupe/idempotency. | Real Postgres via Testcontainers + fakes for external services. |
| **e2e** | User-facing flows end-to-end through real UI + server + auth. `@critical` subset in CI; **full** suite local. | Dev server + mock OIDC (`global-setup.ts`) + Meilisearch + worker; real Postgres. |
| **smoke** | Real external-API contract checks (Anthropic shape/behavior). | Real Anthropic API + live network. Opt-in; needs keys. |

Pick the **lowest** layer that can express the assertion. A formatter bug belongs in unit; a "two reminders dedupe to one notify" bug belongs in integration; a "the create form actually submits" bug belongs in e2e.

## Per-feature checklist

When adding a feature, walk the layers it touches and add tests at each:

- [ ] **Pure logic** (a new schema, formatter, recurrence/date rule)? → add **unit** tests next to it (`*.test.ts` colocated, or under `tests/unit/`).
- [ ] **Server action, query, or worker job** — anything touching the DB, constraints, or dedupe? → add an **integration** test under `tests/integration/`.
- [ ] **New user-facing flow** (a page, a form, a button that mutates state)? → add a **full e2e** spec under `tests/e2e/`. Tag it `@critical` if it's a must-not-break path (see policy below); otherwise leave it untagged and let it run in the local full suite.
- [ ] **New or changed external-API call** (Anthropic prompt/response shape)? → add or update a **smoke** test under `tests/smoke/`.
- [ ] Run `pnpm test:local` before opening the PR.

This ties into the spec/plan workflow: a plan task that ships a user-facing flow is not done until it has an e2e spec, and a task that ships business logic is not done until unit/integration coverage holds the floor.

## `@critical` policy

`@critical` marks the must-not-break paths that PR CI runs on every push. The current set:

- **Auth** — sign in via mock OIDC and land on the dashboard (`signin.spec.ts`).
- **Item lifecycle** — sign in, add an item, log a service, see activity on the dashboard (`happy-path.spec.ts`).
- **Reminder create + complete** — create a reminder, mark it complete, see it in history (`reminders.spec.ts`).

**How to tag:** append ` @critical` to the Playwright **test title** string (not a Playwright tag option) — e.g. `test('signs in via mock OIDC and lands on dashboard @critical', ...)`. CI runs `playwright test --grep @critical` (`pnpm test:e2e:critical`); locally `pnpm test:e2e:local` runs everything.

**What qualifies:** a flow whose breakage would make the app unusable or silently lose data — auth, core CRUD lifecycle, reminder completion. Most flows do **not** qualify and should stay untagged: they're still covered by the full local suite, just not on every PR. If you tag a new flow `@critical`, it should clearly belong in that company; if it doesn't, justify it in the PR.

## Coverage policy

**Scope:** coverage is collected over `lib/**`, `worker/**`, and `components/**` (test files, `.d.ts`, and configs excluded). Configured in `vitest.config.ts`.

**Current floor (exact, from `vitest.config.ts`):**

| Metric | Threshold |
|---|---|
| statements | 46 |
| branches | 39 |
| functions | 39 |
| lines | 47 |

**How it's enforced:**

- **Locally:** `pnpm test:coverage:check` runs with `--coverage`, which fails the run if combined coverage drops below the floor. It's the last step of `pnpm test:local`.
- **In CI:** the `unit` and `integration` jobs each emit a coverage **blob** (`--reporter=blob`) as an artifact; they deliberately do **not** enforce the floor alone (neither subset clears it). A dedicated `coverage` job downloads both blobs, runs `vitest --merge-reports` with `--coverage`, and enforces the threshold once against the **combined** report.

**Ratchet rule:** the floor only ever goes **up**. Never lower a threshold to make a red build green — add the missing tests. Raise the numbers as real coverage improves so the floor stays a meaningful regression guard.

**Why the floor looks low (do not misread it):** the scope includes `components/**`, and React components are largely exercised by **e2e (Playwright)**, whose coverage V8 unit-coverage does **not** count. So a chunk of the component code shows as "uncovered" in this number while being thoroughly tested through the browser. The threshold is therefore a **regression ratchet on business logic (`lib`/`worker`) plus whatever component unit coverage exists** — *not* a signal that "half the code is untested." Component/UI correctness is guarded by the e2e suite and the `@critical` rule, not by this percentage.

## Running e2e locally

`pnpm test:e2e:local` needs your local infra up first:

```bash
docker compose up -d db meilisearch
pnpm test:e2e:local                              # full suite
pnpm test:e2e:local tests/e2e/signin.spec.ts     # a single spec
```

`tests/e2e/run-local.sh` wraps `playwright test`: it pulls connection values (`DATABASE_URL`, `MEILI_*`, `AUTH_SECRET`) from `.env`, overrides the OIDC vars to point at the mock OIDC server that `global-setup.ts` spins up on port 9999, stubs the remaining env vars `lib/env.ts` requires, matches CI's gated-feature flags (`ASK_ENABLED=false`, `OCR_BACKEND=none`), and seeds categories so the harness's category combobox is populated. The Playwright `webServer` starts `pnpm dev`; `global-setup.ts` also deploys migrations and starts the worker.

### Gotchas

- **Radio / RadioGroup clicks:** click the `label[for="…"]`, **not** the bare `RadioGroupItem`. Clicking the radio control itself fails in Playwright with an "outside of viewport" error (the underlying control is visually collapsed). See the targets/mark-complete pickers in `tests/e2e/systems.spec.ts` for the pattern: `page.locator('label[for="targets-item-…"]').click()`.

## Visual + layout testing (local-only)

A visual-regression + layout-heuristics suite (`tests/e2e/visual.spec.ts`) runs **only locally**, never in CI. It snapshots every empty + populated route at desktop + mobile viewports and asserts no layout nits (text/control/viewport overflow — see `layout-heuristics.ts`). Baselines are platform-pinned, so the runner must always be the same linux Playwright image — that's what the dockerized harness guarantees.

```bash
# one-time: pull the image (~1 GB, cached across runs)
docker pull mcr.microsoft.com/playwright:v1.60.0-noble

# bring up host infra (db + meili) — same prereq as test:e2e:local
docker compose up -d db meilisearch

pnpm test:visual:local        # check against committed baselines
pnpm test:visual:update       # regenerate baselines (do this after intentional UI changes)
```

`tests/e2e/run-visual.sh` starts mock-OIDC + the pg-boss worker + `pnpm dev` on the host (replicating `global-setup.ts` since the dockerized run skips `globalSetup` — see `playwright.config.ts`), then `docker build`s the derived image (`tests/e2e/visual.Dockerfile`) and runs Playwright inside it against `http://host.docker.internal:3000`. The derived image bakes linux-native `node_modules` + the generated Prisma client; a `-v /work/node_modules` anonymous volume masks the host darwin `node_modules` so the linux modules win at runtime.

**Rebuild trigger** for the derived image: `pnpm-lock.yaml` change OR `prisma/schema.prisma` change. Otherwise the docker layer cache serves the prior build instantly.

**Prereqs:** `.env` with `DATABASE_URL`/`MEILI_HOST`/`MEILI_KEY`/`AUTH_SECRET`; ports 3000 / 9999 / 5432 / 7700 free on the host; Docker Desktop running.

**Platform pinning, important:** baselines must be regenerated only via this docker harness — never with macOS-native Playwright (font rendering + sub-pixel layout differ enough that darwin baselines would diff against the committed linux baselines on every CI-ish run). If you accidentally generate baselines on darwin, delete them and re-run `pnpm test:visual:update`.

### Not yet e2e-covered (Phase 2)

The gated features — **Ask/RAG**, **OCR**, **email** (outbound/inbound), and **web push** — are **not** yet e2e-covered. They're feature-flagged off in both CI and `run-local.sh` (`ASK_ENABLED=false`, `OCR_BACKEND=none`), and push/email delivery uses fixture credentials. E2E coverage for these is deferred to Phase 2.
