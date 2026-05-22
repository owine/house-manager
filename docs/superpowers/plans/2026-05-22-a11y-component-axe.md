# Phase 3: Component-Level axe a11y Checks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add WCAG 2.1 AA axe checks to all 13 existing component tests via a small shared helper, hard-gated by the existing `unit` CI job.

**Architecture:** Use `axe-core` directly (already in-tree) with a plain async assertion `expectNoAxeViolations(container)` that runs axe over a Testing Library fragment with the WCAG AA tag set and page-context rules disabled (jsdom auto-skips color-contrast). Each of the 13 component tests gets one `it('has no axe violations')` reusing its existing render/setup. Measurement-driven: run, fix any surfaced violations.

**Tech Stack:** axe-core 4.11.4, Vitest + jsdom, Testing Library.

**Spec:** `docs/superpowers/specs/2026-05-22-a11y-component-axe-design.md`

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `package.json` | add `axe-core@4.11.4` (exact) devDep | Modify |
| `tests/a11y/axe.ts` | `expectNoAxeViolations(container)` helper | Create |
| `components/**/*.test.tsx` (×13) | add an axe assertion reusing existing render | Modify |
| (components) | fixes for any surfaced violations | Modify (Task 2, backlog-driven) |

No CI change — component tests run in the existing `unit` job.

---

## Task 1: Dep + helper + apply to all 13 + measure

**Files:** `package.json`, `tests/a11y/axe.ts` (create), the 13 `components/**/*.test.tsx`.

- [ ] **Step 1: Add axe-core as a direct devDep (FIRST — import won't resolve otherwise)**

Run: `pnpm add -D axe-core@4.11.4`
Verify `package.json` shows `"axe-core": "4.11.4"` (exact, no caret; matches the version already resolved via `@axe-core/playwright`). If pnpm adds a caret, edit to exact + `pnpm install`. (Under pnpm's non-hoisted layout, a first-party file can't import the transitive copy — this dep-add must precede the helper.)

- [ ] **Step 2: Create `tests/a11y/axe.ts`**

```ts
import axe from 'axe-core';

const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// Rules requiring full-document context — meaningless for an isolated component
// fragment rendered by Testing Library, so disabled to avoid false positives.
// Page-level coverage of these lives in the Phase 2 axe page scans.
const DOCUMENT_RULES_OFF: Record<string, { enabled: false }> = {
  region: { enabled: false },
  'landmark-one-main': { enabled: false },
  'page-has-heading-one': { enabled: false },
  'document-title': { enabled: false },
  'html-has-lang': { enabled: false },
  bypass: { enabled: false },
};

/**
 * Assert the rendered component has no WCAG 2.1 AA axe violations. Defaults to
 * scanning `document.body` — which is where Testing Library mounts everything,
 * INCLUDING portaled content (Base UI dialogs/popovers render into a portal, not
 * the RTL `container`, so scanning `container` would miss them entirely).
 */
export async function expectNoAxeViolations(container: HTMLElement = document.body): Promise<void> {
  const results = await axe.run(
    {
      include: [container],
      // Base UI Dialog/Popover render internal focus-trap sentinel spans
      // (role="button", no name) — framework plumbing, not author markup. Exclude
      // them rather than disable aria-command-name (which must stay on for real buttons).
      exclude: [['[data-base-ui-focus-guard]']],
    },
    {
      runOnly: { type: 'tag', values: WCAG_AA },
      rules: DOCUMENT_RULES_OFF,
    },
  );
  if (results.violations.length > 0) {
    const summary = results.violations
      .map(
        (v) =>
          `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes
            .map((n) => n.target.join(' '))
            .join('\n    ')}`,
      )
      .join('\n');
    throw new Error(`axe found ${results.violations.length} violation(s):\n${summary}`);
  }
}
```

- [ ] **Step 3: Prove it on one component (TargetsPicker) + verify the gate bites**

In `components/targets/TargetsPicker.test.tsx`, add (reusing the file's existing `setup()` to render, then scan — note we call `expectNoAxeViolations()` with **no argument**, so it scans `document.body`):
```ts
import { expectNoAxeViolations } from '@/tests/a11y/axe';

it('has no axe violations', async () => {
  setup(); // renders the picker into document.body
  await expectNoAxeViolations();
});
```
Run: `pnpm vitest run components/targets/TargetsPicker.test.tsx` → expect PASS (TargetsPicker got a11y fixes in #165, and the spec confirms it's clean).
**Gate-bite sanity:** temporarily render a label-less `<input />` (or remove a known aria-label) and confirm the new test FAILS with the formatted message, then revert.

- [ ] **Step 4: Add the assertion to the remaining 12 test files**

For each, add `it('has no axe violations', async () => { <render the component its existing way>; await expectNoAxeViolations(); })`, **reusing that file's existing render/setup** (read each file; don't invent new props). The render pattern differs by file:
- **4 files have a `setup()` helper** (`TargetsPicker`, `MarkCompleteDialog`, `DeleteVendorDialog`, `VendorLinkEditor`) → call `setup()`.
- **The other 9 call `render(<Component …/>)` inline** per-`it` (`ChecklistAiSection`, `ReminderForm`, `PendingAttachmentsField`, `ServiceRecordForm`, `SystemForm`, `TargetsChips`, `VendorLinkChips`, `VendorLinksSection`, `WarrantyForm`) → do the same `render(...)` with that file's representative props.
- Either way the new test ends with bare `await expectNoAxeViolations()` (scans `document.body`). **Do NOT destructure/scan `container`** — it misses portaled content.

The 12 files: `checklists/ChecklistAiSection`, `reminders/MarkCompleteDialog`, `reminders/ReminderForm`, `service-records/PendingAttachmentsField`, `service-records/ServiceRecordForm`, `systems/SystemForm`, `targets/TargetsChips`, `vendor-links/VendorLinkChips`, `vendor-links/VendorLinkEditor`, `vendors/DeleteVendorDialog`, `vendors/VendorLinksSection`, `warranties/WarrantyForm`.
- **Dialogs** (`MarkCompleteDialog`, `DeleteVendorDialog`): render **open** (their tests already do — reuse that). Because `expectNoAxeViolations()` scans `document.body`, the **portaled** dialog content is included. Sanity-check one dialog test actually scans non-empty content (e.g. confirm it fails if you remove a known label) so it's not a silent empty pass.
- If a test renders multiple variants, scan the primary/representative one (one assertion per file is enough).
- Mocks: reuse each file's existing `vi.mock`s (e.g. server actions) so rendering works under jsdom.

- [ ] **Step 5: MEASURE — run the component suite**

Run: `pnpm vitest run components`
Capture every axe failure (component + rule). Components touched by #165 should pass; the **untouched** ones (`SystemForm`, `WarrantyForm`, `MarkCompleteDialog`, `VendorLinkEditor`, `DeleteVendorDialog`, `VendorLinksSection`, `TargetsChips`, `VendorLinkChips`) may surface violations. Report the backlog grouped by rule before fixing. (This is fast — no dev server.)

- [ ] **Step 6: Commit the helper + assertions (even if some fail — they're committed with the fixes in Task 2; OR if all green, commit clean)**

If green: commit now. If a backlog exists, proceed to Task 2 and commit together. Decision is yours based on Step 5.
```bash
git add package.json pnpm-lock.yaml tests/a11y/axe.ts components
git commit -m "test(a11y): component-level axe checks (WCAG 2.1 AA) on the 13 tested components"
```

---

## Task 2: Fix the surfaced backlog (if any)

**Files:** backlog-driven (components flagged in Task 1 Step 5).

- [ ] **Step 1: Fix each violation**

Same approach as Phase 2: add accessible names (visible `<label>` / `aria-label` / `aria-labelledby`), fix role/name issues. Re-run `pnpm vitest run components` after each batch. For a genuine component-level false positive (a rule that only makes sense with full-page context that slipped past `DOCUMENT_RULES_OFF`), extend `DOCUMENT_RULES_OFF` in `tests/a11y/axe.ts` **with a comment explaining why** — do not blanket-disable AA-meaningful rules.

- [ ] **Step 2: Green + commit**

Run: `pnpm vitest run components` → all PASS. `pnpm typecheck && pnpm lint`.
```bash
git add -A
git commit -m "fix(a11y): resolve component-level axe violations"
```
(If Task 1 was committed clean, skip; if not, this commit includes the helper+assertions+fixes.)

---

## Task 3: Full verification

- [ ] **Step 1: Full unit suite + gate**

Run: `pnpm test:unit` → all PASS (the new axe assertions run here, hard-gated). `pnpm typecheck && pnpm lint`.

- [ ] **Step 2: Confirm the gate bites (if not already done in Task 1)**

Temporarily introduce a violation in one covered component (remove an aria-label), run its test, confirm FAIL with the formatted message, revert.

- [ ] **Step 3: Integration sanity (unchanged surface, quick confidence)**

Run: `pnpm test:integration` → green (this phase doesn't touch server/integration code; mainly confirms nothing unrelated broke).

---

## Notes & Risks

- **Dep-add is step 1** — the helper import won't resolve until `axe-core` is a direct dep (pnpm non-hoisted).
- **Measurement-driven:** Task 2's size is unknown until Task 1 Step 5; it's expected to be small (most components were fixed in #165 or are simple chips/dialogs). Report before fixing.
- **No CI change:** the `unit` job already globs `components/`, so these are gated automatically.
- **Fast:** unlike Phase 2 (dev server), these run in-process under jsdom — the whole component suite is seconds.
- **jsdom skips color-contrast** by design (no layout) — that stays Phase 2's job.
- **Stacked on #165:** this branch (`feat/a11y-component-axe`) is based on `feat/a11y-axe-scans`; its PR diff includes #165 until that merges.
