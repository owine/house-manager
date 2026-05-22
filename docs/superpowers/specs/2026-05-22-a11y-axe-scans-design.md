# Phase 2: axe-core page-level accessibility scans — Design

**Date:** 2026-05-22
**Status:** Approved (design)
**Branch:** `feat/a11y-axe-scans` (off `main`)
**Context:** Part of a phased UI/accessibility testing rollout. Phase 1 (Biome static a11y lint, PR #164) is done. This is Phase 2 — runtime WCAG scans of rendered pages. Phase 3 (component-level vitest-axe) and Phase 4 (visual regression + layout-nit heuristics) are separate follow-ups.

## Problem

Biome's static a11y lint (Phase 1) catches JSX-level issues but **cannot** see runtime accessibility problems: color contrast, ARIA references to elements that aren't in the DOM (e.g. `TargetsPicker`'s `aria-controls` pointing at a collapsed-away list — flagged in review this session), focus order, accessible names computed at runtime, etc. We want automated WCAG 2.1 AA scanning of the actual rendered app, **hard-gated** in CI.

## Decisions (from brainstorming)

- **Conformance bar:** WCAG 2.1 **AA** — axe tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`. (Excludes axe `best-practice` — stricter, non-WCAG, noisier.)
- **Coverage:** all routes from the existing `screenshots.spec.ts` list, in **empty + populated** states, at **desktop (1440×900) + mobile (390×844)** viewports.
- **Rollout:** **hard gate** — CI fails on any violation. The existing backlog must be driven to zero, with a small **documented exclusions allowlist** for intentional/won't-fix findings (each with a written reason), so the gate is pragmatic rather than blanket-disabling rules.

## Tooling

- Add `@axe-core/playwright@4.11.3` (current, Deque-official, peer `playwright-core >=1.0.0` — satisfied by Playwright 1.60). Patch-pin per repo convention.
- Reuses the existing Playwright e2e harness verbatim: `signIn` (mock OIDC), `resetAuth`, DB seeding, the `pnpm dev` webServer, chromium.

## Architecture

### Shared routes + seeding module (DRY refactor)

`screenshots.spec.ts` currently inlines its `EMPTY_ROUTES` array, a `populatedRoutes` array, and the data-seeding steps inside one big test. Extract these into a shared module **`tests/e2e/_routes.ts`**:
- `export const EMPTY_ROUTES: { name: string; path: string }[]`
- `export const POPULATED_ROUTES: { name: string; path: string }[]`
- `export async function seedPopulated(page): Promise<void>` — the inline create-item/etc. flow that screenshots.spec uses to populate data.
- `export const VIEWPORTS = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]`.

Refactor `screenshots.spec.ts` to import from `_routes.ts` (no behavior change — verify it still captures the same images). The new a11y spec imports the same module, so the two never drift.

> **Refactor seam:** the seeding block in screenshots.spec is *interleaved* with a screenshot call (the `suggest-after-create` interstitial shot mid-seed). `seedPopulated(page)` must be pure data-creation with **no screenshot side-effects**; keep that one interstitial `shoot()` inside screenshots.spec (or gate it on `CAPTURE_SCREENSHOTS`). There are **24 empty + 13 populated** routes (one populated route is `/search?q=furnace` — the only query-string path; carry it through).

### The a11y spec

`tests/e2e/a11y.spec.ts`:
- One authenticated context (the harness serializes workers; reuse the `signIn` pattern).
- For each viewport × each `EMPTY_ROUTES` route: `page.setViewportSize(vp)`, `page.goto(route.path)`, run axe, assert no violations.
- Then `seedPopulated(page)` once; for each viewport × each `POPULATED_ROUTES` route: same.
- Scan call:
  ```ts
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .disableRules(A11Y_EXCLUDED_RULES) // documented, see below
    .analyze();
  expect(results.violations, formatViolations(route, vp, results.violations)).toEqual([]);
  ```
- `formatViolations` produces a readable failure message (rule id, impact, help URL, offending selectors) so CI failures are actionable.
- **Guard against silent redirects:** before running axe, assert the page actually loaded the intended route (e.g. expected URL pattern or a known heading), so a route that redirects/404s on an empty state can't produce a misleading "0 violations" pass.
- **Mobile nav:** axe won't scan `display:none`/collapsed content, so a closed mobile menu isn't falsely flagged. If we want to cover the *expanded* mobile nav (a real a11y surface), add an explicit open-the-menu step on at least one mobile route — decide during planning (default: scan as-rendered, don't force-open, to keep the spec simple).
- Structure as a `test` per route (or per route×viewport) via `test.describe` + a loop, so Playwright reports which route failed rather than one giant test. (Keeps the report legible and lets retries target a single route.)

### Documented exclusions

`tests/e2e/a11y-exclusions.ts`:
- `export const A11Y_EXCLUDED_RULES: string[]` — axe rule ids globally suppressed, **each with an inline comment** stating why (intentional design, third-party widget, tracked-for-later). Empty to start; populated only during triage for genuine won't-fix items.
- If a finding is route-specific or node-specific, prefer `AxeBuilder.exclude(selector)` at that scan site with a comment, over a global rule disable.
- Rule: no undocumented suppressions. Every entry has a reason. This keeps "hard gate" honest — we suppress *known, justified* findings, not whole rule categories.

## Implementation phases (within this PR)

This is **measurement-driven** — the backlog size is unknown until we run it.

1. **Add dep + shared module + spec scaffold** (gate not yet wired into CI). 
2. **Measure:** run `tests/e2e/a11y.spec.ts` locally via the harness; collect ALL violations grouped by rule × route × viewport into a triage list. Report the backlog to the human before fixing.
3. **Triage + fix:** for each violation, either fix it in the component/page, or add a documented exclusion with reason. Drive the spec to green.
4. **Wire the CI gate:** add a dedicated `a11y` job (see below) as a required check.

> If step 2 reveals a very large backlog (e.g. dozens of distinct issues), surface it — we may split the fixes across follow-up PRs and gate a curated route subset first rather than block this PR indefinitely. The user chose hard-gate; we honor it, but the measurement determines whether it's one PR or needs splitting.

## CI

Add an **`a11y` job** to `.github/workflows/ci.yml`, mirroring the existing `e2e` job's setup (Postgres pgvector + Meilisearch services, `db:deploy`, `db:seed`, `playwright install --with-deps chromium`, the same env incl. `ASK_ENABLED=false`/`OCR_BACKEND=none`), but running `pnpm exec playwright test tests/e2e/a11y.spec.ts` instead of the critical grep.
- Gated by the existing `changes` filter (`needs.changes.outputs.tests == 'true'`), like e2e.
- Required check (hard gate).
- Uploads the Playwright report artifact on failure (with the violation details).
- Add a `pnpm` script `test:a11y` (mirrors `test:e2e` env needs) for local runs, and `test:a11y:local` wrapping `run-local.sh` so it can run against the dev DB like the other e2e specs.
- **Runtime note:** ~24 empty + ~12 populated routes × 2 viewports ≈ 70+ scans plus seeding — a few minutes. Acceptable as its own job; keeps the `e2e` job's @critical-only speed intact.

## Testing

The a11y spec **is** the test. Validation that the harness works: it must (a) run green after triage locally, (b) fail loudly with an actionable message when a violation exists (sanity-check by temporarily reverting a known fix or adding a probe), (c) the refactored `screenshots.spec.ts` still produces the same captures (run with `CAPTURE_SCREENSHOTS=true` and eyeball).

## Out of scope (YAGNI)

- axe `best-practice` rules (chose AA only).
- Component-level vitest-axe (Phase 3).
- Visual regression / text-overflow heuristics (Phase 4).
- Scanning authenticated `/admin`-only or feature-gated `/ask` flows beyond what screenshots.spec already lists (ASK is disabled in e2e).
