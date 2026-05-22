# Phase 4: Visual + Layout-Nit Testing (local-only) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
> **Git note:** commit signing (1Password) may be unavailable this session — commit with `git -c commit.gpgsign=false commit …` (hooks still run; never `--no-verify`). Squash-merge re-signs at merge.

**Goal:** A local-only Playwright suite (run in the pinned `mcr.microsoft.com/playwright:v1.60.0-noble` image against the host dev stack) that asserts (1) deterministic layout heuristics — overflow/clipping/wrapping nits — and (2) pixel visual-regression snapshots, on all routes × desktop/mobile. Not wired into CI.

**Architecture:** The app + Postgres + Meilisearch + mock-OIDC run on the **host**; the Playwright **container** drives the browser against `host.docker.internal:3000`. Two enabling infra changes make this work: parameterize the mock-OIDC issuer, and gate the top-level `webServer`/`globalSetup` on `PLAYWRIGHT_BASE_URL` so the container reuses the host stack instead of spawning its own.

**Tech Stack:** Playwright 1.60, Docker, the existing e2e harness (`_routes.ts`, `auth.ts`, `mock-oidc.ts`).

**Spec:** `docs/superpowers/specs/2026-05-22-visual-layout-testing-design.md`

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `tests/e2e/mock-oidc.ts` | issuer base configurable via `MOCK_OIDC_ISSUER` (default `http://localhost:${port}`) | Modify |
| `tests/e2e/start-mock-oidc.ts` | tiny host-side launcher that starts mock-OIDC and stays alive (for the visual run) | Create |
| `playwright.config.ts` | gate `webServer`/`globalSetup`/`baseURL` on `PLAYWRIGHT_BASE_URL` | Modify |
| `tests/e2e/layout-heuristics.ts` | `assertNoLayoutNits(page, opts?)` | Create |
| `tests/e2e/layout-heuristics.spec.ts` | Playwright tests for the heuristics (crafted DOM) | Create |
| `tests/e2e/visual.spec.ts` | the suite: per route × viewport → heuristics + pixel snapshot | Create |
| `tests/e2e/run-visual.sh` | host stack (dev server + mock-OIDC + seed) + `docker run` Playwright | Create |
| `tests/e2e/visual.spec.ts-snapshots/` | committed baseline PNGs (generated in docker) | Generate |
| `package.json` | `test:visual:local`, `test:visual:update` scripts | Modify |
| `TESTING.md` | how to run + update baselines, host-stack prereqs | Modify |

---

## Task 1: Enabling infra — mock-OIDC issuer + Playwright config gates

**Files:** `tests/e2e/mock-oidc.ts`, `tests/e2e/start-mock-oidc.ts` (create), `playwright.config.ts`.

- [ ] **Step 1 (TDD): test the issuer default is unchanged.** Add `tests/e2e/mock-oidc.test.ts` (vitest, node env): import the issuer-building logic; assert that with `MOCK_OIDC_ISSUER` unset the issuer/endpoints read `http://localhost:9999` (byte-identical to today), and with it set to `http://host.docker.internal:9999` the discovery `issuer`/`authorization_endpoint`/`token_endpoint`/`jwks_uri` + the `/auth` redirect base all use that value. (Extract a pure `buildIssuer(port)` reading the env if needed to make this unit-testable.) Run → fails.
- [ ] **Step 2: implement** in `mock-oidc.ts`: replace the hardcoded `const issuer = `http://localhost:${port}`` with `const issuer = process.env.MOCK_OIDC_ISSUER ?? `http://localhost:${port}``, and ensure every emitted endpoint + the `Location` redirect derive from `issuer`. Keep `server.listen(port)` (binds 0.0.0.0). Run test → passes.
- [ ] **Step 3: host-side launcher** `tests/e2e/start-mock-oidc.ts`: `import { startMockOidc } from './mock-oidc'; startMockOidc(9999); // keep process alive` — a script run on the host by run-visual.sh so mock-OIDC lives on the host (not the container). It just starts the server and blocks.
- [ ] **Step 4: gate the config.** In `playwright.config.ts`:
  - `const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';` → use in `use.baseURL`.
  - `webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : { command: 'pnpm dev', … }` (top-level conditional — it can't be per-project).
  - `globalSetup: process.env.PLAYWRIGHT_BASE_URL ? undefined : './tests/e2e/global-setup.ts'` (when targeting the host stack, mock-OIDC is started host-side by run-visual.sh, so the container must NOT also start it). Likewise gate `globalTeardown`.
- [ ] **Step 5: verify existing e2e is unaffected.** With no `PLAYWRIGHT_BASE_URL`/`MOCK_OIDC_ISSUER`, run a quick existing spec: `pnpm test:e2e:local tests/e2e/signin.spec.ts` → still green (proves the defaults preserve today's behavior). `pnpm typecheck`.
- [ ] **Step 6: commit** (`-c commit.gpgsign=false`): `test(visual): configurable mock-OIDC issuer + PLAYWRIGHT_BASE_URL config gates`.

---

## Task 2: Layout heuristics + tests

**Files:** `tests/e2e/layout-heuristics.ts` (create), `tests/e2e/layout-heuristics.spec.ts` (create).

- [ ] **Step 1 (TDD): write the heuristics spec** with crafted DOM (navigate to a `data:text/html` page or set content) — heuristics need a REAL browser (jsdom has no layout), so these are Playwright tests:
  - A page with a fixed-width button containing a long unbreakable string → `assertNoLayoutNits` returns an offender (text overflow).
  - A page with an element wider than the viewport → returns a viewport-overflow offender.
  - A clean, well-fitting page → returns `[]`.
  Assert the offender objects carry a selector + measurements. Run → fails.
- [ ] **Step 2: implement** `assertNoLayoutNits(page, opts?: { exclude?: string[]; tol?: number }): Promise<Offender[]>` — runs `page.evaluate` to scan the DOM:
  - **text overflow:** elements with text whose `scrollWidth > clientWidth + tol` and computed `overflow-x` ∈ {visible} and no `text-overflow: ellipsis` → clipped/spilling text.
  - **viewport overflow:** elements whose `getBoundingClientRect().right > window.innerWidth + tol` (or `left < -tol`), excluding intentionally-scrollable ancestors (`overflow:auto/scroll`).
  - **control overflow:** `button, [role=button], [role=tab]` whose content `scrollWidth > clientWidth + tol`.
  Skip elements matching any `exclude` selector. Return `{ selector, kind, scrollWidth, clientWidth, rect }[]`. The spec asserts `expect(offenders, formatOffenders(offenders)).toEqual([])`.
  Run tests → pass. `pnpm typecheck` + `pnpm lint`.
- [ ] **Step 3: commit** (`-c commit.gpgsign=false`): `test(visual): assertNoLayoutNits layout heuristics + tests`.

> These tests run on macOS-native Playwright (`pnpm test:e2e:local tests/e2e/layout-heuristics.spec.ts`) since they use crafted DOM, no host stack. They're independent of the docker/baseline machinery.

---

## Task 3: Visual suite + run-visual.sh + scripts + docs

**Files:** `tests/e2e/visual.spec.ts` (create), `tests/e2e/run-visual.sh` (create), `package.json`, `TESTING.md`.

- [ ] **Step 1: `tests/e2e/visual.spec.ts`** — mirror `a11y.spec.ts` structure. Reuse `EMPTY_ROUTES`, `populatedRoutes`, `seedPopulated`, `VIEWPORTS` (`_routes.ts`), `signIn`/`resetAuth` (`auth.ts`). For each viewport × route: `goto`, `assertNoLayoutNits(page)` (assert empty), then `await expect(page).toHaveScreenshot('<route>-<vp>.png', { maxDiffPixelRatio: 0.01, mask: MASKS })`. `MASKS` = locators for the server-time regions enumerated in the spec (calendar grid + today cell on `/reminders/calendar`, `RecentActivityList` timestamps on `/dashboard`, overdue/relative badges on `/reminders`) — add `data-testid` anchors to those components if selectors are fragile (small, additive). Empty-state + populated tests, like a11y.
- [ ] **Step 2: `tests/e2e/run-visual.sh`** — host orchestration (model on `run-local.sh`):
  - Extract `.env` connection vars; seed categories.
  - Start mock-OIDC on the host in the background: `MOCK_OIDC_ISSUER=http://host.docker.internal:9999 tsx tests/e2e/start-mock-oidc.ts &` (track PID; trap to kill on exit).
  - Start the dev server on the host in the background with docker-aware auth env: `AUTH_URL=http://host.docker.internal:3000 AUTH_OIDC_ISSUER=http://host.docker.internal:9999 MOCK_OIDC_ISSUER=… <other run-local env> pnpm dev &` (wait for `:3000` to be ready; trap to kill).
  - `docker run --rm --add-host=host.docker.internal:host-gateway -v "$PWD":/work -w /work -e PLAYWRIGHT_BASE_URL=http://host.docker.internal:3000 -e MEILI_HOST=http://host.docker.internal:7700 -e DATABASE_URL=… mcr.microsoft.com/playwright:v1.60.0-noble npx playwright test tests/e2e/visual.spec.ts "$@"` — forwards `$@` so `--update-snapshots` passes through. (DATABASE_URL must point at the host DB via host.docker.internal too, since `resetAuth`/`seedPopulated` run in-container.)
  - Note: the container needs deps — either mount `node_modules` (the `-v "$PWD":/work` does) or `pnpm install` in-container; the image has Node. Resolve in implementation (mounting the host's node_modules works if the platform matches; otherwise `npm ci` in the container). **This is the iterative bring-up step.**
- [ ] **Step 3: scripts** in `package.json`: `"test:visual:local": "bash tests/e2e/run-visual.sh"`, `"test:visual:update": "bash tests/e2e/run-visual.sh --update-snapshots"`.
- [ ] **Step 4: `TESTING.md`** — a "Visual + layout testing (local-only)" section: `docker pull …`, that it's not in CI, `pnpm test:visual:local` to check, `pnpm test:visual:update` to regenerate baselines (and that updates must run on a fixed date / the masks cover server-time), and the host-stack prereqs.
- [ ] **Step 5: typecheck/lint** (`pnpm typecheck && pnpm lint`) — the spec + helpers compile/lint even before a live run.
- [ ] **Step 6: commit** (`-c commit.gpgsign=false`): `test(visual): visual+layout suite, run-visual docker harness, scripts, docs` (baselines committed separately in Task 4 once generated).

---

## Task 4: Live bring-up + baseline generation + verification (controller/user-run)

> This task needs Docker + the host machine; it's hands-on and iterative (the docker↔host networking is the experimental part). The controller runs it (like the a11y measurement runs), with the user available for Docker/OS specifics.

- [ ] **Step 1:** `docker pull mcr.microsoft.com/playwright:v1.60.0-noble`.
- [ ] **Step 2:** Bring up `pnpm test:visual:update` and debug the networking until sign-in succeeds in-container (the three OIDC hops) and routes render. Expect iteration here (host.docker.internal resolution, node_modules in container, DATABASE_URL/MEILI_HOST reachability).
- [ ] **Step 3:** Once green, the baselines are generated under `tests/e2e/visual.spec.ts-snapshots/`. Eyeball a sample (no clipped masks over real content; masks cover only volatile regions). Commit the baselines (`-c commit.gpgsign=false`): `test(visual): commit baseline snapshots`.
- [ ] **Step 4: gate-bite checks:** (a) re-run `pnpm test:visual:local` → green (deterministic). (b) Introduce a deliberate overflow (long unbreakable string in a button via a throwaway edit) → heuristic fails with the selector; revert. (c) A deliberate visual change (padding/color) → pixel check fails; revert. (d) `test:visual:update` twice → no baseline diff (determinism).
- [ ] **Step 5:** `pnpm typecheck && pnpm lint` clean; confirm nothing in CI references the visual suite (it must stay local-only).

## Notes & Risks

- **Highest risk: the docker↔host networking (Task 3/4).** The three OIDC hops + DB/Meili reachability from the container are the iterative part. Task 1's issuer parameterization + the host-side mock-OIDC launcher are what make it solvable; if `host.docker.internal` proves fragile, the spec's noted fallback is a compose stack.
- **Determinism:** masking (not the browser clock) is what stabilizes the server-rendered calendar/dashboard times — the masks must cover them or baselines churn by run date.
- **Baselines are platform-locked to the docker image** — never regenerate them with macOS-native Playwright (would diff). Always via `test:visual:update` (docker).
- **Local-only:** no `.github/workflows` changes. The value is a pre-flight check the developer runs before shipping UI changes.
- **No prod code / no DB migration** — test tooling + a config gate + an additive `data-testid` or two on masked components.
