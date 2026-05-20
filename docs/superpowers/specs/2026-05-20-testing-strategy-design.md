# Testing Strategy — Design

**Date:** 2026-05-20
**Status:** Approved (design)

## Goal

Restructure the test suites into a **lean per-PR CI gate** and a **thorough
local tier**, and establish **standards** so every future feature is integrated
into the right layers. Also audit current e2e/smoke coverage and close the clear
gaps.

Driven by three observations about the current setup:
- CI runs unit + integration + **full** e2e on every PR (only `build-image` is
  path-gated), so the heaviest job (e2e: boots the dev server, seeds, installs
  Chromium) runs even on docs-only PRs.
- e2e runs with `ASK_ENABLED=false` + `OCR_BACKEND=none`, so Ask/RAG, OCR,
  email, and push paths have **no e2e coverage**.
- Features can ship with zero e2e (the recurrence picker did) — there's no
  standard that pulls new flows into the suites.

## Current state (baseline)

| Surface | Count | Mechanism | In PR CI? |
|---------|-------|-----------|-----------|
| unit (`tests/unit` + colocated `lib/**`, `worker/**`, `components/**`) | ~61 | Vitest, mocked (`vitest.setup.ts`) | yes |
| integration (`tests/integration`) | 49 | Vitest + Testcontainers Postgres | yes |
| e2e (`tests/e2e`) | 8 specs | Playwright + mock-OIDC + dev server + Meili + worker | yes (full) |
| smoke (`tests/smoke`) | 1 | Vitest, **real Anthropic API**, separate config | no (by design) |

CI jobs (GitHub-hosted `ubuntu-24.04`): `changes`, `ggshield`, `lint`,
`typecheck`, `migrate-check`, `unit`, `integration`, `e2e` →
`build-image` → `publish-manifest`. The `changes` path-filter only gates
`build-image`.

## Tier architecture

| Tier | Runs | Where | Command |
|------|------|-------|---------|
| **1. PR gate (fast)** | lint, typecheck, migrate-check, ggshield, unit, integration, **e2e `@critical` only** | every PR in CI | CI jobs |
| **2. Local thorough** | all of Tier 1 + **full** e2e + gated-feature e2e (Ask/OCR/email/push via fakes) + coverage | dev machine, pre-merge | `pnpm test:local` |
| **3. Opt-in smoke** | real-API contract checks (Anthropic now) | manual, needs keys | `pnpm test:smoke` (unchanged) |

The PR gate stays cheap because e2e shrinks to a few `@critical` flows. The full
e2e suite and the currently-gated feature paths move to the one-command local
tier run before merging. Real-API smoke is unchanged: separate, opt-in, never
in PR CI.

Additionally, **extend the `changes` path-filter to gate `unit` / `integration`
/ `e2e`** so docs-only and test-only PRs skip Postgres + Chromium. (Keep
`lint` / `typecheck` unconditional.)

### Scripts (package.json)

Four distinct scripts with non-overlapping purposes (avoid two near-identical
names):

- `test:e2e:critical` → `playwright test --grep @critical`. Run by the **CI**
  e2e job (CI sets its own env block; does not use `run-local.sh`).
- `test:e2e:local` → `bash tests/e2e/run-local.sh` (**kept**, fixed). The full
  Playwright suite with the local env wrapper (mock-OIDC + gated paths on
  against fakes). For running e2e by itself locally.
- `test:local` → the **umbrella pre-merge command**: unit → integration →
  `test:e2e:local` → coverage. The single command a dev runs before merging.
- `test:smoke` → unchanged (real Anthropic).

(`test:e2e` stays as `playwright test` for CI/ad-hoc use; `test:e2e:local`
wraps it with the local env.)

## The `@critical` tag

Tag must-not-break specs in the Playwright test title (e.g.
`test('signs in with Authelia @critical', …)`); CI runs `--grep @critical`,
local runs everything. Initial `@critical` set (~3 flows):
- **Auth** — sign-in via mock OIDC (`signin.spec.ts`).
- **Item lifecycle** — create item → appears → edit.
- **Reminder lifecycle** — create reminder → complete → history. Uses a
  **pre-#154 recurrence kind** (e.g. `interval`/`once`) so this critical flow
  does **not** depend on the recurrence PR; only the dedicated recurrence-picker
  spec (below) exercises the new kinds and depends on #154.

Everything else (`attachments`, `search`, `systems`, `suggest-after-create`,
`screenshots`, and new feature specs) runs in the local full suite only.

## Local-thorough harness

`pnpm test:local` runs unit → integration → full e2e → coverage. The e2e
portion enables the paths CI gates off:

- **OCR**: set `OCR_BACKEND=tesseract` locally — Tesseract.js runs in-process,
  free, no fake required.
- **Ask/embeddings & email**: these are *server-side* `fetch`es
  (`lib/embedding/voyage.ts` → Voyage; notifications → ForwardEmail), so
  Playwright (browser-side) cannot intercept them. Reuse the existing
  **mock-OIDC pattern**: `tests/e2e/global-setup.ts` already starts a local HTTP
  server and points `AUTH_OIDC_ISSUER` at it. Extend that to a small **fakes
  server** and make the two endpoint base-URLs **env-overridable** (one-line
  seams in `lib/embedding/voyage.ts` and the email sender). Push uses a
  no-op/capture transport selected by env.
- **`run-local.sh` is fixed** as part of this work: it currently omits the
  `VOYAGE_API_KEY` stub (added with the Ask feature; `lib/env.ts` makes it
  `.optional()`, but a present-but-empty `.env` value fails `.min(1)` and
  crashes the dev server boot) and doesn't seed categories (CI runs `db:seed`
  separately; the harness's category combobox is empty otherwise). It becomes
  the launcher for the local-thorough e2e, mirroring CI env plus enabling the
  gated paths against fakes. Also: clicking the bare `RadioGroupItem` radio in
  Playwright fails ("outside of viewport"); specs click `label[for="…"]`.

The fakes server + endpoint seams are real new infrastructure, so they are
**Phase 2** (see Phasing).

## Standards (`docs/TESTING.md` + PR template)

**Decision matrix** — what each layer owns:

| Layer | Owns | Dependencies |
|-------|------|--------------|
| **unit** (colocated `*.test.ts`) | pure logic: schemas, formatters, recurrence math, parsers | mocked; no DB/network |
| **integration** (`tests/integration`) | server actions, DB queries, worker jobs; multi-row / constraint / dedupe behavior | real Postgres (Testcontainers) + fakes for external APIs |
| **e2e** (`tests/e2e`) | user-facing flows through real UI + server + auth | `@critical` = CI; full = local |
| **smoke** (`tests/smoke`) | real external-API contract checks | opt-in; keys; never PR CI |

**Per-feature checklist** (woven into the spec/plan workflow): each feature
states which layers it touches and adds tests there. **Every new user-facing
flow adds a full e2e**, tagged `@critical` if it's a must-not-break path (or a
written justification for why not).

**Coverage threshold**: enforce `@vitest/coverage-v8` with a line/branch floor
scoped to `lib/ worker/ components/` (exclude generated Prisma client, config,
type-only files). **Floor = current measured number, ratcheted up over time —
never decreased.** Measure the baseline as the first implementation step and
record it in `docs/TESTING.md` + the vitest coverage config.

**Enforcing across the split CI jobs:** `unit` and `integration` run as separate
parallel CI jobs, each covering only part of the same `lib/ worker/ components/`
scope — so a per-job `--coverage` floor would undercount and false-fail (a
`lib/` file covered only by an integration test looks "uncovered" to the unit
job). Resolution: keep both jobs parallel; each runs with `--coverage` and
uploads its V8 coverage JSON as an artifact (`--reporter=json`-style raw
coverage, not a threshold check). A small downstream **`coverage` job**
downloads both, merges them (Vitest 4 `--merge-reports`), and enforces the floor
once against the combined report. The merge job needs no Postgres/Chromium, so
it's cheap. `pnpm test:local` enforces the same floor locally in one run (unit +
integration together), so the local tier and CI agree.

**Critical-path rule**: a PR-template checkbox — "new user-facing flow →
added/updated a `@critical` e2e, or justified." Enforced by review, not
automation.

A short `CONTRIBUTING`/PR-template addition points at `docs/TESTING.md`.

## Coverage-gap audit (review outcome)

Mapping current e2e (`signin`, `happy-path`, `reminders`, `attachments`,
`search`, `systems`, `suggest-after-create`, `screenshots`) against shipped
features:

- **Tag `@critical`**: auth, item lifecycle, reminder create+complete.
- **Add full (local) e2e in Phase 1** — clear gaps that need no fakes:
  - **Recurrence picker** (weekly / monthly / nth-weekday / seasonal → save →
    detail label) — the gap surfaced during the recurrence work. *Depends on
    PR #154 (recurrence) being merged to `main` first.*
  - **Warranties / notes / vendors / service records** CRUD (currently
    integration-only).
- **Phase-2 e2e** (need the fakes server): **digests** & **inbox** (email),
  **Ask/RAG** flow.
- **Do not mandate e2e for everything** — the matrix + critical-path rule guide
  future features; YAGNI on low-risk admin screens.

## Phasing

- **Phase 1 (this plan):** tiers + scripts (`test:local`, `test:e2e:critical`),
  `@critical` tags on the 3 flows, extend the `changes` path-filter, fix
  `run-local.sh`, `docs/TESTING.md` + PR template, coverage ratchet floor
  (measure baseline + enforce), and the **recurrence-picker full e2e** +
  **warranties/notes/vendors/service-records** e2e. Delivers the
  lean-CI/standards goal end-to-end.
- **Phase 2 (separate plan, immediately after):** local fakes server + endpoint
  seams (`voyage.ts`, email sender) + push capture transport → e2e for
  Ask/OCR/email/push, plus digests & inbox flows.

This is its own branch/PR, separate from the recurrence PR #154.

## Dependencies & sequencing

- The **recurrence-picker e2e** (Phase 1) requires the picker code from PR #154.
  Implement Phase 1 after #154 merges to `main` (rebase this branch on `main`),
  or land the picker e2e in a follow-up commit once merged. The rest of Phase 1
  (tiers, tags on existing specs, standards, coverage, `run-local.sh`) is
  independent of #154.

## Out of scope

- Expanding the real-API smoke suite beyond AI (e.g. real Voyage/email contract
  checks) — possible later; Tier 3 stays AI-only for now.
- Visual-regression / screenshot-diff testing beyond the existing
  `screenshots.spec.ts`.
- Replacing Testcontainers or the Playwright/mock-OIDC harness — the design
  builds on them.
- Nightly scheduled CI runs of the full suite — the chosen split is per-PR-lean
  + local-full; no scheduled tier.
