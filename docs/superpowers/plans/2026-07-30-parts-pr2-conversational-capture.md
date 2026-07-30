# Parts PR 2 — Conversational Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let conversational capture propose parts, so the assistant stops shoehorning bulb and filter data into `Item` records.

**Architecture:** Add `CREATE_PART` / `UPDATE_PART` to the proposal pipeline — enum, payload union, snapshot, validation, diff render, apply — and teach the model when a part is the right shape. Carries one shared-code fix: `Decimal` values in `ChatProposal.beforeSnapshot`.

**Tech Stack:** Next.js 16, Prisma 7 / Postgres 18, Zod, Anthropic API, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-29-parts-design.md`

---

## This PR closes the bug that started the whole Parts effort

Asked to record some light bulbs, the assistant created an `Item` named "Backyard String Lights" and stuffed bulb specs into it — because `Item` was the only construct that could own metadata, a vendor link and a reminder. PRs 1a and 1b built the better construct. **Until this PR the model still cannot reach it.**

## Read this before starting: the enum is the smallest part of the job

Adding `CREATE_PART` to `ChatProposalKind` does **not** make the model emit one. Three things in `lib/chat/prompt.ts` gate it, and all three must change or the feature is inert:

1. **Rule 1** — *"You are given a snapshot of every item, system, category and note you may reference. Only ever use an id from that snapshot… never propose a change to something that is not listed."* `buildSnapshotBlock` emits categories, systems, items and notes. **No parts.** So `UPDATE_PART` is unreachable by construction, and the model has no way to know parts exist at all.
2. **Rule 5 (Scope)** — *"You may create notes, items and service records, and update notes, items and systems."* An obedient model will not emit a part proposal, enum or no enum.
3. **Nothing tells it when a part is right rather than an item.** That is the actual judgment it got wrong. A rule that merely permits parts, without saying a bulb is a part and a light fixture is an item, will not reliably change the outcome.

Treat the prompt work as the centre of this PR, not a footnote.

Other repo facts:

- **`pnpm test:unit` / `test:integration` pass directory arguments**, so appending a path *widens* the run. Single file: `pnpm exec vitest run <path>`.
- **`git commit` can fail silently** behind the Biome pre-commit hook. Confirm with `git log --oneline -1`. Never `--no-verify`.
- **`prisma migrate reset` is blocked** for agentic sessions. Ask the human.
- **Keep this PR under 150,000 diff characters** or Sourcery declines to review it entirely, as happened to #331. `docs/**` is already excluded from its path filters.

## File structure

**Modify:**

| Path | Change |
|---|---|
| `prisma/schema.prisma` + migration | `CREATE_PART`, `UPDATE_PART` on `ChatProposalKind` |
| `lib/chat/prompt.ts` | PARTS in the snapshot block; rules 1 + 5; new part-vs-item guidance |
| `lib/chat/actions.ts` | fetch parts for the snapshot; validate `partId`; `beforeSnapshot` capture; two apply switches |
| `lib/chat/schema.ts` | two payload arms |
| `lib/chat/resolve.ts` | target resolution for the new kinds |
| `components/chat/ProposalCard.tsx` | labels + diff rows, incl. currency formatting |
| `components/chat/proposal-mapping.ts` | if it enumerates kinds |

---

### Task 1: Enum and migration

- [ ] **Step 1:** Add `CREATE_PART` and `UPDATE_PART` to `ChatProposalKind` in `prisma/schema.prisma`.
- [ ] **Step 2:** Generate the migration with `pnpm exec prisma migrate dev --create-only --name chat_part_proposals`, then apply with `pnpm exec prisma migrate deploy`. **Do not use bare `migrate dev`** — it needs a TTY and prompts on destructive warnings; `--create-only` + `deploy` also means the recorded checksum matches the file you shipped.
- [ ] **Step 3:** Read the generated SQL. Postgres cannot add an enum value inside a transaction in some versions — check what Prisma emitted and that it applies cleanly.
- [ ] **Step 4:** Confirm no drift with CI's own command, which must show *only* the known IVFFlat line:
  ```bash
  pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma
  ```
- [ ] **Step 5:** Commit `feat(chat): add CREATE_PART and UPDATE_PART proposal kinds`

---

### Task 2: Payload union

**Files:** `lib/chat/schema.ts`, `lib/chat/schema.test.ts`

- [ ] **Step 1: Write the failing tests.** A valid `CREATE_PART` parses; `UPDATE_PART` requires `partId`; an unknown `kind` value is rejected; `parseStoredPayload` returns `null` rather than throwing for a shape that no longer matches.

- [ ] **Step 2: Add the two arms.** Every field is wrapped in `provenanced(...)` — read the existing arms and match exactly. Fields to carry:

  - `CREATE_PART`: `name`, `kind` (the `PartKind` enum — note the collision with the payload's own `kind` discriminator, see below), `manufacturer`, `model`, `location`, `notes`, `typicalCost`
  - `UPDATE_PART`: `partId` plus the same fields, all optional

  **The discriminator collision is the trap here.** The payload union discriminates on `kind` (`'CREATE_PART'`), and `Part` has its own `kind` column (`'BULB'`). Do not name the part's kind `kind` in the payload — Zod's `discriminatedUnion` keys on that field and the two meanings will collide confusingly even where it technically parses. `UPDATE_SYSTEM` already hit this and solved it: it calls `System.kind` **`kindLabel`**. Follow that precedent.

  **Leave `metadata` out of the payload.** Per-kind spec fields are a structured blob validated against eight different schemas; letting the model write it invites malformed specs and expands the diff render enormously. `name`/`manufacturer`/`model` capture what a user dictates in practice. Revisit only with evidence.

  **`typicalCost` is a `Decimal`** — see Task 4. Emit it as a decimal string on the wire, matching how `pCalendarDate` handles dates.

- [ ] **Step 3:** Tests pass. Commit `feat(chat): CREATE_PART / UPDATE_PART payload arms`

---

### Task 3: Snapshot, validation, resolve, apply

**Files:** `lib/chat/actions.ts`, `lib/chat/resolve.ts`

- [ ] **Step 1: Add parts to the snapshot.** `lib/chat/actions.ts:348-359` fetches items, systems, categories and notes in one `Promise.all`; add parts. Include `kind` and `manufacturer`/`model` in the emitted line so the model can tell a BR30 bulb from a MERV 11 filter.

  **Filter with `LIVE_PART` from `lib/parts/queries.ts`** — do not write `archivedAt: null` inline. Items and systems filter on their own `archivedAt`, but a part is archived *wherever all its parents are*, and that rule is exported precisely so it is written once.

  Extend `Snapshot` (`partIds`) and `SnapshotInput`, and add a `PARTS` block to `buildSnapshotBlock`.

- [ ] **Step 2: Validate `partId` server-side.** `validateProposal` re-checks every id against the snapshot — the prompt's rule 1 is guidance, not enforcement. Match how `itemId` / `systemId` are checked.

- [ ] **Step 3: `lib/chat/resolve.ts`** — add the two kinds to the `targetType`/`targetId` switch (`targetType: 'PART'`).

- [ ] **Step 4: The apply switches.** `lib/chat/actions.ts` has three sites that switch on kind — around `:79`, `:117` (the `beforeSnapshot` capture) and `:1078`. Find them all by grepping for `CREATE_SERVICE_RECORD`; do not trust these line numbers after earlier edits.

  Apply writes via `prisma.part.*` directly, as the other kinds do. **Do not call `enqueueSearchIndex` / `enqueueEmbed`** — `'part'` is not in `SEARCH_KINDS` and `PART` is not in `EmbeddingEntityType` until PR 3, and both helpers are typed to those unions.

  `UPDATE_PART` needs the same optimistic-concurrency handling as `UPDATE_ITEM`: `baseUpdatedAt`, and `ORPHANED` when the row is gone.

- [ ] **Step 5:** Integration tests — a `CREATE_PART` proposal applies and creates the row; `UPDATE_PART` applies; a stale `baseUpdatedAt` yields `STALE`; a deleted target yields `ORPHANED`; a `partId` absent from the snapshot is rejected by `validateProposal`.

  Harness: import actions **dynamically inside `beforeAll` after `setupIntegration()`** — `lib/db.ts` builds its client at import time. Copy from `tests/integration/parts-crud.test.ts`.

- [ ] **Step 6:** Commit `feat(chat): snapshot, validate, resolve and apply part proposals`

---

### Task 4: The `Decimal` in `beforeSnapshot` — measured, not assumed

`prisma/schema.prisma` warns that snapshotting a `Decimal` column "silently break[s] the diff render" and closes with *"No proposal kind touches a Decimal field today; keep it that way."* `typicalCost` breaks that.

**What actually happens** (measured against the real stack, not inferred):

```
Item.purchasePrice read back   → object, constructor Decimal2
written into a Json column     → string "4.5"
String(...) in the diff row    → "4.5"
```

decimal.js defines `toJSON`, so it does **not** throw and does not store an object. The real damage is quieter:

- a `Decimal(10,2)` holding `4.50` round-trips as `"4.5"` — **trailing zero gone**
- it returns a *string*, so the diff row renders a bare `4.5` where every other price in the app shows `$4.50`
- against a model-proposed `"4.50"` the diff shows a **spurious change** when nothing changed

- [ ] **Step 1: Write the failing test.** A `UPDATE_PART` proposal against a part with `typicalCost = 4.50`, proposing `4.50`, must produce a diff row whose before and after are **equal and currency-formatted** — not `4.5` vs `4.50`.

- [ ] **Step 2: Normalise at capture.** This is the same rule the schema comment already applies to calendar dates ("store as YYYY-MM-DD strings, matching the payload's own wire format"). Store `typicalCost` in `beforeSnapshot` as a fixed-2 decimal string. Do not store the `Decimal` and try to repair it at render — the wire format is the snapshot's contract.

- [ ] **Step 3: Format at render.** `buildRows` in `components/chat/ProposalCard.tsx` has an `isDate` flag that routes a value through `fmtDate`. Add the money equivalent, reusing whatever currency formatter the app already uses (`Intl.NumberFormat` with `style: 'currency'` appears in the item tabs — check for a shared helper before adding another).

- [ ] **Step 4: Update the schema comment.** It currently says no proposal kind touches a Decimal and to keep it that way. That is no longer true. Replace it with the rule that makes it safe — normalise to the payload's wire format at capture — so the next person reads a rule rather than a stale prohibition.

- [ ] **Step 5:** Commit `fix(chat): normalise Decimal values in beforeSnapshot`

---

### Task 5: The prompt — the part that actually fixes the reported bug

**Files:** `lib/chat/prompt.ts`, `lib/chat/prompt.test.ts`

- [ ] **Step 1: Rule 5 (Scope)** currently reads *"You may create notes, items and service records, and update notes, items and systems."* Add parts to both halves.

- [ ] **Step 2: Add part-vs-item guidance.** This is the judgment the model got wrong. State the distinction concretely:

  > A **part** is a consumable or replaceable component you re-buy — a bulb, an air or water filter, a battery, a belt, a fuse, softener salt. An **item** is the thing that consumes it. Bulbs are a part; the light fixture is an item. A furnace filter is a part; the furnace is an item or a system. When the user describes something by its specification (base, wattage, colour temperature, MERV rating, size) rather than by purchase or serial number, it is almost certainly a part.

  Keep it concrete. An abstract rule ("prefer the most specific construct") will not change behaviour.

- [ ] **Step 3:** `buildSnapshotBlock` gains a PARTS section, and rule 1's enumeration ("every item, system, category and note") must name parts too, or the rule contradicts the block below it.

- [ ] **Step 4:** Extend `lib/chat/prompt.test.ts` — the snapshot block includes parts and their kinds; the prompt names parts in its scope rule.

- [ ] **Step 5:** Commit `feat(chat): teach the model when a part is the right construct`

---

### Task 6: Diff render

**Files:** `components/chat/ProposalCard.tsx`, `components/chat/proposal-mapping.ts`

- [ ] **Step 1:** Add the two kinds to the label map (`:33`) and to `buildRows` (`:127`). Rows: name, kind label, manufacturer, model, location, typical cost (currency-formatted, per Task 4).
- [ ] **Step 2:** Component tests, including a `CREATE_PART` card and an `UPDATE_PART` card with a before-snapshot.
- [ ] **Step 3:** Commit `feat(chat): render part proposals in the diff card`

---

### Task 7: Verification

- [ ] **Step 1:**
  ```bash
  pnpm verify
  pnpm test:integration
  pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma
  pnpm lint:knip
  pnpm test:coverage
  ```
  Drift must show only the IVFFlat line. **Never lower a coverage threshold** — the floor only ratchets up.
- [ ] **Step 2:** `pnpm test:e2e:local`
- [ ] **Step 3: Exercise it against the real model.** Every other check here can pass while the model still reaches for `CREATE_ITEM`, which is the entire bug. Run the dev server and tell it something like *"the backyard string lights take 24 S14 bulbs, E26 base, 2700K"* and confirm it proposes a **part**, not an item. Report what it actually did.
- [ ] **Step 4:** Check the diff size stays under Sourcery's 150k limit before pushing.

---

## What "done" looks like

- Telling the assistant about bulbs or filters proposes a **part**, verified against the live model — not just permitted by the schema.
- `UPDATE_PART` works, which requires parts in the snapshot.
- A `typicalCost` diff shows `$4.50` on both sides when nothing changed, not `4.5` vs `4.50`.
- The stale schema comment about Decimals is replaced with the rule that supersedes it.

## Out of scope

Search and embedding indexing (PR 3) — hence no `enqueueSearchIndex`/`enqueueEmbed` in the part apply path. Part `metadata` in proposals. Part targets on `CREATE_SERVICE_RECORD` (its `targets` array is `{ itemId, systemId }` only; a natural follow-up, deliberately not here).
