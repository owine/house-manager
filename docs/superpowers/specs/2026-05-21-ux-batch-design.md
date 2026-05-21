# UX batch: collapsed picker, markdown blank line, AI checklist buttons — Design

**Date:** 2026-05-21
**Status:** Approved (design)
**Branch:** `feat/ux-batch` (off `main` after #161 merge)
**Scope:** Three independent UX changes shipped as one PR with three logical commits.

## Problem

Three unrelated UX issues reported together:

1. **Target picker is expanded by default**, eating screen real estate when adding reminders (and everywhere else the picker appears). It should default collapsed, with a count badge so collapsed sections still show how many targets are selected.
2. **`/notes/[id]` renders an extraneous blank line** at the top of the markdown card.
3. **No way to generate an AI checklist from the checklists pages.** A seasonal generator exists only on the dashboard; a freeform-prompt generator exists only at an unlinked `/suggest` route. Neither is reachable when creating a checklist.

These are independent and small; bundling them into one PR with three commits keeps review coherent.

## Commit 1 — Collapse `TargetsPicker` by default + selected-count badge

**File:** `components/targets/TargetsPicker.tsx` (+ `components/targets/TargetsPicker.test.tsx`).

`TargetsPicker` is the single shared picker embedded in `ReminderForm`, `ServiceRecordForm`, `WarrantyForm`, and the inbox `LinkPicker` popover — across reminders, chores, service records, warranties, and inbox routes. One change covers all of them.

- Flip the two section-open states from `useState(true)` to `useState(false)` (currently lines 69–70: `systemsOpen`, `itemsOpen`).
- Add a **selected-count badge** to each section header button. The header already renders a muted *available*-count number (`filteredSystems.length` / `filteredItems.length`); add a distinct badge reading the **selected** count (`selectedSystems.length` / `selectedItems.length`, already computed at lines 110–111), rendered only when that count > 0. Example header: `▸ Systems  [2 selected]            14`.
- **Keep** the existing named-chip list above both sections (line 151) and the available-count number unchanged. The badge is purely additive — collapsed sections now show a quick count, chips remain the detailed selection display.

Behavior is identical in create and edit forms: always collapsed on mount; the badge + chips reveal existing selections without expanding. The inbox `LinkPicker` popover opens to two collapsed sections (acceptable — user expands as needed).

## Commit 2 — Fix leading blank line in rendered markdown

**Files:** `lib/markdown.tsx`, `app/globals.css` (+ a new `lib/markdown.test.tsx`).

`/notes/[id]` renders `note.body` raw through the shared `<Markdown>` wrapper (`lib/markdown.tsx`, `children: string`). A leading newline/whitespace in the stored body becomes an empty leading `<p>`, and the existing `.markdown > * + *` margin rule only spaces *subsequent* siblings, so the empty element shows as a blank line.

- In `lib/markdown.tsx`, render `{children.trim()}` instead of `{children}`. `children` is typed `string`, so `.trim()` is safe. This removes leading/trailing blank elements for **every** markdown surface (notes, service-record notes, etc.), not just `/notes/[id]`.
- In `app/globals.css`, add defensive rules so the first/last rendered block never carries stray vertical margin:
  ```css
  .markdown > :first-child { margin-top: 0; }
  .markdown > :last-child { margin-bottom: 0; }
  ```

No data migration; the stored body is untouched (trim is render-time only).

## Commit 3 — Surface AI checklist generation; retire the orphan `/suggest`

**Backend is unchanged.** `proposeChecklist()` (`lib/ai/suggest/checklist.ts`) already supports `mode: 'seasonal'` and `mode: 'freeform'` (with `freeFormPrompt`, 3–2000 chars); both fold in the same house-profile + inventory context via `buildSuggestContext` / `buildSystemBlocks`. The work is UI consolidation only.

### Shared component

Create `components/checklists/ChecklistSuggest.tsx` — a client component owning the generate→preview→accept flow for both modes:
- **Seasonal:** `proposeChecklist({ mode: 'seasonal', season })` for the current season (`seasonForDate(new Date())`).
- **Freeform:** an inline dialog (`components/ui/dialog`) with a `Textarea` (3–2000 chars) → `proposeChecklist({ mode: 'freeform', freeFormPrompt })`.
- Both render `<SuggestionPreview kind="checklist" .../>` on success, with `onSaved` / `onDiscard` resetting state. This mirrors the existing `SeasonalChecklistCard` / `SuggestClient` logic, consolidated into one place.

The component exposes both actions so callers can render them as menu items (list page) or buttons (new page).

### Checklists list page — split button

`app/(app)/checklists/page.tsx` header `actions`: replace the plain "New checklist" link-button with a **split button "New checklist ▾"** — the primary segment links to `/checklists/new`; the caret opens a `dropdown-menu` (`components/ui/dropdown-menu`) whose items, **ordered alphabetically**, are:
1. **Generate from prompt** (opens the freeform dialog)
2. **Generate seasonal** (runs the seasonal generation)

The preview renders inline on the page below the header after generation. Because these are interactive, the header actions become (or embed) a client component.

### New-checklist page

`app/(app)/checklists/new/page.tsx`: keep the manual `ChecklistMetaForm`, then an "or generate with AI" divider + the two actions in the same alphabetical order (**Generate from prompt**, **Generate seasonal**), reusing `ChecklistSuggest`.

### Dashboard refactor

Refactor `app/(app)/dashboard/SeasonalChecklistCard.tsx` to reuse `ChecklistSuggest`'s seasonal generate→preview logic, so the seasonal flow is not triplicated. The card's visible behavior (title, description, "Generate {season} checklist" button) stays identical.

### Retire `/suggest`

Delete the now-redundant unlinked route: `app/(app)/suggest/page.tsx` and `app/(app)/suggest/SuggestClient.tsx`. The orphan is reachable only by direct URL (no nav/link references — verified by grep). `proposeChecklist`'s freeform mode remains (the new dialog is its consumer).

**Risk to verify during implementation:** `tests/smoke/ai-suggest.smoke.test.ts` and `tests/fixtures/suggest/*` exist. These almost certainly exercise the `proposeChecklist` / `proposeReminders` **lib** with fixtures, not the `/suggest` page component — so they should survive the route deletion. The plan must confirm the smoke test imports the lib (not `SuggestClient`/the page) before deleting, and keep the fixtures. Run `grep` + `knip` after removal to confirm no dangling references.

## Testing

- **Commit 1:** extend `components/targets/TargetsPicker.test.tsx` — sections start collapsed (lists hidden on mount); the selected-count badge reflects the count and appears only when > 0; named chips still render; expanding toggles the list.
- **Commit 2:** new `lib/markdown.test.tsx` — a body with a leading newline (`"\n\n# Title"`) renders no empty leading element / the heading is the first child.
- **Commit 3:** component test for `ChecklistSuggest` with `proposeChecklist` mocked — seasonal path sets preview; freeform dialog opens, validates min length, submits, sets preview; `onSaved`/`onDiscard` reset. **AI generation cannot run in real e2e** (placeholder Anthropic key, `ASK_ENABLED=false`), so e2e is limited to asserting the split-button menu + dialog render and the manual `/checklists/new` create path; generation correctness is unit/mocked + manual.
- Full gate: `pnpm typecheck`, `pnpm lint` (biome/knip/tokens), `pnpm test:unit`, `pnpm test:integration`.

## Out of scope (YAGNI)

- No backend/schema change to `proposeChecklist` (seasonal + freeform already exist; the user chose freeform context, not a season+prompt hybrid).
- No change to the picker's chip list or available-count display (badge is additive).
- No nav entry for the removed `/suggest` (it's being deleted, not relinked).
