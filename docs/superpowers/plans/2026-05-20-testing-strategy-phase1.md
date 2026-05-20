# Testing Strategy — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the test suites into a lean per-PR CI gate (unit + integration + `@critical` e2e) and a thorough one-command local tier (`pnpm test:local`), enforce a ratchet coverage floor, document standards (`docs/TESTING.md` + PR template), and close the clearest e2e gaps.

**Architecture:** Tag must-not-break Playwright specs `@critical`; CI runs `--grep @critical`, local runs the full suite. Extend the existing `dorny/paths-filter` `changes` job to gate the heavy CI jobs. Coverage runs per-job with V8 blob reporters, merged + threshold-checked in a small downstream job. Standards live in `docs/TESTING.md` + a PR template. Phase 2 (separate plan) adds the fakes server for Ask/OCR/email/push e2e.

**Tech Stack:** Vitest 4 + `@vitest/coverage-v8` 4.1.6, Playwright 1.60, GitHub Actions, Testcontainers, `dorny/paths-filter`.

**Spec:** `docs/superpowers/specs/2026-05-20-testing-strategy-design.md`

---

## Critical sequencing & gotchas (read first)

1. **PR #154 dependency.** Task 8 (recurrence-picker e2e) needs the `RecurrencePicker` from PR #154. Do Task 8 **only after #154 merges to `main`** and this branch is rebased. Tasks 1–7 are independent of #154.
2. **CI changes can't be fully verified locally.** GitHub Actions semantics (path-filter outputs, job gating, artifact merge) are verified by construction + the next CI run, not by running them on your machine. Where a task touches `.github/workflows/ci.yml`, "verify" = YAML parses + the logic review described in the step. Flag this in the PR so the first CI run is watched.
3. **`lint` runs `knip`.** New spec files are referenced by `playwright.config.ts` (`testDir`) so they're not "unused." Don't add dead scripts/exports — knip fails the lint job.
4. **Vitest 4 coverage merge flags are version-sensitive.** Task 3 specifies the blob-report + `--merge-reports` approach; verify exact flags against the installed Vitest 4.1.6 (use the context7 MCP `query-docs` for `vitest` if unsure) before finalizing the CI YAML.
5. **Playwright radio-click gotcha.** Clicking a bare `RadioGroupItem` fails ("outside of viewport"); click `label[for="…"]` instead (used in Task 8).

---

## File structure

- **Modify** `package.json` — add `test:e2e:critical`, `test:local`; keep `test:e2e` / `test:e2e:local`.
- **Modify** `tests/e2e/signin.spec.ts`, `tests/e2e/happy-path.spec.ts`, `tests/e2e/reminders.spec.ts` — append `@critical` to test titles.
- **Modify** `vitest.config.ts` — coverage provider/reporter/thresholds/include/exclude.
- **Modify** `.github/workflows/ci.yml` — gate heavy jobs via `changes`; switch e2e job to `@critical`; add coverage upload + merge-and-enforce job.
- **Modify** `tests/e2e/run-local.sh` — `VOYAGE_API_KEY` stub, `ASK_ENABLED`/`OCR_BACKEND` to CI values, `pnpm db:seed`.
- **Create** `docs/TESTING.md` — decision matrix, per-feature checklist, tier commands, coverage policy, `@critical` rule.
- **Create** `.github/pull_request_template.md` — critical-path checkbox + link to TESTING.md.
- **Create** `tests/e2e/recurrence-picker.spec.ts` — full-suite (not `@critical`) picker flow. *(Task 8, after #154.)*
- **Create** e2e specs for warranties/notes/vendors/service-records CRUD *(Task 7)*.

---

## Task 1: `@critical` tags + e2e scripts

**Files:**
- Modify: `tests/e2e/signin.spec.ts:8`, `tests/e2e/happy-path.spec.ts:8`, `tests/e2e/reminders.spec.ts:8`
- Modify: `package.json` (scripts)

The three existing tests become the `@critical` set as-is (YAGNI — tag existing flows, don't author new ones). "Item lifecycle" is satisfied by `happy-path` (create item + log service + dashboard activity); `edit` coverage stays in the full suite.

- [ ] **Step 1: Append `@critical` to the three test titles.**
  - `signin.spec.ts:8` → `test('signs in via mock OIDC and lands on dashboard @critical', …`
  - `happy-path.spec.ts:8` → `test('signs in, adds an item, logs service, sees activity on dashboard @critical', …`
  - `reminders.spec.ts:8` → `test('creates a reminder, marks it complete, sees it in history @critical', …`

- [ ] **Step 2: Add scripts to `package.json`.** After `"test:e2e:local": "bash tests/e2e/run-local.sh",` add:

```json
    "test:e2e:critical": "playwright test --grep @critical",
    "test:local": "pnpm test:unit && pnpm test:integration && pnpm test:e2e:local && pnpm test:coverage:check",
```

(`test:coverage:check` is added in Task 2. If you run Task 1 in isolation before Task 2, temporarily drop the `&& pnpm test:coverage:check` and add it back in Task 2.)

- [ ] **Step 3: Verify the grep selects exactly the 3 critical specs.**

Run: `eval "$(fnm env)" && fnm use --silent-if-unchanged && pnpm exec playwright test --grep @critical --list`
Expected: lists exactly 3 tests (signin, happy-path, reminders); no others.

- [ ] **Step 4: Verify the full list still includes everything.**

Run: `pnpm exec playwright test --list | tail -5` and confirm the non-critical specs (attachments, search, systems, suggest-after-create, screenshots) are still present.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/signin.spec.ts tests/e2e/happy-path.spec.ts tests/e2e/reminders.spec.ts package.json
git commit -m "test(e2e): tag @critical flows + add test:e2e:critical / test:local scripts"
```

---

## Task 2: Coverage floor (baseline + thresholds + check script)

**Files:**
- Modify: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Measure the current baseline.**

Run: `eval "$(fnm env)" && fnm use --silent-if-unchanged && pnpm test:coverage 2>&1 | tail -30`
This runs `vitest run --coverage` over all includes (unit + integration; Testcontainers spins up). Record the **All files** `% Stmts`, `% Branch`, `% Funcs`, `% Lines` from the summary table. These are the baseline numbers.

- [ ] **Step 2: Configure coverage in `vitest.config.ts`.** Add a `coverage` block under `test:` with the V8 provider, scope, and thresholds set to **the measured baseline rounded DOWN to the nearest whole percent** (a floor, not the exact number — avoids flakiness from tiny fluctuations):

```ts
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // Scope to first-party app code; exclude generated/config/type-only.
      include: ['lib/**', 'worker/**', 'components/**'],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.d.ts',
        'lib/generated/**',
        '**/*.config.*',
      ],
      // Ratchet floor — measured baseline (Step 1), rounded down. Never lower
      // this; raise it as coverage improves. See docs/TESTING.md.
      thresholds: {
        statements: <BASELINE_STMTS_FLOOR>,
        branches: <BASELINE_BRANCH_FLOOR>,
        functions: <BASELINE_FUNCS_FLOOR>,
        lines: <BASELINE_LINES_FLOOR>,
      },
    },
```

Replace the `<…>` with the floored baseline values from Step 1. Confirm `lib/generated` is the actual Prisma client output path (check `prisma/schema.prisma` `generator client { output }`); adjust the exclude glob if it differs.

- [ ] **Step 2b: Add the check script** to `package.json`:

```json
    "test:coverage:check": "vitest run --coverage",
```

(With `thresholds` set in config, `vitest run --coverage` exits non-zero if any metric is below floor — that's the enforcement. `test:coverage:check` is the named entry point used by `test:local` and CI.)

- [ ] **Step 3: Verify the threshold passes at baseline.**

Run: `pnpm test:coverage:check 2>&1 | tail -15`
Expected: PASS (coverage ≥ floor, since floor = floored baseline). Exit code 0.

- [ ] **Step 4: Verify the threshold actually fails when below floor** (sanity-check enforcement). Temporarily bump one threshold (e.g. `lines`) to `100` in `vitest.config.ts`, run `pnpm test:coverage:check`, confirm it **FAILS** with a threshold error, then revert to the floor value.

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts package.json
git commit -m "test(coverage): enforce ratchet coverage floor on lib/worker/components"
```

---

## Task 3: CI — gate heavy jobs, switch e2e to @critical, coverage merge job

**Files:**
- Modify: `.github/workflows/ci.yml`

> Verify Vitest 4.1.6 blob/merge flags via context7 `query-docs` (`vitest`, topic "merge coverage reports blob reporter") before writing the YAML. The approach below is the documented pattern; confirm flag names.

- [ ] **Step 1: Add a `code`/`tests` output to the `changes` job.** In the `filter` (ci.yml:38-53), add a second filter group so the test jobs can gate on it. `tests` should match source + test changes but NOT docs-only:

```yaml
            tests:
              - '**'
              - '!docs/**'
              - '!**/*.md'
              - '!LICENSE'
            image:
              # (existing image filter unchanged)
```

Add `tests: ${{ steps.filter.outputs.tests }}` to the job's `outputs:`.

- [ ] **Step 2: Gate `unit`, `integration`, `e2e` on `changes`.** For each of those three jobs, add:

```yaml
    needs: changes
    if: needs.changes.outputs.tests == 'true'
```

Leave `lint` and `typecheck` unconditional (cheap, always relevant). Update `build-image`'s `needs:` list — it already lists unit/integration/e2e; with conditional jobs, a skipped job reports `skipped` not `success`, so change `build-image`'s gating to tolerate skipped deps (use `if: always() && !contains(needs.*.result, 'failure')` plus the existing image condition, or confirm the current `needs` semantics don't block on skipped). **Verify this interaction explicitly** — a skipped required job must not wedge `build-image` on docs-only PRs.

- [ ] **Step 3: Switch the e2e job to the critical subset.** In the `e2e` job (ci.yml ~246), change `- run: pnpm test:e2e` → `- run: pnpm test:e2e:critical`. The seed/deploy/install steps stay (the critical specs still need DB + Chromium + categories).

- [ ] **Step 4: Make `unit` + `integration` emit coverage blobs + upload.** In each job, change the test run to add coverage with the blob reporter and upload the blob as an artifact. Example for `unit`:

```yaml
      - run: pnpm test:unit -- --coverage --coverage.reporter=json --reporter=blob --outputFile=.vitest-reports/unit-blob.json
      - uses: actions/upload-artifact@<pinned-sha>
        with:
          name: coverage-unit
          path: .vitest-reports/unit-blob.json
          retention-days: 1
```

Mirror for `integration` (`coverage-integration` / `integration-blob.json`). **Confirm the exact Vitest 4 flag set** (blob reporter + per-run coverage) via context7; the names above may need adjustment (e.g. `--reporter=blob` output dir conventions). Do NOT set thresholds here — these jobs only collect; the merge job enforces.

- [ ] **Step 5: Add a `coverage` job** that merges the blobs and enforces the floor:

```yaml
  coverage:
    needs: [changes, unit, integration]
    if: needs.changes.outputs.tests == 'true'
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@<sha>
      - uses: pnpm/action-setup@<sha>
        with: { version: ${{ env.PNPM_VERSION }} }
      - uses: actions/setup-node@<sha>
        with: { node-version: ${{ env.NODE_VERSION }}, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - uses: actions/download-artifact@<sha>
        with: { pattern: coverage-*, path: .vitest-reports, merge-multiple: true }
      - run: pnpm exec vitest --merge-reports --coverage
```

The merged `--coverage` run applies the `thresholds` from `vitest.config.ts` to the combined report and fails if below floor. Pin all action SHAs to match the style already in `ci.yml` (it uses SHA-pinned actions). Verify the `--merge-reports` + coverage-threshold interaction against Vitest 4 docs.

- [ ] **Step 6: Add `coverage` to `build-image`'s `needs`** so a coverage failure blocks the image (mirror how unit/integration gate it), respecting the skipped-job handling from Step 2.

- [ ] **Step 7: Verify YAML validity + logic.**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('YAML OK')"`
Then re-read the diff and confirm: (a) docs-only change → unit/integration/e2e/coverage all skip, build-image still resolves; (b) code change → all run; (c) e2e runs only `@critical`; (d) coverage job depends on both test jobs' artifacts.

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: gate heavy jobs on changes, run @critical e2e, enforce merged coverage floor"
```

> The true verification is the next CI run on this PR — call it out in the PR description and watch the first run (especially the build-image gating on a code PR and the coverage merge).

---

## Task 4: Fix `run-local.sh` (mirror CI + seed)

**Files:**
- Modify: `tests/e2e/run-local.sh`

- [ ] **Step 1: Add the missing env + a seed step.** In the env block that prefixes the `exec pnpm exec playwright test` line, add (matching CI's `e2e` job env):

```bash
VOYAGE_API_KEY=fixture \
ASK_ENABLED=false \
OCR_BACKEND=none \
```

And **before** the final `exec` line, add a seed step (idempotent — `prisma/seed.ts` upserts):

```bash
# Seed categories (CI runs db:seed separately; the harness's category combobox
# is empty otherwise). Idempotent upsert.
DATABASE_URL=$(extract DATABASE_URL) pnpm exec tsx --env-file=.env prisma/seed.ts
```

(Place it after the `extract` helper is defined and before `exec`.) Note: `VOYAGE_API_KEY=fixture` is needed because Next auto-loads `.env`, where a present-but-empty `VOYAGE_API_KEY=` fails `lib/env.ts`'s `.min(1)` and crashes the dev server boot; an explicit non-empty process env value overrides it.

- [ ] **Step 2: Verify a critical spec runs end-to-end locally.**

Run: `eval "$(fnm env)" && fnm use --silent-if-unchanged && lsof -ti:3000 | xargs kill -9 2>/dev/null; bash tests/e2e/run-local.sh --grep @critical`
Expected: dev server boots (no `VOYAGE_API_KEY` ZodError), categories seeded, the 3 `@critical` specs pass. (Local Postgres + Meili must be up.)

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/run-local.sh
git commit -m "test(e2e): fix run-local.sh — VOYAGE stub, CI-matched flags, seed step"
```

---

## Task 5: `docs/TESTING.md`

**Files:**
- Create: `docs/TESTING.md`

- [ ] **Step 1: Write `docs/TESTING.md`** with these sections (prose + tables, no code to test):
  - **Tiers & commands**: the 3 tiers (PR gate / `pnpm test:local` / `pnpm test:smoke`) and exactly what each runs + when to run them. Document the script topology (`test:unit`, `test:integration`, `test:e2e`, `test:e2e:critical`, `test:e2e:local`, `test:local`, `test:smoke`, `test:coverage:check`).
  - **Decision matrix** (copy from the spec): what unit / integration / e2e / smoke each own + their dependencies.
  - **Per-feature checklist**: when adding a feature, state which layers it touches and add tests there; every new user-facing flow adds a full e2e, `@critical` if must-not-break (or justify). Tie this to the spec/plan workflow.
  - **`@critical` policy**: what qualifies, how to tag (` @critical` in the Playwright test title), and that CI runs `--grep @critical` while local runs the full suite.
  - **Coverage policy**: ratchet floor on `lib/ worker/ components/`, current floor value (from Task 2), how it's enforced (per-job blobs merged in CI; `test:coverage:check` locally), and the rule: never lower the floor; raise it when coverage improves.
  - **Running e2e locally**: `pnpm test:e2e:local` (needs local Postgres + Meili up); the `label[for="…"]` radio gotcha; that gated features (Ask/OCR/email/push) are Phase 2.

- [ ] **Step 2: Link it.** Add a one-line pointer from `docs/README.md` (and `README.md` if it has a docs/contributing section) to `docs/TESTING.md`.

- [ ] **Step 3: Verify** it renders (no broken markdown) and the script names match `package.json` exactly.

- [ ] **Step 4: Commit**

```bash
git add docs/TESTING.md docs/README.md README.md
git commit -m "docs: testing strategy, decision matrix, and per-feature checklist"
```

---

## Task 6: PR template

**Files:**
- Create: `.github/pull_request_template.md`

- [ ] **Step 1: Create `.github/pull_request_template.md`** with a concise checklist including the critical-path rule:

```markdown
## Summary

<!-- what & why -->

## Testing

- [ ] Added/updated tests at the right layers (see [docs/TESTING.md](../docs/TESTING.md))
- [ ] New user-facing flow → added/updated a `@critical` e2e (or justified below why not)
- [ ] `pnpm test:local` passes (or note what was skipped and why)

<!-- Justification if no @critical e2e was added: -->
```

- [ ] **Step 2: Verify** the relative link path resolves from `.github/` to `docs/TESTING.md` (`../docs/TESTING.md`).

- [ ] **Step 3: Commit**

```bash
git add .github/pull_request_template.md
git commit -m "ci: PR template with testing checklist + critical-path rule"
```

---

## Task 7: e2e specs for integration-only CRUD features

**Files:**
- Create: `tests/e2e/warranties.spec.ts`, `tests/e2e/notes.spec.ts`, `tests/e2e/vendors.spec.ts`, `tests/e2e/service-records.spec.ts` (one per feature; combine if a feature has no standalone route)

These are **full-suite** specs (NOT `@critical`). Keep each minimal: the core create→appears flow (and edit/delete only if trivially reachable). Mirror the structure of `tests/e2e/reminders.spec.ts` (import `resetAuth`/`signIn`, `resetAuth()` in `beforeEach`, `clearCookies`, `signIn`).

- [ ] **Step 1: Inspect each feature's UI route + labels.** For each of warranties, notes, vendors, service records, find the create route/form (search `app/(app)/` for the route dirs and the form components) and the field labels/buttons (`getByLabel`, `getByRole('button', { name: … })`). Don't guess — read the actual page/form.

- [ ] **Step 2: Write one spec per feature** following the `reminders.spec.ts` pattern: sign in → navigate to the feature's create flow → fill required fields → submit → assert the created entity appears (URL or visible text). Use `label[for="…"]` if you hit the radio/viewport gotcha. Keep assertions concrete (visible text / URL pattern).

- [ ] **Step 3: Run each new spec locally** (full suite, not critical):

Run: `bash tests/e2e/run-local.sh tests/e2e/warranties.spec.ts` (repeat per file)
Expected: PASS. Iterate on selectors against the real UI until green.

- [ ] **Step 4: Confirm they're excluded from the critical gate.**

Run: `pnpm exec playwright test --grep @critical --list`
Expected: still only the 3 critical specs (new ones not listed).

- [ ] **Step 5: Commit** (one commit, or per-spec if you prefer)

```bash
git add tests/e2e/warranties.spec.ts tests/e2e/notes.spec.ts tests/e2e/vendors.spec.ts tests/e2e/service-records.spec.ts
git commit -m "test(e2e): add full-suite CRUD specs for warranties, notes, vendors, service records"
```

> If a feature has no standalone create UI (only reachable nested under an item), scope its spec to that nested flow or note it as not-applicable in the commit message — don't invent UI.

---

## Task 8: Recurrence-picker e2e — **AFTER PR #154 merges**

**Files:**
- Create: `tests/e2e/recurrence-picker.spec.ts`

> **Do not start until PR #154 is merged to `main` and this branch is rebased on `main`** (the `RecurrencePicker` weekly/seasonal UI does not exist before then). This is a full-suite spec, NOT `@critical`.

- [ ] **Step 1: Create `tests/e2e/recurrence-picker.spec.ts`** (this is the validated flow from the recurrence smoke-drive — selectors confirmed working):

```ts
import { expect, test } from '@playwright/test';
import { resetAuth, signIn } from './auth';

test.beforeEach(async () => {
  await resetAuth();
});

test('weekly + seasonal recurrence picker round-trip', async ({ page, context }) => {
  await context.clearCookies();
  await signIn(page);

  await page.goto('/items/new');
  await page.getByLabel('Name').fill('Lawn');
  await page.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('option', { name: /HVAC/i }).click();
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+\/suggest-after-create$/);
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+$/);

  await page
    .getByRole('navigation', { name: 'Item tabs' })
    .getByRole('link', { name: 'reminders' })
    .click();
  await page.getByRole('button', { name: '+ Add reminder' }).click();
  await page.getByLabel('Title').fill('Mow the lawn');
  await page
    .getByLabel('First due date')
    .fill(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));

  // Click labels (the bare RadioGroupItem radio is "outside of viewport").
  await page.locator('label[for="recur-weekly"]').click();
  const weekdays = page.getByRole('group', { name: 'Weekdays' });
  await weekdays.getByRole('button', { name: 'Thu', exact: true }).click(); // Mon([1]) default
  await expect(weekdays.getByRole('button', { name: 'Mon', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(weekdays.getByRole('button', { name: 'Thu', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await page.locator('label[for="recur-seasonal"]').click();
  const months = page.getByRole('group', { name: 'Active months' });
  for (const m of ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']) {
    await months.getByRole('button', { name: m, exact: true }).click();
  }

  // Deselecting the last month auto-disables the seasonal switch (no on-with-zero no-op).
  for (const m of ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']) {
    await months.getByRole('button', { name: m, exact: true }).click();
  }
  await expect(page.locator('#recur-seasonal')).not.toBeChecked();

  // Re-enable + re-select for the actual save.
  await page.locator('label[for="recur-seasonal"]').click();
  const months2 = page.getByRole('group', { name: 'Active months' });
  for (const m of ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']) {
    await months2.getByRole('button', { name: m, exact: true }).click();
  }

  await page.getByRole('button', { name: 'Create reminder' }).click();
  await expect(page).toHaveURL(/\/reminders\/c[a-z0-9]+$/);
  await expect(page.getByText('Every Mon & Thu (Apr–Oct)')).toBeVisible(); // en dash U+2013
});
```

- [ ] **Step 2: Run it locally.**

Run: `bash tests/e2e/run-local.sh tests/e2e/recurrence-picker.spec.ts`
Expected: PASS, including the detail-view label `Every Mon & Thu (Apr–Oct)`.

- [ ] **Step 3: Confirm not in the critical gate** (`--grep @critical --list` unchanged).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/recurrence-picker.spec.ts
git commit -m "test(e2e): recurrence picker weekly + seasonal round-trip"
```

---

## Final verification

- [ ] `pnpm exec playwright test --grep @critical --list` → exactly 3.
- [ ] `pnpm test:coverage:check` → passes at floor.
- [ ] `pnpm test:local` → green end-to-end (unit + integration + full e2e + coverage).
- [ ] `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` → OK.
- [ ] Open the PR; watch the first CI run: docs-only-style changes skip heavy jobs, code changes run them, e2e runs only `@critical`, coverage merge job enforces the floor.

## Out of scope (Phase 2 — separate plan)

Local fakes server + env-overridable endpoints (`lib/embedding/voyage.ts`, email sender) + push capture transport → e2e for Ask/OCR/email/push, plus digests & inbox flows.
