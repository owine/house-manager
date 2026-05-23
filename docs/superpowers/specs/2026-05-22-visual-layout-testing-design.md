# Phase 4: visual regression + layout-nit testing (local-only) — Design

**Date:** 2026-05-22
**Status:** Approved (design)
**Branch:** `feat/visual-layout-testing` (off `main`)
**Context:** Final phase of the UI/accessibility testing rollout. Phase 1 (Biome a11y #164), Phase 2 (axe page scans #165), Phase 3 (component axe #167) are merged. They catch semantic/ARIA/contrast issues but **not** the visual nits the user originally asked about: "slightly misaligned or poorly wrapped text, buttons with overflowing text, and other UI nits." This phase adds two checks for those — and is **local-only, not wired into CI**.

## Problem

Nothing currently catches layout breakage: text overflowing its button, truncation without ellipsis, an element pushing past the viewport, or unintended visual drift after a CSS/component change. `tests/e2e/screenshots.spec.ts` only *captures* images for manual review (`CAPTURE_SCREENSHOTS=true`, skipped otherwise) — it asserts nothing.

## Decisions (from brainstorming)

- **Two complementary checks:** (1) deterministic **DOM layout heuristics** that pinpoint the nits, and (2) **pixel visual-regression** snapshots that catch any drift.
- **Local-only — NOT in CI.** A pre-flight tool the developer runs before shipping UI changes. "Hard gate" means the suite *fails locally* on a violation; nothing is added to `.github/workflows`.
- **Pinned Playwright Docker image** (`mcr.microsoft.com/playwright:v1.60.0-noble`, matching `@playwright/test@1.60.0`) runs the browser, so baselines render identically across macOS updates and any future machine/CI. Baselines committed to the repo.
- **Coverage:** all routes from `tests/e2e/_routes.ts` (empty + populated) × desktop/mobile — heuristics on every route (cheap), pixel snapshots on every route too (~74 baseline PNGs).
- **Stability:** freeze the clock to a fixed "now" + mask any remaining volatile regions, so pixel baselines don't churn on dates/relative-times/AI text.
- **New spec file** `tests/e2e/visual.spec.ts` (the CAPTURE-only `screenshots.spec.ts` stays as-is).

## Architecture

### Runtime: dockerized Playwright against a host-run app stack

The Playwright image runs the browser + the visual spec; the **app + Postgres + Meilisearch + mock-OIDC run on the host** (the container has Node but not the app/DB). The container reaches host services via Docker Desktop's `host.docker.internal`.

Everything addressable from the container uses the hostname **`hm.local`** — a single name that resolves to the host from *both* the host and the container, eliminating the `localhost`-means-different-things problem. `run-visual.sh` adds `--add-host=hm.local:host-gateway` to the `docker run`, and the host stack is started with all URLs using `hm.local` (the host resolves `hm.local` via the same `host-gateway`/`/etc/hosts` entry, or we use `host.docker.internal` consistently — pick one name and use it for every URL and every hop). For concreteness below, call it `$HOSTREF` (= `host.docker.internal`, which Docker Desktop resolves from the container; the host resolves it too once added to the run, or the host simply uses `localhost` for its own server-to-server calls **as long as the emitted issuer matches what the browser uses** — see the issuer fix).

**The make-or-break fix — parameterize the mock-OIDC issuer.** `tests/e2e/mock-oidc.ts` hardcodes `const issuer = `http://localhost:${port}`` and bakes it into the discovery document (`issuer`/`authorization_endpoint`/`token_endpoint`/`jwks_uri`) and the `/auth` redirect `Location`. The in-container browser cannot reach `localhost:9999` (that's the container), and Auth.js validates the `iss` claim + discovery `issuer` against the configured `AUTH_OIDC_ISSUER` (`auth.config.ts`), so merely setting the env var fails with an `iss` mismatch. **Required change:** parameterize `startMockOidc(port, issuerBase?)` (and the issuer/endpoint/redirect construction) to read an issuer base from an env var (e.g. `MOCK_OIDC_ISSUER`), **defaulting to `http://localhost:${port}`** so the existing host-only `run-local.sh` e2e suite is unchanged. The visual run sets it to `http://host.docker.internal:9999`. The server still binds `0.0.0.0` (it already does — `server.listen(port)` with no host), reachable from both sides.

`tests/e2e/run-visual.sh` (sibling to `run-local.sh`) orchestrates:
1. Seed categories (reuse `run-local.sh`'s `.env` extraction + seeding).
2. Start the app stack **on the host** with docker-aware env so all three OIDC hops resolve from the container:
   - `AUTH_URL=http://host.docker.internal:3000` (callback hop: `…/api/auth/callback/authelia`; `trustHost: true` is already set).
   - `AUTH_OIDC_ISSUER=http://host.docker.internal:9999` **and** `MOCK_OIDC_ISSUER=http://host.docker.internal:9999` (discovery + authorization-redirect hops — both the app's config and the mock's emitted strings now agree).
   - The dev server's own server-to-server discovery/token/jwks fetches go to `host.docker.internal:9999`, which Docker Desktop maps back to the host — works.
3. `docker run --rm` the pinned Playwright image with the repo mounted (`-v "$PWD":/work -w /work`), `--add-host=host.docker.internal:host-gateway`, env `PLAYWRIGHT_BASE_URL=http://host.docker.internal:3000` **and `MEILI_HOST=http://host.docker.internal:7700`** (`resetAuth()` recreates the Meili index from inside the container, so it needs the reachable host), running `playwright test tests/e2e/visual.spec.ts`.

**`playwright.config.ts` — gate the top-level `webServer`** (it's a top-level key, not per-project, so it can't be disabled from a `projects[]` entry): `webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : { …existing… }` and `use.baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'`. When `PLAYWRIGHT_BASE_URL` is set (the docker run), Playwright skips spawning/probing a server and targets the host. Existing e2e/a11y runs (no env var) are unchanged.

Scripts: `pnpm test:visual:local` (run + assert) and `pnpm test:visual:update` (same docker run with `--update-snapshots`). Documented in `TESTING.md`: the one-time `docker pull mcr.microsoft.com/playwright:v1.60.0-noble`, the host-stack prerequisite, and that `test:visual:update` must run on a frozen date (see stability).

> Fallback if host-reachability proves too fragile (decided in the plan, not now): run the dev server + mock-OIDC inside a compose stack alongside the Playwright container. The `host.docker.internal` approach is tried first as it reuses the run-local harness.

### Check 1: layout heuristics — `tests/e2e/layout-heuristics.ts`

`assertNoLayoutNits(page, opts?)` runs in-page (`page.evaluate`) and returns offenders; the spec asserts the list is empty with an actionable message (selector + measurements). Heuristics:
- **Text overflow:** elements whose `scrollWidth > clientWidth + tol` (horizontal) where `overflow` is not `auto/scroll` and there's no ellipsis — i.e. text clipped or spilling. Same for unexpected `scrollHeight` on single-line controls.
- **Viewport overflow:** elements whose bounding rect extends past the layout viewport width (horizontal scrollbars / off-screen content), excluding intentionally-scrollable containers.
- **Button/control overflow:** interactive elements (`button`, `a[role=button]`, `[role=tab]`) whose text content `scrollWidth` exceeds the element's content box.

Tolerances configurable; a small per-call `exclude` selector list for known-OK cases (documented, like the a11y exclusions). Deterministic + content-agnostic, so immune to the dynamic-content problem.

### Check 2: pixel visual-regression

Per route × viewport: navigate, mask volatile regions, `await expect(page).toHaveScreenshot('<route>-<vp>.png', { maxDiffPixelRatio: <small>, mask: [...] })`. Baselines live under `tests/e2e/visual.spec.ts-snapshots/` (Playwright convention), generated in the docker image.

**Stability — masking is PRIMARY, not the clock.** The volatile content is rendered **server-side** (Server Components calling `new Date()`/`Date.now()` in Node), which Playwright's `page.clock` **cannot** touch — it only overrides the browser's clock. So `toHaveScreenshot({ mask: [...] })` is the main mechanism. The spec must mask every server-time-driven region; the known offenders (enumerate + add `data-testid` mask anchors where selectors are fragile):
- `/reminders/calendar` — the month grid + the highlighted "today" cell (`app/(app)/reminders/calendar/page.tsx` computes `today`/`monthStart` server-side).
- `/dashboard` — `RecentActivityList` relative timestamps ("X minutes ago", server-computed).
- `/reminders` (+ any list with overdue/“in N days” badges) — relative-due rendering against `now`.
Audit during implementation for any other `new Date()`/`Date.now()`/`formatDistance`-style rendering on the scanned routes and mask it. A `freezeClock(page)` helper (Playwright clock) is **secondary** — apply it only if a route renders relative time **client-side** (verify any exist; the two found are both server-side). `seedPopulated`'s stored dates are already fixed, but that doesn't help the *relative* computations against `now` — hence masking. (Deferred option, not in v1: an env-gated fixed server `Date` so the regions could be asserted instead of masked.)

## Reuse

`EMPTY_ROUTES`, `populatedRoutes`, `seedPopulated`, `VIEWPORTS` from `tests/e2e/_routes.ts`; `signIn`/`resetAuth` from `tests/e2e/auth.ts`. The visual spec mirrors `a11y.spec.ts`'s structure (empty-routes test + populated test, looping viewport×route), adding the two checks per route.

## Testing

The suite **is** the test. Validation: (a) a clean run is green; (b) introduce a deliberate overflow (e.g. an absurdly long unbreakable string in a button via a throwaway edit) and confirm the heuristic fails with the selector; (c) a deliberate visual change (a color/padding tweak) makes the pixel check fail; (d) baselines regenerate deterministically (`test:visual:update` twice → no diff).

## Out of scope (YAGNI)

- CI integration (explicitly excluded — local-only).
- Cross-browser (chromium only, matching the rest of the harness).
- Per-component visual snapshots (page-level only).
- Auto-managing baseline updates beyond the `test:visual:update` script.
- Animations/transitions (Playwright disables animations during `toHaveScreenshot` by default).
