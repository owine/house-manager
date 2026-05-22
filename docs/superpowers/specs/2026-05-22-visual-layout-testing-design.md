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

A new `tests/e2e/run-visual.sh` (sibling to `run-local.sh`) orchestrates:
1. Seed categories + ensure the host has the dev server reachable (reuse `run-local.sh`'s `.env` extraction + seeding).
2. Start the app stack on the host with **docker-aware auth env**: `AUTH_URL` / `AUTH_OIDC_ISSUER` set to `http://host.docker.internal:3000` / `:9999` so the URLs the in-container browser is redirected to are reachable from the container (this is the **#1 implementation risk** — the OIDC issuer the dev server emits must be the same host the container's browser can resolve; the mock-OIDC server must bind on the host, not inside the container).
3. `docker run --rm` the pinned Playwright image with the repo mounted (`-v $PWD:/work -w /work`), `--add-host=host.docker.internal:host-gateway` (Linux parity; Docker Desktop provides it automatically), running `playwright test tests/e2e/visual.spec.ts` with `PLAYWRIGHT_BASE_URL=http://host.docker.internal:3000` and `reuseExistingServer`.

`playwright.config.ts` gains a `visual` project (or the spec reads `PLAYWRIGHT_BASE_URL`) that, when set, **disables the `webServer`** (the dev server is on the host, not started by Playwright) and points `baseURL` at the host. The existing e2e/a11y projects are unchanged.

Scripts: `pnpm test:visual:local` (run + assert) and `pnpm test:visual:update` (regenerate baselines: same docker run with `--update-snapshots`). Documented in `TESTING.md`, including the one-time `docker pull` and the host-stack prerequisite.

> If the host-stack-in-container-reach proves too fragile in implementation, the fallback (decided in the plan, not now) is to also run the dev server + mock-OIDC inside a compose stack alongside the Playwright container — but the host.docker.internal approach is tried first as it reuses the existing run-local harness.

### Check 1: layout heuristics — `tests/e2e/layout-heuristics.ts`

`assertNoLayoutNits(page, opts?)` runs in-page (`page.evaluate`) and returns offenders; the spec asserts the list is empty with an actionable message (selector + measurements). Heuristics:
- **Text overflow:** elements whose `scrollWidth > clientWidth + tol` (horizontal) where `overflow` is not `auto/scroll` and there's no ellipsis — i.e. text clipped or spilling. Same for unexpected `scrollHeight` on single-line controls.
- **Viewport overflow:** elements whose bounding rect extends past the layout viewport width (horizontal scrollbars / off-screen content), excluding intentionally-scrollable containers.
- **Button/control overflow:** interactive elements (`button`, `a[role=button]`, `[role=tab]`) whose text content `scrollWidth` exceeds the element's content box.

Tolerances configurable; a small per-call `exclude` selector list for known-OK cases (documented, like the a11y exclusions). Deterministic + content-agnostic, so immune to the dynamic-content problem.

### Check 2: pixel visual-regression

Per route × viewport: freeze the clock, navigate, mask volatile regions, `await expect(page).toHaveScreenshot('<route>-<vp>.png', { maxDiffPixelRatio: <small>, mask: [...] })`. Baselines live under `tests/e2e/visual.spec.ts-snapshots/` (Playwright convention), generated in the docker image. The `mask` list + a `freezeClock(page)` helper (Playwright clock API set to a fixed instant, plus `seedPopulated`'s already-fixed dates) keep them stable.

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
