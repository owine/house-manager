# Parts PR 2 — Conversational Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let conversational capture propose parts, so the assistant stops shoehorning bulb and filter data into `Item` records.

**Architecture:** Add `CREATE_PART` / `UPDATE_PART` to the proposal pipeline — enum, payload union, snapshot, validation, diff render, apply — and teach the model when a part is the right shape. Carries one shared-code fix: `Decimal` values in `ChatProposal.beforeSnapshot`.

**Tech Stack:** Next.js 16, Prisma 7 / Postgres 18, Zod, Anthropic API, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-29-parts-design.md`

---

## This PR closes the bug that started the whole Parts effort

Asked to record some light bulbs, the assistant created an `Item` named "Backyard String Lights" and stuffed bulb specs into it — because `Item` was the only construct that could own metadata, a vendor link and a reminder. PRs 1a and 1b built the better construct. **Until this PR the model still cannot reach it.**

## ARCHITECTURE CHANGE — read this first

The original design put `CREATE_PART`/`UPDATE_PART` into the existing
`proposalPayloadSchema` union, which is handed to the Anthropic API as a
constrained output grammar via `zodOutputFormat`. **That does not work.** It was
implemented, committed (`45b5f94`), passed 1167 unit tests, 436 integration
tests, typecheck, lint and knip — and every chat turn 400s at runtime.

### Three hard API ceilings, measured against the live endpoint

| Limit | Message | Where we stand |
|---|---|---|
| **≤24 optional parameters** | *"too many optional parameters (35)… limit: 24"* | `main` alone spends 19 |
| **Compiled grammar size** | *"The compiled grammar is too large"* | `main` is already near it |
| **Union-typed parameters (~49)** | *"too many parameters with union types (49…)"* | nullable **is** a union |

They interact, so every escape from one spends another: converting `.optional()`
to required-and-nullable fixes limit 1 and immediately spends limit 3.
`$ref` does not help either — the JSON schema was only 8 kB, but the grammar
compiler **expands refs**, so a shared spec object is charged once per use.

**The real finding is not about parts.** `main`'s six-arm union is already at the
edge of all three, so *any* meaningful seventh proposal kind breaks chat. And no
gate in this repo can see it: the limits exist only at the API boundary.

### The design that works

Measured, not theorised — 3/3 runs produced byte-identical correct output:

1. **A separate parts extraction call.** The existing six-arm union is untouched
   and keeps its constrained grammar. Parts get their own request.
2. **Unconstrained JSON, validated server-side.** No `output_config.format`, so
   none of the three limits apply. Prefill the assistant turn with `{` to force
   JSON-only output, then `JSON.parse` + `safeParse`. Malformed output is already
   a handled state in this pipeline — `parseStoredPayload` returns `null` and the
   proposal is marked `INVALID`.
3. **A typed flat `spec` object, generated from `partKindConfigs`.** This is
   load-bearing: with `metadata` as `z.record(z.string(), z.unknown())` the model
   returned `{}` every time, even with a worked example in the prompt. Under
   constrained decoding `unknown` has no productions, so an empty object is the
   only thing it can emit; and even unconstrained, a typed shape is what makes
   the model fill the fields. Generate the union of every kind's fields from
   `partKindConfigs` so the two cannot drift.

### Evidence

`main` today, given *"the backyard string lights take 24 S14 bulbs, E26 base, 2700K, about 11 watts each"*:

```json
{ "kind": "CREATE_ITEM", "name": "S14 bulbs for backyard string lights", "categoryId": "cat_exterior" }
```

An item, with base, colour temperature and wattage discarded entirely. With the
design above:

```
CREATE_PART | partKind: BULB | itemId: item_lights
spec: { "base": "E26", "shape": "S14", "watts": 11, "colorTempK": 2700 }
```

### What this means for the tasks below

Tasks 1, 4, 5, 6 stand. Tasks 2 and 3 change:

- `proposalPayloadSchema` still carries both part arms — it validates **stored**
  payloads, and apply/render/`captureBeforeState` all depend on it.
- A **new** `chatTurnOutputSchema` variant excludes them, because that is the one
  passed to `zodOutputFormat`. Split the union: six arms for the grammar, eight
  for storage.
- The part arms' wire shape uses `spec` (typed, flat), not `metadata` (free
  record). The apply path maps `spec` → `Part.metadata` and validates it against
  `partKindSchemaFor(partKind)`, which is non-strict and so drops fields
  belonging to other kinds — the behaviour the spec already relies on.
- **The main prompt must tell the model not to create an item for a consumable**,
  since a separate pass handles those. Without it both calls propose something
  for the same bulbs.

### CI guard

Whatever ships, add a gate that catches this class of failure. A unit assertion
on optional-parameter count and union-typed-parameter count against
`chatTurnOutputSchema` is cheap and needs no API call. Grammar size cannot be
measured locally, so a smoke call belongs in `test:local`, not the lean CI gate.

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
| `components/chat/proposal-mapping.ts` | `stubPayload` switch — it does enumerate kinds |

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

  - `CREATE_PART`: `name`, `partKind` (the `PartKind` enum — see the collision note below), `manufacturer`, `model`, `location`, `notes`, `typicalCost`, `metadata`, and an optional parent `itemId` / `systemId`
  - `UPDATE_PART`: `partId` plus the same fields minus the parent link, all optional

  **The discriminator collision is the trap here.** The payload union discriminates on `kind` (`'CREATE_PART'`), and `Part` has its own `kind` column (`'BULB'`). Do not name the part's kind `kind` in the payload — Zod's `discriminatedUnion` keys on that field and the two meanings will collide confusingly even where it technically parses. `UPDATE_SYSTEM` already hit this and solved it: it calls `System.kind` **`kindLabel`**. Follow that precedent.

  **`metadata` IS in the payload** — this is what makes the PR close the reported bug rather than approach it. The bug was the model recording *base, wattage, colour temperature*; without this it would dump them into `notes` as free text, which is the same shoehorn one construct to the left, and every AI-captured part would have empty spec fields until the user retyped what they already dictated.

  Type it loosely on the arm (`provenanced(z.record(z.string(), z.unknown()))` or similar) and validate it properly in `validateProposal` — see Task 3 Step 2. The schema cannot self-validate because the applicable spec schema depends on the sibling `partKind` field.

  **`CREATE_PART` carries an optional parent link**: exactly one of `itemId` / `systemId`, or neither. Without it the model produces a floating part the user must then link by hand from `/parts` — the exact navigation the spec calls out as wrong ("nobody navigates to `/parts/new` and then hunts for the furnace"). `CREATE_SERVICE_RECORD.targets` already validates parent ids this way at `resolve.ts:58-69`; follow it. Neither-parent is legal — that is the standalone "generic bulbs" case.

  **`typicalCost` is a `Decimal`** — see Task 4. Emit it as a decimal string on the wire, matching how `pCalendarDate` handles dates, and **constrain it**: `provenanced(z.string().regex(/^\d{1,8}(\.\d{1,2})?$/))`. Dates get a `checkDate` in `validateProposal`; without the equivalent here a model emitting `"about $4.50"` or `"4.505"` passes the union, passes validation, and throws at `prisma.part.create` — surfacing a generic failure long after the user accepted the proposal.

  **Type the part's kind as the enum**, not a free string: `provenanced(z.enum(PART_KINDS))` using `PART_KINDS` from `lib/parts/schema.ts`. A loose string means `prisma.part.create({ kind: 'bulb' })` throws at apply time.

- [ ] **Step 3:** Tests pass. Commit `feat(chat): CREATE_PART / UPDATE_PART payload arms`

---

### Task 3: Snapshot, validation, resolve, apply

**Files:** `lib/chat/actions.ts`, `lib/chat/resolve.ts`

- [ ] **Step 1: Add parts to the snapshot.** `lib/chat/actions.ts:348-359` fetches items, systems, categories and notes in one `Promise.all`; add parts. Include `kind` and `manufacturer`/`model` in the emitted line so the model can tell a BR30 bulb from a MERV 11 filter.

  **Filter with `LIVE_PART` from `lib/parts/queries.ts`** — do not write `archivedAt: null` inline. Items and systems filter on their own `archivedAt`, but a part is archived *wherever all its parents are*, and that rule is exported precisely so it is written once.

  Extend `Snapshot` (`partIds`) and `SnapshotInput`, and add a `PARTS` block to `buildSnapshotBlock`.

- [ ] **Step 2: Validate server-side — three things.** `validateProposal` re-checks every id against the snapshot; the prompt's rule 1 is guidance, not enforcement.

  1. **`partId`** against `snapshot.partIds`, matching how `itemId`/`systemId` are checked.
  2. **The optional parent** on `CREATE_PART` — exactly one of `itemId`/`systemId` or neither, each against the snapshot. Mirror `CREATE_SERVICE_RECORD.targets` (`resolve.ts:58-69`).
  3. **`metadata` against `partKindSchemaFor(partKind)`** — one call, sitting in the same position `checkDate` occupies. Drop the proposal on failure, with `checkDate`'s discipline.

     For `UPDATE_PART` without `partKind`, resolve the stored kind first — `lib/parts/actions.ts` already does exactly this and is the model to copy. A non-strict `z.object` drops unknown keys silently, so a model inventing `bulbColour` costs nothing; the validation is there to reject *wrong-typed* values, not unknown ones.

- [ ] **Step 3: `lib/chat/resolve.ts`** — add the two kinds to the `targetType`/`targetId` switch (`targetType: 'PART'`).

- [ ] **Step 4: The kind switches — seven of them, and grepping for `CREATE_SERVICE_RECORD` will NOT find them all.**

  Grep `switch (p.kind)` / `switch (payload.kind)` instead. Verified complete list:

  | Site | Note |
  |---|---|
  | `lib/chat/actions.ts:79` `targetFor` | |
  | `lib/chat/actions.ts:106` `captureBeforeState` | **ends in `default:` — see below** |
  | `lib/chat/actions.ts:1067` `applyProposal` | |
  | `lib/chat/resolve.ts:26` | |
  | `components/chat/proposal-mapping.ts:25` `stubPayload` | exhaustive-return, typecheck catches it |
  | `components/chat/ProposalCard.tsx:27` `KIND_LABELS` | |
  | `components/chat/ProposalCard.tsx:94` `buildRows` | |

  Nothing in `queries.ts`, `dedup.ts`, `dice.ts` or `title.ts`.

  **`captureBeforeState` is the dangerous one.** It ends in
  `default: return { baseUpdatedAt: null, beforeSnapshot: null }`, so omitting
  `UPDATE_PART` there **compiles clean** — no exhaustiveness error — and silently
  returns a null `baseUpdatedAt`. Optimistic concurrency is then disabled (`STALE`
  never fires) and `refreshProposal` marks the proposal `ORPHANED`. It also does
  not contain the string `CREATE_SERVICE_RECORD`, which is why the grep recipe an
  earlier draft of this plan suggested would have missed exactly the site that
  fails quietly.

  Apply writes via `prisma.part.*` directly, as the other kinds do. `CREATE_PART` with a parent writes it as a nested `links: { create: { itemId } }` in the same call — the `part_links` XOR CHECK enforces the exactly-one rule at the database regardless. **Do not call `enqueueSearchIndex` / `enqueueEmbed`** — `'part'` is not in `SEARCH_KINDS` and `PART` is not in `EmbeddingEntityType` until PR 3, and both helpers are typed to those unions.

  `UPDATE_PART` needs the same optimistic-concurrency handling as `UPDATE_ITEM`: `baseUpdatedAt`, and `ORPHANED` when the row is gone.

  **Decide provenance explicitly.** Every other write kind runs `extractProvenance` + `mergeProvenanceMetadata` into the row's `metadata` (`actions.ts:767`, `:821`, `:896`), and `Part.metadata` exists. Excluding spec `metadata` from the *payload* does not answer whether the apply path writes `_provenance`. Writing it is safe — `components/parts/PartKindFields.tsx` and the part Overview tab already strip reserved keys, so the #328 leak/unsaveable-form pair cannot recur — and skipping it loses the inferred-vs-user distinction as soon as the proposal scrolls out of the thread. Default to writing it.

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

- [ ] **Step 3: Format at render.** `buildRows` has an `isDate` flag routing values through `fmtDate`; add the money equivalent.

  **There is no shared currency formatter** — there are eleven independent copies of `new Intl.NumberFormat('en-US', { style: 'currency' })` across the app. Add `lib/format/currency.ts` next to `lib/format/date.ts` (which `ProposalCard` already imports) and use it here. ~10 lines. Do not migrate the other eleven in this PR.

- [ ] **Step 4: Update the schema comment.** It currently says no proposal kind touches a Decimal and to keep it that way. That is no longer true. Replace it with the rule that makes it safe — normalise to the payload's wire format at capture — so the next person reads a rule rather than a stale prohibition.

- [ ] **Step 5:** Commit `fix(chat): normalise Decimal values in beforeSnapshot`

---

### Task 5: The prompt — the part that actually fixes the reported bug

**Files:** `lib/chat/prompt.ts`, `lib/chat/prompt.test.ts`

- [ ] **Step 1: Rule 5 (Scope)** currently reads *"You may create notes, items and service records, and update notes, items and systems."* Add parts to both halves.

- [ ] **Step 2: Add part-vs-item guidance.** This is the judgment the model got wrong. State the distinction concretely:

  > A **part** is a consumable or replaceable component you re-buy — a bulb, an air or water filter, a battery, a belt, a fuse, softener salt. An **item** is the thing that consumes it. Bulbs are a part; the light fixture is an item. A furnace filter is a part; the furnace is an item or a system. When the user describes something by its specification (base, wattage, colour temperature, MERV rating, size) rather than by purchase or serial number, it is almost certainly a part.

  Keep it concrete. An abstract rule ("prefer the most specific construct") will not change behaviour.

- [ ] **Step 3: Tell the model which spec fields belong to which kind.** This is the largest single addition to `CHAT_SYSTEM_PROMPT` and the reason `metadata` capture is the expensive half of this PR.

  Keep it a compact table, not prose — kind, then its field names. **Generate it from `partKindConfigs`** rather than hand-writing a second copy that drifts the moment a field is added: iterate the config and emit `BULB: base, shape, technology, watts, lumens, colorTempK, cri, dimmable, voltage, ratedHours`. Enum-valued fields should list their options, since `base` and `shape` are the ones the model will otherwise invent values for.

  Say explicitly that spec fields are optional and that it should omit what the user did not say rather than guessing — the provenance rule (mark inferences `"inferred"`) covers enrichment it *does* choose to make.

- [ ] **Step 4:** `buildSnapshotBlock` gains a PARTS section, and rule 1's enumeration ("every item, system, category and note") must name parts too, or the rule contradicts the block below it.

- [ ] **Step 5:** Extend `lib/chat/prompt.test.ts` — the snapshot block includes parts and their kinds; the prompt names parts in its scope rule; the spec-field table is present and derived from `partKindConfigs` (assert a field that exists in the config appears in the prompt, so the two cannot drift).

- [ ] **Step 6:** Commit `feat(chat): teach the model when a part is the right construct`

---

### Task 6: Diff render

**Files:** `components/chat/ProposalCard.tsx`, `components/chat/proposal-mapping.ts`

- [ ] **Step 1:** Add the two kinds to `KIND_LABELS` (`:27`) and `buildRows` (`:94`). Rows: name, kind label, manufacturer, model, location, typical cost (currency-formatted, per Task 4), the parent link if present, and the spec fields.

  **Spec fields are one generic loop**, not a `push()` per field — iterate `visibleMetadataEntries(payload.metadata)` and emit a row each, labelling with the same `toLabel`-style camelCase-to-words helper the item Overview tab uses. `visibleMetadataEntries` (`lib/metadata/reserved-keys.ts`) also strips `_provenance`, which the apply path writes.
- [ ] **Step 2:** `components/chat/proposal-mapping.ts:25` — `stubPayload` needs both arms. Exhaustive-return, so typecheck catches it, but it is a step rather than a maybe.
- [ ] **Step 3: Render the part kind through `components/parts/kind-labels.ts`** so the card shows "Air filter", not `AIR_FILTER`.
- [ ] **Step 4:** Component tests, including a `CREATE_PART` card and an `UPDATE_PART` card with a before-snapshot.
- [ ] **Step 5:** Commit `feat(chat): render part proposals in the diff card`

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
- [ ] **Step 3: Exercise it against the real model.** Every other check here can pass while the model still reaches for `CREATE_ITEM`, which is the entire bug. Run the dev server and tell it *"the backyard string lights take 24 S14 bulbs, E26 base, 2700K"*.

  Confirm all three, and report what it actually did — verbatim, including the proposal JSON:
  1. it proposes a **part**, not an item
  2. the spec lands in **`metadata`** (`base: 'E26'`, `shape: 'S14'`, `colorTempK: 2700`) — not prose in `notes`
  3. it **links** the part to the Backyard String Lights item if that item exists in the snapshot

  If it gets the construct right but dumps the spec into `notes`, the prompt's spec-field table is not doing its job — that is a prompt fix, not a schema one.
- [ ] **Step 4:** Check the diff size stays under Sourcery's 150k limit before pushing.

---

## What "done" looks like

- Telling the assistant about bulbs or filters proposes a **part**, verified against the live model — not just permitted by the schema.
- **The spec is captured as data.** "24 S14 bulbs, E26 base, 2700K" lands in `metadata` as `{ base: 'E26', shape: 'S14', colorTempK: 2700 }`, not as a sentence in `notes`. This is the half that makes the original bug actually fixed.
- The part comes out **linked to its parent**, not floating.
- `UPDATE_PART` works, which requires parts in the snapshot.
- A `typicalCost` diff shows `$4.50` on both sides when nothing changed, not `4.5` vs `4.50`.
- The stale schema comment about Decimals is replaced with the rule that supersedes it.

## Out of scope

Search and embedding indexing (PR 3) — hence no `enqueueSearchIndex`/`enqueueEmbed` in the part apply path. Part targets on `CREATE_SERVICE_RECORD` (its `targets` array is `{ itemId, systemId }` only; a natural follow-up, deliberately not here).

`UPDATE_PART` does not change a part's links — linking is a create-time convenience only. Re-parenting has a UI (PR 1b) and is not worth a proposal kind.
