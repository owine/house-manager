# Conversational capture: Ask becomes read-write

**Date:** 2026-07-26
**Status:** Approved (design)

## Problem

Ask is read-only. It answers questions over items, notes, service records,
warranties, checklists and attachment text, but there is no path in the other
direction: knowledge that lives in the user's head has to be entered through the
normal CRUD forms, one typed field at a time.

Two kinds of knowledge suffer:

- **Incidental events.** "I had to reset the water heater on the 3rd." Recording
  this today means navigating to the item, opening a form, and picking a date.
  The friction means it usually does not get recorded at all.
- **House-general reference knowledge.** Which bulbs are in which fixtures, which
  filter sizes fit which units, which paint is in which room. This spans locations
  and belongs to no single item, so it has no obvious home in the current UI —
  and it is exactly the class of thing the user later wants to *ask* about.

The second class is the larger one. Bulbs are the motivating example, not the
scope.

## Goal

One chat at `/ask` that both answers questions and accepts unstructured dumps,
turning the dumps into structured records the user approves change-by-change.

Notes, items and service records are already embedded and Meilisearch-indexed,
so knowledge captured into them is immediately retrievable through Ask and
search. `System` is the exception — it is in neither `EmbeddingEntityType`
(`prisma/schema.prisma:647`) nor `SEARCH_KINDS` (`lib/search/schema.ts:3-12`);
see §5 and §9 for what that means for `UPDATE_SYSTEM`.

## Non-goals

- Deleting, archiving, or unlinking records. All proposal kinds are creates or
  field updates.
- Reminders and warranties as proposal kinds (see *Deferred*).
- An agentic tool-use loop (see *Deferred*).

## Key existing behaviour this design relies on

Verified against the code during design:

- **`NOTE` is already a first-class retrieval entity.** It is an
  `EmbeddingEntityType` (`prisma/schema.prisma:647`) and a Meili document
  (`lib/search/document.ts:139`). Anything written as a Note becomes ask-able and
  searchable via the existing `enqueueEmbed` / `enqueueSearchIndex` pipeline. No
  new retrieval plumbing is required — **this feature is a write path, not a read
  path.**
- **Untargeted notes already work end to end.** `canonicalizeNote` handles a null
  parent explicitly (`lib/embedding/index.ts:177`), and search indexes notes at
  `/notes/<id>` regardless of parent. House-general knowledge can live in a Note
  with `itemId = null` — **no `NoteTarget` join table is needed.**
- **Server-side ID validation is an established pattern.**
  `validateCandidateIds` (`lib/incoming-email/ai-classify.ts:136`) hands the model
  a candidate list and checks its picks server-side before any write.
- **The four v1 target models all carry `updatedAt`** — `Item` (:158), `System`
  (:114), `Note` (:414), `ServiceRecord` (:285) — which this design uses for
  optimistic concurrency without adding columns to them. Note this is *not*
  universal in the schema: `ReminderTarget`, `Attachment`, `ChecklistItem` and
  others lack it, which constrains the deferred kinds (see *Deferred*).

## Design

### 1. Surface

`/ask` becomes read-write. One chat, one mental model; the model infers from the
turn whether the user is asking or telling. Mixed turns are expected and are a
strength of the unified surface: *"what filter does the furnace take? also I
replaced it Tuesday"* yields both an answer and one proposal.

A turn that produces no proposals renders as an ordinary answer. This is **not**
behaviourally identical to today's `askQuestion`: the output schema, system
prompt, context payload and `AISuggestionLog.kind` all differ. `askQuestion` is
superseded by the new action rather than kept alongside it, and its tests move
with it.

The page's existing `process.env.ASK_ENABLED` gate
(`app/(app)/ask/page.tsx:10`) is retained — it reads `process.env` directly
rather than `getEnv()` so the disabled view renders on a partially-configured
deployment.

### 2. Data model

Three new tables:

```
ChatSession    id, userId, title, createdAt, updatedAt
ChatMessage    id, sessionId, role(USER|ASSISTANT), content,
               aiSuggestionLogId?, createdAt
ChatProposal   id, messageId, kind, targetType, targetId?, payload(Json),
               status(PENDING|ACCEPTED|REJECTED|STALE|ORPHANED|INVALID),
               baseUpdatedAt?, appliedEntityId?, appliedAt?, createdAt
```

Three new enums: `ChatRole`, `ChatProposalKind`, `ChatProposalStatus`.

Changes to existing tables — small but real, so stated explicitly:

- `AISuggestionLog` gains the back-relation field for `ChatMessage.aiSuggestionLogId`.
- `System` gains `metadata Json @default("{}")`, mirroring `Item.metadata`
  (`prisma/schema.prisma:152`). `UPDATE_SYSTEM` is a v1 kind and `System` has no
  JSON column today, so provenance (§9) has nowhere to live.

  **Stated plainly:** because `System` is neither embedded nor Meili-indexed,
  provenance stored here is **UI-only** — it renders as a badge on the system
  detail page but can never surface through Ask or search. That is still worth
  having (the badge is the point of the flag), but it is a weaker payoff than the
  same column on `Item`, and a reviewer will otherwise ask.

`ChatSession.title` is the **first non-empty line of the first user turn,
truncated to 80 characters** on a word boundary. No extra model call — with
8000-character turns now permitted (§7), a naive full prefix would be a poor
title, but a first-line cut is cheap and usually right for a dump that opens with
its subject. Retitling is not in v1.

`aiSuggestionLogId` links
each assistant turn to its `AISuggestionLog` row so the admin AI dashboard keeps
working without special-casing chat.

`ChatProposal.targetId` is a bare polymorphic string with no FK — the same
trade-off `Embedding` already makes (`prisma/schema.prisma:645`), and with the
same cost: no cascade on entity delete. §5 specifies the handling.

### 3. Module layout

Follows the feature-module convention:

- `lib/chat/schema.ts` — Zod. Holds the **entire** model-facing schema: the turn
  envelope *and* the `ChatProposal.payload` discriminated union (§4).
  **Deviation from precedent, deliberate:** `lib/ai/schemas.ts` holds model-facing
  zod for Ask and the email classifier, but the payload union is also the
  persistence contract read back by the apply action, so it belongs with the
  feature. Keeping the envelope there too avoids inverting the dependency
  direction — today `lib/ask/actions.ts:8-13` imports *from* `lib/ai/schemas.ts`
  and never the reverse, and a split would force `lib/ai/schemas.ts` to import
  from `lib/chat/`. **`lib/ai/schemas.ts` is left untouched.**
- `lib/chat/queries.ts` — read-only Prisma, no `'use server'`, no `auth()`. Session
  list and single-session-with-messages-and-proposals reads, for the server
  component that renders history and supports reload.
- `lib/chat/actions.ts` — `'use server'`. The turn action and the apply/reject
  actions.

All of it is reachable from `app/(app)/ask/page.tsx`, so **no `knip.json` `entry`
addition is needed.** Per-kind payload schemas must be consumed internally rather
than speculatively exported, or `lint:knip` will flag them on pre-push.

### 4. Proposal kinds and payload

| kind | target | concurrency | duplicate protection |
|---|---|---|---|
| `CREATE_NOTE` | optional `itemId` | n/a | §12 near-dup check |
| `UPDATE_NOTE` | `Note` | `baseUpdatedAt` | n/a |
| `CREATE_ITEM` | — | n/a | **none** |
| `UPDATE_ITEM` | `Item` | `baseUpdatedAt` | n/a |
| `UPDATE_SYSTEM` | `System` | `baseUpdatedAt` | n/a |
| `CREATE_SERVICE_RECORD` | targets | n/a | **none** |

Idempotency and deduplication are different properties and only one is solved.
The `PENDING` → `ACCEPTED` status transition gives **idempotency** for every
kind: the same proposal cannot be applied twice. It gives no **deduplication**:
two distinct proposals — in one turn or across turns — describing the same new
item will create two rows. `CREATE_NOTE` is protected by §12; `CREATE_ITEM` and
`CREATE_SERVICE_RECORD` are knowingly unprotected in v1, on the grounds that the
user reviews every card before accepting it.

No destructive kinds. Removal stays in the normal UI, where the existing guards
(e.g. `TryDeleteVendorResult`) live.

`payload` is a **discriminated zod union on `kind`**, and is parsed on *read* as
well as on write — a stored payload that fails to parse (because the union
changed after it was written) marks the proposal **`INVALID`** rather than
throwing. This is load-bearing: `payload` is an untyped column read back days
later.

`INVALID` and `ORPHANED` are separate statuses because they need different
explanations in the UI: `ORPHANED` is "the record this refers to was deleted",
`INVALID` is "this proposal predates a schema change and can no longer be
applied". Both are terminal and neither is retryable.

`CREATE_ITEM` requires `categoryId`, which is non-null on `Item`
(`prisma/schema.prisma:142`). The model picks from the snapshot and the server
validates the pick; a miss is rejected, never defaulted.

### 5. Request flow

```
user turn
  -> auth + ASK_ENABLED + rate limit
  -> resolve house "today" via getHouseTimezone(); inject as anchor date
  -> embed turn, retrieveTopK(k=12)
  -> + inventory snapshot in a cache_control system block
  -> one messages.parse -> { reply, proposals[] }
  -> server validates every proposed ID against the snapshot
  -> for CREATE_NOTE: synchronous near-duplicate check (§12)
     -> match rewrites the proposal to UPDATE_NOTE
  -> server re-reads each target row -> computes real before/after diff
  -> persist ChatMessage + ChatProposal rows (status PENDING)
  -> render reply + proposal cards
```

The architecture is **single-shot with a context snapshot** — the shape every
other AI path in this repo uses — combined with **server-owned resolution and
diffing**. The model proposes *intent* (`{ kind, targetRef, fields }`); it never
sees the current value and never mints an ID. The server re-reads the row and
computes the before/after, so the user sees a true diff even though the model
worked blind.

The inventory snapshot extends `buildSuggestContext`
(`lib/ai/context-builder.ts`) to include Systems, categories and locations.
**Caveat on caching:** `lib/ai/client.ts:12` records a 4096-token minimum
cacheable prefix for Haiku 4.5. A small house's inventory may never reach it, in
which case the `cache_control` block is inert. The design does not depend on the
cache hitting; it is an optimisation, not a correctness property.

**Apply** is a separate server action, one proposal at a time:

1. Re-read the target. Missing → `ORPHANED`, return `formError`.
2. Compare `baseUpdatedAt` to current `updatedAt`. Mismatch → `STALE`, recompute
   and re-render the diff, require re-confirmation. `STALE` is not an error.
3. The `PENDING` → `ACCEPTED` status transition is the idempotency guard: an
   already-`ACCEPTED` proposal cannot be applied twice.
4. Write, then fire the side effects **for that kind** — see the table below.
   Side effects stay non-fatal.
5. `revalidatePath` — per kind, per the table below, plus `/ask`.

Both side effects and revalidation are **per-kind**. Getting the first wrong
leaves stale embeddings that Ask keeps matching against old names — the exact
failure `lib/embedding/cascade.ts:4-11` exists to prevent. Getting the second
wrong leaves a stale page after an accepted change.

Steps 1–2 apply to the **update kinds only**; the create kinds have no target row
and no `baseUpdatedAt`.

| kind | side effects | revalidatePath |
|---|---|---|
| `CREATE_NOTE` | `enqueueSearchIndex('note')` + `enqueueEmbed('NOTE')` | `/notes`, `/dashboard`, `/items/<itemId>` if linked |
| `UPDATE_NOTE` | same | as above, **for both the old and new linked item** if re-targeted |
| `CREATE_ITEM` | `enqueueSearchIndex('item')` + `enqueueEmbed('ITEM')` | `/items`, `/dashboard` |
| `UPDATE_ITEM` | the above **plus `enqueueItemRenameCascade`** (`cascade.ts:32`) | `/items`, `/items/<id>`, `/dashboard` |
| `CREATE_SERVICE_RECORD` | `enqueueSearchIndex('service')` + `enqueueEmbed('SERVICE_RECORD')` | `/service-records`, `/dashboard`, `/vendors/<vendorId>`, and **per target** `/items/<id>` / `/systems/<id>` |
| `UPDATE_SYSTEM` | **`enqueueSystemRenameCascade` only** (`cascade.ts:70`) | `/systems`, `/systems/<id>` |

The fanout rows are not embellishment — they mirror what the existing actions
already do: `lib/notes/actions.ts:42,87-88` (old *and* new item),
`lib/service-records/actions.ts:52-53,91` (per-target and vendor),
`lib/items/actions.ts:105`, `lib/systems/actions.ts:20-21`. Reuse those modules'
revalidation helpers rather than re-deriving the paths.

`enqueueItemRenameCascade` is called **unconditionally**, not gated on a name
change — `lib/items/actions.ts:102` has no guard, and `cascade.ts:14-16` explains
why: the embed worker hashes canonical text and skips no-op re-embeds, so
unconditional calls are safe and cheap. Do not add an `if (nameChanged)` guard.

`UPDATE_SYSTEM` is the odd one and must not be written by analogy. `System` is in
neither `SEARCH_KINDS` (`lib/search/schema.ts:3-12`) nor `EmbeddingEntityType`, so
`enqueueSearchIndex('system', …)` and `enqueueEmbed('SYSTEM', …)` **do not
type-check**. The system's name reaches Ask only by denormalisation into its
child items, which is what the cascade re-embeds. This mirrors `updateSystem`
(`lib/systems/actions.ts:55`), which calls the cascade and nothing else.

Diffs must render `@db.Date` values with `formatCalendarDate`. `performedOn` and
friends read back branded as `CalendarDate` (`lib/prisma-extensions.ts:44-49`)
and must never be passed to `tzParts` or `formatHouseDay`.

### 6. Conversation context

Prior turns are replayed from `ChatMessage` rows, not client state, so a reloaded
session reconstructs identically. The existing 20-turn thread cap is retained.
Prior turns' retrieved chunks are **not** re-sent — only the latest turn is
wrapped with retrieved context, matching `lib/ask/actions.ts:153-160`. This bounds
prompt growth to the turn text plus one context block plus the snapshot.

### 7. Input and output limits

The existing `askQuestionInputSchema` caps the last user message at **500
characters** (`lib/ai/schemas.ts:174`). That cap is incompatible with the
feature's premise and must be raised for the capture path: the last user message
gets the same **8000-character** ceiling the schema already applies to
non-terminal messages.

`ANTHROPIC_MAX_TOKENS = 2048` (`lib/ai/client.ts:37`) is a shared **output**
ceiling. A reply plus several proposals carrying full note bodies will exceed it,
and `messages.parse` throws on a truncated response — meaning the failure mode
for a large dump is total loss of the turn, which is precisely the case the
feature exists for.

The chat turn requests **4096**. To avoid churn, this is a new *optional*
parameter defaulting to `ANTHROPIC_MAX_TOKENS`, so the existing importers —
`lib/ask/actions.ts:4` and the two `lib/ai/suggest/` modules — are untouched and
keep their current behaviour. Only the chat call passes the override.

`timeout: 30_000` with `maxRetries: 1` (`lib/ai/client.ts:29-30`) makes timeouts
likelier on an inventory-stuffed prompt than on the Ask path. Accepted for v1; a
failed turn is recoverable by retrying, and §13 keeps the conversation intact.

### 8. Note quality, enforced

Generated notes must be **short and topic-scoped, using `##` headed sections
rather than one large markdown table.** This is a system-prompt instruction
*plus* a server-side check, because the failure it prevents is real:

- `canonicalizeNote` prepends `Note: <title>` to the body
  (`lib/embedding/canonicalize.ts:121`), but chunking happens after
  canonicalisation at ~500 tokens (~2000 chars) (`lib/embedding/index.ts:48,79`).
  The second chunk of a long note is bare body text with no title and no parent
  line, and retrieves badly.
- `chunkText` splits on `\n\n` first, falling back to single newlines
  (`lib/embedding/chunk.ts:46,53`). A markdown table is one block of
  newline-separated rows, so a long table is sliced mid-table and trailing chunks
  are bare rows with **no header row** — column meaning is lost entirely.

A prompt instruction alone leaves this unguarded, so the server enforces a
**~1800-character ceiling** on a proposed note body.

**Scope, stated honestly:** `createNoteSchema.body` allows 20,000 characters
(`lib/notes/schema.ts:5`), so this pathology *already exists* for hand-written
notes and the ceiling does not fix it. It only stops the chat path from adding
more. Retro-fitting the manual note form is out of scope here; if it turns out to
matter, the real fix is prepending the title to every chunk in `buildCanonical`
rather than capping note length anywhere.

**On breach the proposal is dropped, not re-prompted.** The turn's other
proposals still render, and the reply carries a plain note that one was too long
and the user should split the dump by topic. No second Anthropic call: it would
double the cost and open a second 30s timeout window on the path already most
likely to time out (§7), to salvage a case the user can resolve in one line.

This ceiling also keeps §9's in-body provenance markers in the same chunk as the
facts they annotate — the two sections depend on each other.

### 9. Enrichment and provenance

The model may use world knowledge to enrich what the user typed — decoding a bulb
SKU into wattage, lumens, base and colour temperature, for example — but every
inferred value is marked.

- **Notes:** inferred spans are marked in the markdown body itself, so the marker
  flows into the embedding and the Meili document and a later Ask can report that
  a spec was inferred rather than measured. Valid only because §8 bounds note
  length; a marker in chunk 1 would not annotate a fact in chunk 2.
- **Item / System fields:** a provenance map under a **reserved `_provenance`
  key** in `metadata`.

`canonicalizeItem` currently iterates every `metadata` entry into embedded text,
`JSON.stringify`-ing object values (`lib/embedding/canonicalize.ts:109-114`), so
a naive provenance map would inject raw JSON into the item embedding.
`canonicalizeItem` must therefore **skip `_`-prefixed keys**.

It is the **only** canonicalizer that needs the change. There is no
`canonicalizeSystem` — `SYSTEM` is absent from `EmbeddingEntityType` and from
`buildCanonical`'s switch, so `System.metadata` can never reach an embedding.
As noted in §2, System provenance is UI-only.

Proposal cards render inferred fields visually distinctly.

### 10. Dates

Chat input is dense with dates, putting this feature on the repo's most expensive
recurring bug class. `ServiceRecord.performedOn` is `@db.Date`
(`prisma/schema.prisma:279`) — a calendar date, not an instant — and a `date`
column silently truncates a bad write to its UTC day rather than rejecting it.

Per `lib/time/tz.ts`:

- The model returns dates as plain **`YYYY-MM-DD` strings**, never timestamps.
  The server parses them to UTC midnight. **Never through a timezone.**
- Relative expressions ("Tuesday", "last week") are the one legitimate timezone
  use: they resolve against `getHouseTimezone()`, which answers exactly one
  question — what day is it now. The resolved anchor date is injected into the
  prompt (§5) so the model does its arithmetic against the correct "today".
- The action takes an explicit anchor-date parameter, partly for testability.

Both standing defenses are maintained: `CALENDAR_DATE_FIELDS` in
`lib/calendar-date-guard.ts` already covers `ServiceRecord.performedOn`, and its
recursion (`:86-103`) re-enters nested relation writes — which matters because
`CREATE_SERVICE_RECORD` writes `targets: { create: [...] }`. The branding map in
`lib/prisma-extensions.ts` is unchanged, as no new date column is added.

### 11. Rate limiting

`checkRateLimit` counts **every** `AISuggestionLog` row for the user regardless of
`kind` (`lib/ai/rate-limit.ts:13-17`) — one global 10/hour budget shared across
`ask`, `reminders`, `checklist` and the email classifier.

A capture conversation burns three or four turns on a single task, so chat needs
its own budget: `checkRateLimit(userId, kind)` with a per-kind limit map, chat at
40/hour and existing kinds unchanged at 10.

Two consequences to accept explicitly:

- **This relaxes the cap for existing features.** Today Suggest and Ask compete
  for the same 10; afterward each gets its own. The aggregate ceiling rises from
  10/hour to roughly 80/hour, on a feature whose per-turn cost is *higher* than
  Ask's (larger context, plus the §12 dedup query). Acceptable on a single-user
  self-hosted deployment; worth knowing before enabling it.
- `AISuggestionLog.kind` is `String`, not an enum (`prisma/schema.prisma:612`), so
  the per-kind map is stringly-typed with no compile-time exhaustiveness. The map
  needs a total-record type over the known kinds and a default for unknowns.

`lib/ask/actions.ts:107` hardcodes the limit into its user-facing string
(``Hourly limit reached (${rl.used}/10)``). That literal must come from the map.

### 12. Note sprawl: near-duplicate detection

House-general knowledge accrues — bulbs today, bulbs again when a fixture
changes. Without a merge path this produces "Lightbulbs", "Lightbulbs (2)" and
"Bulb types": three notes with contradictory content, all retrieved, making Ask
progressively worse.

Before persisting a `CREATE_NOTE` proposal, the server checks for a
near-duplicate note and, on a match, rewrites the proposal to `UPDATE_NOTE` with
a before/after body diff.

The check is **synchronous and application-side**, not RAG. This is deliberate:
embeddings are written asynchronously by the `embed.content` worker, and
`enqueueEmbed` returns early when `ASK_ENABLED` is false
(`lib/embedding/enqueue.ts:32`). A note created in turn 1 is not retrievable via
RAG in turn 3 of the same conversation — which is exactly the within-session case
this section exists to catch.

**Implementation: character-bigram Dice in TypeScript.** Fetch `{ id, title }`
for all notes, normalise the title (lowercase, strip punctuation and whitespace),
take character bigrams, and score Dice against the draft title. Threshold **0.5**.
Multiple matches → propose against the highest-scoring note only; the user can
reject and re-dump if that was the wrong one.

Character bigrams rather than word tokens, because word tokens are inert on
exactly the short topical titles this feature generates: `"Lightbulbs"` and
`"Filters"` are single tokens, so word-token Dice can only ever return 1.0 or
0.0 against another single-token title. Bigrams also absorb plurals, spacing
(`"Lightbulbs"` / `"Light bulbs"`) and typos.

This avoids `pg_trgm`, which is **not installed** — `prisma/schema.prisma:6-8`
declares pgvector only, and the sole `CREATE EXTENSION` in the tree is
`prisma/migrations/000000000000_squashed_migrations/migration.sql:5`. Enabling it
would need both the extension and hand-written `USING gin (title gin_trgm_ops)`
SQL that Prisma cannot emit, contradicting the Migration section for no benefit
at this data scale. The pure-function form is also trivially unit-testable.

**What this does not catch, stated honestly.** Lexical scoring catches
restatements — `"Lightbulbs"` vs `"Lightbulbs (2)"` vs `"light bulbs"`. It does
**not** catch synonym drift: `"Lightbulbs"` vs `"Bulb types"` scores 0.35 on
character bigrams (and 0.0 on word tokens), below any threshold that would not
also produce false positives. That pair is a semantic relationship, not a string
one, and only the deferred RAG supplement will catch it.

The 0.5 threshold is a **guess pending real data**. `prisma/seed.ts` creates no
notes, so there is no corpus in the repo to calibrate against; the only note
titles that exist are test fixtures. Expect to tune this once there is real
usage, and treat the constant as a knob rather than a settled value.

`UPDATE_NOTE` **replaces the body wholesale** rather than appending. The user
reviews the diff, so supersession is explicit and stale facts do not accumulate.

### 13. Error handling

Reuses `classifyAnthropicError` / `userFacingMessage`
(`lib/ai/suggest/_shared.ts:8,26`). A failed turn persists a `ChatMessage`
carrying the error reason and zero proposals, so the conversation survives and
the `AISuggestionLog` row keeps the admin dashboard's counts accurate. Apply
failures return `ActionResult` `formError` per the canonical skeleton — never a
throw.

### 14. Auth and multi-user

`/ask` is already under `app/(app)/`, the only auth boundary — its layout does the
`auth()` check. All apply actions are server actions carrying their own `auth()`
gate. No new route handlers, so no new inline gates.

`ChatSession.userId` scopes sessions per user, but the entities written are
house-global and `ChatProposal` carries no user column. Apply actions therefore
check session ownership before applying. This is a single-user deployment in
practice; the check is cheap and prevents cross-user apply by proposal id.

## Migration

Three tables, three enums, one added column on `System`, one back-relation field
on `AISuggestionLog`. **No hand-written SQL is required** — the new tables are
polymorphic-by-string like `Embedding`, so no XOR `CHECK` constraint and no
`NULLS NOT DISTINCT` index is needed.

Per CLAUDE.md, the generated migration must still be eyeballed for accidental
DROPs of the manual pgvector IVFFlat index, the XOR `CHECK` constraints on the
multi-target join tables, and the `NULLS NOT DISTINCT` unique indexes.

## Testing

**Unit** (`lib/chat/*.test.ts`, mocked Anthropic, mirroring
`lib/ask/actions.test.ts`):

- `"2026-07-03"` parses to UTC midnight; relative expressions resolve against a
  fixed anchor and a fixed `getHouseTimezone()`. Both directions of the
  calendar-date rule.
- ID validation rejects an ID absent from the snapshot, including `categoryId` on
  `CREATE_ITEM`.
- Character-bigram Dice is a pure function: scores above/below the 0.5 threshold,
  multiple matches resolve to the highest-scoring note, and single-token titles
  score sensibly rather than collapsing to 1.0/0.0.
- Near-duplicate detection rewrites `CREATE_NOTE` to `UPDATE_NOTE`, and catches a
  within-session duplicate (the case RAG cannot).
- A note body over the length limit drops that proposal, leaves the turn's other
  proposals intact, and surfaces the explanation in the reply.
- Inferred fields survive into the payload, into note markdown, and into
  `_provenance`; `canonicalizeItem` omits `_`-prefixed keys.
- Payload union round-trips; an unparseable stored payload yields `INVALID`
  rather than a throw.
- Per-kind rate limiting, including that existing kinds still cap correctly and
  the user-facing string reports the right number.

**Integration** (Testcontainers, real Postgres) — covering all six kinds:

- Each kind applies, sets `appliedEntityId` / `appliedAt`, flips status, and
  fires the side effects listed for **that kind** in §5 — in particular that
  `UPDATE_SYSTEM` fires the cascade and nothing else, and that `UPDATE_ITEM`
  fires the rename cascade in addition to index + embed.
- `baseUpdatedAt` mismatch yields `STALE` and performs no write.
- A deleted target yields `ORPHANED` and performs no write.
- Re-applying an `ACCEPTED` create proposal is a no-op, not a duplicate row.
- `CREATE_SERVICE_RECORD` with nested `targets: { create: [...] }` passes the
  calendar-date guard.
- Applied notes land in the `embeddings` table.

**E2E:** one `@critical` spec — dump text, proposal card appears, accept, record
exists. Non-critical specs cover reject, stale, and session reload.

**Date time-bombs:** every date test injects a fixed `today` rather than reading
the clock. Tests asserting "Tuesday resolves to July 21" pass today and fail next
week; this already bit the repo in PR #205/#206.

**Coverage:** new `lib/chat/` code must clear the existing floor. Per CLAUDE.md a
red coverage job is never fixed by lowering a threshold in `vitest.config.ts`.

## Deferred

- **Reminders and warranties as proposal kinds.** Reminders drag in recurrence
  rules and the `reminder_targets` XOR relaxation; warranties need date-range
  validation. Both also need a concurrency answer that `baseUpdatedAt` does not
  give: reminder edits mostly land on `ReminderTarget`, which has no `updatedAt`.
- **Agentic tool-use loop.** `search_entities` / `read_entity` tools would let the
  model read actual current values and scale past stuffing the inventory into
  context. The right v2 — but nothing in this repo does agentic loops yet, and the
  pinned `claude-haiku-4-5` (`lib/ai/client.ts:36`) has less headroom than a loop
  wants.
- **RAG-based cross-session note deduplication**, layered over §12's synchronous
  check.
- **A sweeper for stale `PENDING` proposals**, analogous to `notify-log.sweep`.
- **Destructive proposal kinds.**

## Decisions

| Decision | Choice |
|---|---|
| Surface | Unified — `/ask` becomes read-write, supersedes `askQuestion` |
| Write scope | Full read-write, per-change approval, no deletes |
| Approval | Inline cards + persisted `ChatSession` |
| Enrichment | Allowed, flagged as inferred, `_provenance` key excluded from embeddings |
| Architecture | Single-shot + snapshot; server owns ID resolution and diffing |
| Concurrency | `baseUpdatedAt` vs. `updatedAt` on the four v1 target models |
| Deleted target | `ORPHANED`; unparseable payload `INVALID`; no FK, matching `Embedding` |
| Side effects | Per-kind, not uniform; `UPDATE_SYSTEM` is cascade-only |
| Note targeting | `itemId` optional; untargeted notes already work |
| Note length | Server-enforced ~1800 char ceiling; breach drops that proposal |
| Note sprawl | Application-side character-bigram Dice ≥ 0.5, no `pg_trgm`, no RAG; synonym drift not caught |
| Input cap | Last user message raised 500 → 8000 chars |
| Output cap | Optional `max_tokens` param, default unchanged; chat requests 4096 |
| Rate limit | `checkRateLimit(userId, kind)`, chat at 40/hour |
| Schema changes | 3 tables, 3 enums, `System.metadata`, one back-relation |
