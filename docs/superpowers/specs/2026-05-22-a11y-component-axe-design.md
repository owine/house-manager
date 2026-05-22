# Phase 3: component-level axe a11y checks — Design

**Date:** 2026-05-22
**Status:** Approved (design)
**Branch:** `feat/a11y-component-axe` (stacked on `feat/a11y-axe-scans` / PR #165)
**Context:** Phase 3 of the a11y rollout. Phase 1 = Biome a11y lint (#164, merged-ish). Phase 2 = axe page scans (#165, open). This phase adds **component-level** axe checks inside the existing Vitest + jsdom component tests. Phase 4 (visual regression + text-overflow) remains separate.

## Problem & honest scope

The Phase 2 page scans already cover these components on their real pages **and** catch color-contrast (which jsdom can't compute). Component-level axe is therefore **largely a guardrail**, not new coverage. Its marginal value: faster unit-level feedback, a check at the component boundary (catches regressions before a page scan would), and a foothold for components not yet on a scanned page. We scope it accordingly — a thin, shared helper applied to the 13 already-tested components, gated automatically by the existing `unit` CI job.

## Decisions (from brainstorming)

- **No new high-level dep:** use `axe-core` directly (already in the tree via `@axe-core/playwright`) with a ~10-line helper. Avoids `vitest-axe` (stuck at 0.1.0) / `jest-axe` maintenance considerations.
- **Coverage:** all **13 currently-tested components** get an axe assertion.
- **Stacked on #165:** branch off `feat/a11y-axe-scans` so the component a11y fixes (RecurrencePicker aria-labels, NoteEditor `aria-labelledby`, tags inputs, etc.) are present — otherwise the assertions would re-find already-fixed violations.

## Tooling

- Add `axe-core` as a direct devDependency, pinned **exact** to the version already resolved in the lockfile (currently `4.11.4`, the same major as `@axe-core/playwright@4.11.3`). No version drift.
- jsdom has no layout engine, so axe **auto-skips `color-contrast`** at the component level — that rule stays the page-scan's job (Phase 2). Documented in the helper.

## The helper

Create `tests/a11y/axe.ts` (importable from component tests):

```ts
import axe from 'axe-core';

const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// Rules that require a full-document context and are meaningless for an isolated
// component fragment rendered by Testing Library — disabled to avoid false
// positives. (Page-level coverage of these lives in the Phase 2 page scans.)
const DOCUMENT_RULES_OFF = {
  region: { enabled: false },
  'landmark-one-main': { enabled: false },
  'page-has-heading-one': { enabled: false },
  'document-title': { enabled: false },
  'html-has-lang': { enabled: false },
  bypass: { enabled: false },
};

/** Assert the rendered component fragment has no WCAG 2.1 AA axe violations. */
export async function expectNoAxeViolations(container: HTMLElement): Promise<void> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: WCAG_AA },
    rules: DOCUMENT_RULES_OFF,
  });
  if (results.violations.length > 0) {
    const summary = results.violations
      .map((v) => `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`)
      .join('\n');
    throw new Error(`axe found ${results.violations.length} violation(s):\n${summary}`);
  }
}
```

- Plain async assertion function (no `expect.extend` / custom matcher needed) — simplest integration, works in any test.
- `axe.run(container, …)` runs against the Testing Library `container` (jsdom). Returns a promise; tests `await` it.
- The `DOCUMENT_RULES_OFF` set is the key correctness detail: without it, every isolated component would fail `region`/`landmark-one-main`/etc. (rules that assume a complete page). This is standard for component-level axe.

## Applying to the 13 component tests

Each existing test (`components/**/*.test.tsx`) gets a focused axe check using its existing render/setup. Pattern — a dedicated test that renders the component's representative state and asserts:

```ts
import { expectNoAxeViolations } from '@/tests/a11y/axe';

it('has no axe violations', async () => {
  const { container } = render(/* component with its existing test props/setup */);
  await expectNoAxeViolations(container);
});
```

The 13 files: `checklists/ChecklistAiSection`, `reminders/MarkCompleteDialog`, `reminders/ReminderForm`, `service-records/PendingAttachmentsField`, `service-records/ServiceRecordForm`, `systems/SystemForm`, `targets/TargetsChips`, `targets/TargetsPicker`, `vendor-links/VendorLinkChips`, `vendor-links/VendorLinkEditor`, `vendors/DeleteVendorDialog`, `vendors/VendorLinksSection`, `warranties/WarrantyForm`.

Notes:
- Dialogs (`MarkCompleteDialog`, `DeleteVendorDialog`) must be rendered in their **open** state for axe to see content (trigger-only renders nothing meaningful).
- Components that need a portal/Provider should render the same way their existing tests already do.
- `TargetsPicker` defaults collapsed (post-#162) — axe sees the headers/chips, which is fine; expanded-state coverage is exercised by the page scans.

## Measurement-driven

Component a11y backlog is unknown until run. The form/picker components touched by #165 should pass; the **untouched** ones (`SystemForm`, `WarrantyForm`, `MarkCompleteDialog`, `VendorLinkEditor`, `DeleteVendorDialog`, `VendorLinksSection`, `TargetsChips`, `VendorLinkChips`) may surface new violations. Implementation order: add the helper → add one assertion → run → triage. If a real backlog appears, fix the components (same approach as Phase 2: accessible names, etc.); document any genuine component-level false positive by extending `DOCUMENT_RULES_OFF` (with a reason) rather than blanket-disabling.

## CI / gating

No CI change needed — these are component tests run by the existing **`unit`** job (`pnpm test:unit` globs `components/`). They're hard-gated automatically (a violation throws → test fails → unit job fails). The `test:unit` run stays fast (axe on a small fragment is milliseconds).

## Testing

The axe assertions **are** the tests. Validate: (a) the suite is green after triage; (b) the helper actually fails when a violation exists (sanity-check by temporarily removing an `aria-label` from a covered component and confirming the test fails with the formatted message).

## Out of scope (YAGNI)

- The ~99 untested components (this phase covers only what's already tested; expanding test coverage is separate).
- color-contrast (jsdom can't; Phase 2 page scans cover it).
- A custom `expect.extend` matcher (the plain assertion function suffices).
- Visual regression / text-overflow (Phase 4).
