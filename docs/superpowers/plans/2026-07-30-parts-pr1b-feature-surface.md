# Parts PR 1b — Feature Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Parts usable — CRUD, linking, the target picker, and the Parts tabs on Item and System pages.

**Architecture:** `Part` and `PartLink` already exist and are already valid reminder/service-record targets (PR 1a, `121c14b`). This PR adds the feature module (`lib/parts/*`), the routes, the nav entry, the link/unlink flow, and the picker support that lets a user actually create and target one.

**Tech Stack:** Next.js 16 (App Router, RSC), Prisma 7 / Postgres 18, Zod, react-hook-form, shadcn on `@base-ui/react`, Vitest + Playwright.

**Spec:** `docs/superpowers/specs/2026-07-29-parts-design.md`

---

## Read this before starting

**The single most important thing in this PR is the form chain.** PR 1a deliberately left `TargetsPicker`, `ReminderForm`, `ServiceRecordForm` and the new/edit pages on the narrow `TargetInput` type. That was safe **only because nothing could create a `Part`**. This PR removes that safety.

If the picker ships without widening the form chain, then editing a part-targeted reminder submits a targets array with the part row missing, and `updateReminder`'s diff **deletes the target**. Silent data loss, and the integration tests from PR 1a will not catch it because they call the actions directly, not through a form.

`TargetsPicker` is shared by **four** domains. Two accept parts, two must never:

| Consumer | Accepts parts? | Table constraint |
|---|---|---|
| `ReminderForm` | **yes** | `num_nonnulls(...) <= 1` |
| `ServiceRecordForm` | **yes** | `num_nonnulls(...) = 1` |
| `WarrantyForm` | **no** | two-way XOR |
| `LinkPicker` (incoming email) | **no** | two-way XOR |

Widening the picker for everyone would let a warranty form emit a part target and 500 at the database. Task 5 handles this with an opt-in prop.

Other repo facts that will otherwise cost you time:

1. **`pnpm test:unit` and `pnpm test:integration` pass directory arguments**, so appending a path *widens* the run. Single file: `pnpm exec vitest run <path>`.
2. **`git commit` can fail silently** behind the Biome pre-commit hook. Always confirm with `git log --oneline -1`. Never `--no-verify`.
3. **`prisma migrate reset` is blocked** for agentic sessions (Prisma 7.9 requires an explicit user-consent env var). Ask the human rather than setting it.
4. **UI primitives are shadcn on `@base-ui/react`, not Radix** — use the `render` prop, never `asChild`: `<Button render={<Link href="/parts/new" />}>`.
5. **Playwright gotcha:** click `label[for="…"]`, not the bare `RadioGroupItem` — the control is visually collapsed and Playwright errors with "outside of viewport".
6. **`pnpm lint` is three tools.** `lint:knip` runs on pre-push and will flag a speculatively-exported schema or an entry-shaped file missing from `knip.json`'s `entry` array.

## File structure

**Create:**

| Path | Responsibility |
|---|---|
| `lib/metadata/freeform.ts` | `freeformMetadataSchema`, extracted from `lib/categories.ts` |
| `lib/parts/schema.ts` | Zod only — `createPartSchema`, `updatePartSchema`, `CreatePartInput` |
| `lib/parts/schema.test.ts` | colocated |
| `lib/parts/kinds.ts` | `partKindConfigs`: per-`PartKind` spec schemas |
| `lib/parts/kinds.test.ts` | colocated |
| `lib/parts/queries.ts` | read-only; exports `LIVE_PART` / `ARCHIVED_PART` |
| `lib/parts/actions.ts` | `'use server'` mutations incl. link/unlink |
| `components/parts/PartForm.tsx` | one form, create + edit |
| `components/parts/PartKindFields.tsx` | per-kind metadata card |
| `components/parts/PartsTable.tsx` | per-domain table over `components/ui/table.tsx` |
| `components/parts/LinkExistingPartDialog.tsx` | link an existing part to a parent |
| `components/systems/DeleteSystemPartsDialog.tsx` | the checkbox prompt |
| `app/(app)/parts/page.tsx`, `new/page.tsx`, `[id]/page.tsx`, `[id]/edit/page.tsx` | routes |
| `app/(app)/parts/[id]/tabs/*.tsx` | Overview, Links, Reminders, Service, Attachments |

**Modify:**

| Path | Change |
|---|---|
| `lib/categories.ts` | import `freeformMetadataSchema` instead of defining it |
| `lib/targets/schema.ts` | (no change — `partTargetSchema` already exists) |
| `components/targets/TargetsPicker.tsx` | opt-in `allowParts` prop; **pass through** unknown part rows |
| `components/reminders/ReminderForm.tsx` | `PartTargetInput`, `allowParts` |
| `components/service-records/ServiceRecordForm.tsx` | `PartTargetInput`, `allowParts` |
| `app/(app)/reminders/new`, `chores/new`, `service/new`, `reminders/[id]/edit`, `service/[id]/edit` | `allowParts`, `availableParts`, `?partId=` prefill |
| `components/targets/TargetsChips.tsx` + test | link part chips now that `/parts/[id]` exists |
| `lib/email/templates/reminder.tsx` + test | link part targets in notification emails |
| `app/(app)/systems/[id]/**` | a Delete action — `deleteSystem` has no UI entry point today |
| `lib/systems/actions.ts` | `deleteSystem` returns parts; `deleteSystemWithParts` |
| `app/(app)/items/[id]/page.tsx`, `systems/[id]/page.tsx` | Parts tab |
| `app/(app)/_components/AppSidebar.tsx` | `/parts` nav entry |
| `prisma/seed.ts` | a few seeded parts |
| `knip.json` | new entry-shaped files if flagged |

---

### Task 1: Extract `freeformMetadataSchema`

Behaviour-preserving move, done first so `lib/parts/kinds.ts` can import it rather than copy it. Copying guarantees the two drift and one loses the `_provenance` guard.

**Files:** Create `lib/metadata/freeform.ts`; modify `lib/categories.ts`

- [ ] **Step 1:** Move `freeformMetadataSchema` (`lib/categories.ts:24-33`) verbatim into `lib/metadata/freeform.ts`, **including its long comment** about emitting the issue at the record root rather than per-key. That comment is load-bearing: a per-key path produces an error at `metadata.<key>` which nothing renders, so the rejection is silently swallowed.
- [ ] **Step 2:** `lib/categories.ts` imports it. No behaviour change.
- [ ] **Step 3:** `pnpm exec vitest run lib/categories.test.ts components/items` — all pass unchanged.
- [ ] **Step 4:** Commit `refactor(metadata): extract freeformMetadataSchema for reuse by parts`

---

### Task 2: `lib/parts/kinds.ts` — per-kind spec schemas

**Files:** Create `lib/parts/kinds.ts` + `kinds.test.ts`

- [ ] **Step 1: Write the failing tests.** For each kind: a valid payload parses; an unknown key is stripped (non-strict `z.object`); `OTHER` rejects a `_`-prefixed key with a root-level issue.

- [ ] **Step 2: Implement.** `export const partKindConfigs: Record<PartKind, z.ZodTypeAny>`. Field lists are in the spec's "Per-kind spec schemas" table — copy them exactly. Three decisions not to "simplify":
  - **`base` and `shape` are separate for bulbs.** *E26* is the socket, *BR30* the geometry; they vary independently. Collapsing them makes the data useless for re-buying, which is the entire point of the construct.
  - **`packQuantity` is NOT here** — it is a column on `Part`, alongside `typicalCost` and `purchaseLinks`, because it shares their grain.
  - **Lifespan stays per-kind**: `ratedHours` for bulbs, `ratedMonths` for filters. Different units, and neither is a cadence — that lives on the `Reminder`.

  Export a `partKindSchemaFor(kind)` helper mirroring `metadataSchemaFor`.

- [ ] **Step 3:** Tests pass. Commit `feat(parts): per-kind spec schemas`

---

### Task 3: `lib/parts/{schema,queries,actions}.ts`

The repo's feature-module convention is in `CLAUDE.md`; `lib/items/*` is canonical. Deviating is a review finding.

**Files:** Create `lib/parts/schema.ts`, `queries.ts`, `actions.ts`, `schema.test.ts`

- [ ] **Step 1: `schema.ts`.** `createPartSchema`, `updatePartSchema = createPartSchema.partial().extend({ id })`, `CreatePartInput`. `purchaseLinks` is
  `z.array(z.object({ label: z.string().max(80).optional(), url: z.string().url() })).max(10)`.
  Metadata validates against `partKindSchemaFor(kind)`.

- [ ] **Step 2: `queries.ts`.** No `'use server'`, no `auth()`. Takes `ListParams` from `@/lib/url-params`, returns `{ parts, total }`.

  **Export `LIVE_PART` and `ARCHIVED_PART`** exactly as written in the spec's "Archiving" section. The rule is derived, never stored — a part is archived wherever all its parents are, so there is nothing to reconcile and nothing to drift. Note `ARCHIVED_PART` is **not** simply `archivedAt: { not: null }`; read the spec.

  Write these once and import them; a second inline copy is how the list page and the picker end up disagreeing.

  **Also export a picker query**, mirroring the existing
  `listAllActiveItemsForPicker()` / `listSystemsWithItemsForPicker()`:
  `listPartsForPicker()`, filtered by `LIVE_PART`. Without it Task 5 has an
  `allowParts` flag and no data to render. The spec says the derived-archive rule
  applies to the target pickers, so this is where it gets applied.

- [ ] **Step 3: `actions.ts`.** Follow the server-action skeleton in `CLAUDE.md` exactly: `input: unknown`, `auth()` first returning `{ ok: false, formError: 'Unauthorized' }` (never throw), `safeParse`, `revalidatePath`, side effects never fatal.

  `createPart` / `updatePart` / `archivePart` / `restorePart`, plus:
  - `linkPartToParent({ partId, itemId?, systemId? })` — exactly one parent per call. Idempotent against the `NULLS NOT DISTINCT` unique; catch the duplicate and return `{ ok: true }` rather than surfacing a Prisma error for a link that already exists.
  - `unlinkPart({ linkId })`

  **Do NOT call `enqueueSearchIndex` or `enqueueEmbed` yet** — `'part'` is not in `SEARCH_KINDS` and `PART` is not in `EmbeddingEntityType` until PR 3. `enqueueSearchIndex` is typed to `SearchKind` and will not compile.

- [ ] **Step 4:** Integration test `tests/integration/parts-crud.test.ts` — create/update/archive round-trip, `linkPartToParent` idempotency, `LIVE_PART` and `ARCHIVED_PART` partitioning a fixture set (a live part, a self-archived part, a part whose only parent is archived, a part with one archived and one live parent, a part with zero links). **That last set is the whole point of the derived rule — assert every case.**

- [ ] **Step 5:** Commit `feat(parts): schema, queries, and actions`

---

### Task 4: Routes, nav, and the part form

**Files:** `app/(app)/parts/**`, `components/parts/*`, `AppSidebar.tsx`

- [ ] **Step 1:** Pages per the spec table. All server components — zero of the 42 existing `page.tsx` files carry `'use client'`; don't be the first. Compose the existing shells: `ListPageShell`, `FormPageShell`, `DetailPageShell`, `PageHeader`, `EmptyState`.

- [ ] **Step 2: `PartForm`.** `'use client'` + react-hook-form + `zodResolver` on the shared server schema, `useTransition` for pending state. **The action is injected as a prop** by the server page, not imported — one component serves create and edit, distinguished by `defaultValues?.id`. Field errors merge back via `applyActionFieldErrors`; form-level errors go to `root`; toasts via `sonner`. Type values as `z.input<typeof schema>`, not `z.infer`.

  `useActionState` is used nowhere in this repo. Don't introduce it.

- [ ] **Step 3: `PartKindFields`.** Renders the spec fields for the selected `kind`. `ItemMetadataFields` is the model — but note parts need **no `typeField`/`visibility` indirection**, because `kind` is a real column rather than a key inside the blob.

  **Guard against the `ItemForm` bug fixed in #328:** if you reset metadata when `kind` changes, the effect must not fire on mount. A `useEffect` keyed on a watched value runs on the first render too, and `ItemForm` shipped exactly that — every edit submitted `metadata: {}` and destroyed the stored spec. Use the previous-value ref guard from `ItemForm.tsx`, and write the regression test as an assertion on the **submitted payload**, not on rendered inputs; the discriminator `Select` keeps its own uncontrolled value, so a render-level assertion passes against the bug.

- [ ] **Step 4: Detail tabs.** Overview, Links, Reminders, Service.

  **No Attachments tab** — the spec lists one, but `lib/attachments/schema.ts:3`
  defines `PARENT_TYPES = ['item','warranty','serviceRecord','note']`, and
  `parentExists`, `FK_FIELD` and `REVALIDATE_PATH` all switch on it exhaustively.
  Adding parts means modifying `lib/attachments/*`, which is a different unit of
  work. `system` isn't a parent type either, so a detail page without attachments
  has precedent. Deferred, not forgotten — `attachments.partId` already exists
  from PR 1a, so the tab is a small follow-up whenever it's wanted.

  **The Overview tab must filter reserved metadata keys from day one.** Use `visibleMetadataEntries` from `lib/metadata/reserved-keys.ts` (added in #328). Rendering `Object.entries(metadata)` raw is how `_provenance` leaked onto the item page.

- [ ] **Step 5: Link the two deferred href sites.** Both render parts as plain
  text *because `/parts/[id]` 404s today*, and both have tests asserting that
  no-link behaviour which must be updated once the route exists:
  - `components/targets/TargetsChips.tsx:41-45` (`href: null` at `:83`) — test at
    `components/targets/TargetsChips.test.tsx:83-84`
  - `lib/email/templates/reminder.tsx:44-48` — test at
    `lib/email/templates/reminder.test.ts:135`

  Leaving these is a silently degraded outcome, not a compile error: a
  part-targeted reminder email would keep shipping an unlinked target.

- [ ] **Step 6: Nav.** `/parts` in `AppSidebar.tsx`, grouped with items/systems/vendors — inventory, not activity. Prefer `Boxes` or `Puzzle` over `Lightbulb`, which over-indexes on bulbs.

- [ ] **Step 7:** Component tests for `PartForm` (including the metadata-wipe regression). Commit `feat(parts): routes, nav, and the part form`

---

### Task 5: The form chain — the risky one

Read the "Read this before starting" section again before editing.

**Files:** `components/targets/TargetsPicker.tsx`, `ReminderForm.tsx`, `ServiceRecordForm.tsx`, the three `new/page.tsx` files

- [ ] **Step 1: Write the failing tests first.**
  - `TargetsPicker` with `allowParts` renders part options and emits `{ partId }`.
  - **`TargetsPicker` WITHOUT `allowParts` preserves a part row already in `value`** and passes it back unchanged on the next `onChange`. This is the data-loss test — a picker that silently drops what it cannot render is exactly the bug.
  - `WarrantyForm` and `LinkPicker` offer no part options.
  - A `ReminderForm` seeded with a part target and submitted untouched includes that target in the payload.

- [ ] **Step 2: `TargetsPicker` gains an opt-in `allowParts?: boolean`** and its value/onChange types widen to `PartTargetInput[]`.

  **Pass-through is mandatory, not optional.** Even with `allowParts` false the component must carry unknown part rows through untouched. `hasItem`/`hasSystem`/`removeItem`/`removeSystem` operate on their own kinds and must leave part rows alone.

  Widening the *type* for all four consumers is fine — `TargetInput` and `PartTargetInput` are mutually assignable. What must stay gated is the *UI affordance*: warranties and incoming email must never let a user create a part target, because their tables keep a two-way XOR and the write would 500.

- [ ] **Step 3: `TargetsPicker` also needs an `availableParts` prop.** It renders
  from `availableItems` / `availableSystems`; a boolean flag alone gives it
  nothing to show. Feed it from `listPartsForPicker()` (Task 3).

- [ ] **Step 4: FIVE pages host these forms, not three.** The plan's earlier draft
  listed only the `new/` ones:
  - `app/(app)/reminders/new/page.tsx`
  - `app/(app)/chores/new/page.tsx`
  - `app/(app)/service/new/page.tsx`
  - **`app/(app)/reminders/[id]/edit/page.tsx`**
  - **`app/(app)/service/[id]/edit/page.tsx`**

  The two edit pages already pass `PartTargetInput[]` via `toTargetInputs`, so
  they **typecheck untouched** — which is exactly why they're easy to miss. But
  without `allowParts` + `availableParts` a user editing a part-targeted reminder
  sees the part in neither the chips nor the list, and cannot add or remove one.
  That is the precise flow this task exists for, and where Step 6's end-to-end
  test runs.

  While in these files, add a `?partId=` prefill branch alongside the existing
  `sp.itemId` / `sp.systemId` ones, so the Parts detail page's Reminders and
  Service tabs get a one-click "add reminder for this part" — the same
  navigation argument Task 6 makes for the Parts tabs.

- [ ] **Step 5:** Fix `ReminderForm.tsx:103` — the client-side message still says "Select at least one item or system" while the server message mentions parts.

- [ ] **Step 6: Verify the loop end to end**, because the unit tests cannot. An integration or e2e test that creates a part, targets it from a reminder, **re-saves the reminder through the form path**, and asserts the target survives with the same row id. The PR 1a tests call the actions directly and would not catch a form that drops the row.

- [ ] **Step 7:** `pnpm verify`. Commit `feat(parts): allow part targets in the reminder and service-record pickers`

---

### Task 6: Linking and the Parts tabs

**Files:** `components/parts/LinkExistingPartDialog.tsx`, `app/(app)/items/[id]/page.tsx`, `app/(app)/systems/[id]/page.tsx`

- [ ] **Step 1:** A Parts tab on the Item and System detail pages listing that parent's parts, with inline "Add part" (pre-filling the parent) and "Link existing part". This is how parts actually get created — nobody navigates to `/parts/new` and then hunts for the furnace.
- [ ] **Step 2:** `LinkExistingPartDialog` searches parts and calls `linkPartToParent`. Follows `assignItemToSystem` / `unassignItemFromSystem`.
- [ ] **Step 3:** The `LIVE_PART` filter is a **no-op on these tabs** — the parent is live by definition. Don't apply it and don't reimplement it.
- [ ] **Step 4:** Commit `feat(parts): link/unlink flow and Parts tabs on Item and System`

---

### Task 7: `deleteSystem` and the checkbox dialog

**Files:** `lib/systems/actions.ts`, `components/systems/DeleteSystemPartsDialog.tsx`

- [ ] **Step 1: This is NOT the `tryDeleteVendor` probe pattern.** `PartLink.system` is `onDelete: Cascade` (verify: `prisma/schema.prisma`), so a system delete succeeds silently and cascades the link rows away — **there is no RESTRICT violation to catch.** `tryDeleteVendor` probes because a RESTRICT FK is the only thing stopping that delete; here nothing stops it, so pre-query instead:

  ```ts
  export type TryDeleteSystemResult =
    | { ok: true }
    | { ok: false; hasParts: true; parts: { id: string; name: string; kind: PartKind; willBeOrphaned: boolean }[] }
    | { ok: false; formError: string };
  ```

  `willBeOrphaned` = every one of that part's links points at the system being deleted.

  **`deleteSystem` currently has ZERO callers** — `grep -rn deleteSystem app components lib tests worker` returns only its definition at `lib/systems/actions.ts:78`. There is no way to delete a system in the UI at all.

  So an earlier draft's warning that "its existing callers need updating" was
  wrong, and the real gap is the inverse: **this task must add the entry point**,
  or the dialog is unreachable and Task 8's e2e cannot be written. Add a Delete
  action on the system detail page (`SystemHeader.tsx` or the detail page's
  action row) that opens `DeleteSystemPartsDialog`. Changing the return type is
  therefore free — nothing depends on the old shape.

- [ ] **Step 2: The dialog.** One row per part with a checkbox, plus select-all/none. **Default-checked only when `willBeOrphaned`** — a part still linked to two other fixtures must not be archived because one was deleted. `checkbox.tsx` and `dialog.tsx` already exist; no new primitives. Wire rows with `label[for="…"]` for Playwright. `Part.name` is user-supplied — render as text, never markup.

- [ ] **Step 3: `deleteSystemWithParts({ systemId, archivePartIds })`** in one `prisma.$transaction`: set `archivedAt` on the checked set, delete the link rows, delete the system.

- [ ] **Step 4: Handle concurrency explicitly.** A part linked between the pre-query and the submit appears in neither list. Re-read the system's links **inside** the transaction; if any ID is unaccounted for, roll back and return the fresh result so the dialog re-renders. Deriving "unchecked" from "absent" silently archives-or-skips a part the user never saw — the same family of bug as the `STALE` proposal handling in the chat path.

- [ ] **Step 5:** Integration test covering both branches and the concurrency rollback. Commit `feat(systems): prompt to archive orphaned parts when deleting a system`

---

### Task 8: Seeds, e2e, and full verification

- [ ] **Step 1:** A few parts in `prisma/seed.ts` — at minimum an `AIR_FILTER` linked to a **system**, a `BULB` linked to an **item**, and a `BULB` with **no links** (the standalone/generic case). Task 6 puts a Parts tab on both Item and System, so both parent shapes need seeded coverage.
- [ ] **Step 2:** An e2e spec: create a part, link it to an item, target it from a reminder, **and exercise the delete-system dialog** (now reachable, per Task 7). At most one `@critical` tag — CI runs only those. Remember the `label[for="…"]` gotcha.
- [ ] **Step 3:**
  ```bash
  pnpm verify
  pnpm test:integration
  pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma
  pnpm lint:knip
  pnpm test:coverage
  ```
  The drift check must show **only** the whitelisted IVFFlat line. Never lower a coverage threshold to pass — the floor only ratchets up.
- [ ] **Step 4:** `pnpm test:e2e:local`
- [ ] **Step 5:** Push and open the PR.

---

## What "done" looks like

- A user can create a part, link it to an Item and a System, and target it from a reminder and a service record — entirely through the UI.
- **Editing a part-targeted reminder or service record preserves the part target.** This is the one that would silently lose data; it has an end-to-end test through the form path, not just the action.
- Warranties and incoming email still cannot produce a part target.
- Deleting a system prompts, defaulting to archiving only the parts left orphaned.
- No reserved metadata key renders anywhere in the new UI.
- All gates in Task 8 pass.

## Out of scope

`CREATE_PART` / `UPDATE_PART` conversational capture and the `Decimal`-in-`beforeSnapshot` fix (PR 2). Search and embedding (PR 3) — hence no `enqueueSearchIndex` / `enqueueEmbed` calls in `lib/parts/actions.ts`.
