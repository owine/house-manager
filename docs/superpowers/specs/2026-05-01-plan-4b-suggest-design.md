# Plan 4b — Suggest: AI-generated reminders & checklists

**Date:** 2026-05-01
**Status:** Draft for review
**Authors:** Oliver Wine (with Claude)
**Parent spec:** `docs/superpowers/specs/2026-04-26-house-manager-design.md`
**Builds on:** Plans 1, 2a, 2b, 2c, 3, and 4a — all shipped to main as of 2026-05-01.

## Overview

Plan 4b adds **Suggest**: AI-powered structured generation of maintenance reminders and seasonal checklists, grounded in the user's actual inventory and `HouseProfile`. A user clicks a button — on the dashboard, on an item detail page, in a checklist editor, on a standalone `/suggest` page, or on a post-create interstitial — and Claude Haiku 4.5 returns a list of proposals. The user picks which to accept (with optional inline edits to title and recurrence) and saves selected rows in bulk.

This is the second of three Plan 4 milestones. Plan 4a shipped **Find** (Meilisearch keyword search). Plan 4c will ship **Ask** (RAG over user documents, OCR, embeddings, pgvector chunks). Plan 4b is structurally simpler than the other two: it is **synchronous, user-initiated, low-volume**, and uses no worker queue. Each Suggest call is a Server Action that builds context, calls `anthropic.messages.parse()` with a Zod schema, logs the result, and returns proposals to the client.

Plan 4b also lands the deferred **Checklist** template tables. `ChecklistRun` / `ChecklistRunItem` are not added — runs are out of scope for v1; templates alone make Suggest demonstrable end-to-end.

## Goals

1. Ship a Suggest capability that produces grounded, useful, schema-validated proposals on the typical household-scale dataset (≤200 items).
2. Cover all 5 entry points named in the master spec — dashboard, item detail, post-create interstitial, checklist editor, standalone `/suggest` page.
3. Establish the **Anthropic SDK + structured-output (`messages.parse`)** call pattern that Plan 4c's RAG path will reuse for non-structured streaming.
4. Land Checklist templates (and surface them in `/checklists`) so AI-generated checklists save into a real, editable, searchable shape.
5. Capture every Suggest call in `AISuggestionLog` with enough telemetry (tokens, cache hits, latency, accept rate) to spot regressions and tune prompts later.
6. Stay within the existing infrastructure — no new services, no worker queues. One new env var (`ANTHROPIC_API_KEY`), one new dependency (`@anthropic-ai/sdk`).

## Non-goals

- **`ChecklistRun` / `ChecklistRunItem` tables and run UI.** Templates only in v1. Run-tracking is a separate feature; deferred to Plan 5.
- **RRULE recurrence in proposals.** The model returns `interval` / `monthly` / `yearly` sugar shapes from the `Recurrence` discriminated union. RRULE is reserved for the user's manual editor, not the AI output schema.
- **Per-resource ACL on suggestions.** Single-household model. All authed users see and can act on all suggestion artifacts.
- **In-flight item-create Suggest.** The "Suggest reminders" step at item-create time is implemented as a **post-save interstitial** rather than as a modal over the in-flight form. Real `itemId` simplifies the Server Action contract.
- **Streaming responses.** `messages.parse()` is non-streaming by design (it parses on completion). A "Thinking…" spinner is shown for the ~1-3s call.
- **Extended (1-hour) prompt caching.** Default 5-min ephemeral cache is sufficient for a single-session burst.
- **Plan 4c's Ask / RAG / embeddings.** All vector / pgvector / Voyage work is Plan 4c. Plan 4b uses no embeddings.
- **OCR.** Plan 4c.
- **Multi-language prompting.** English-only.
- **Admin dashboard beyond the basics.** A simple `/admin/ai` stats section is included; richer analytics defer to Plan 5.

## Architecture

### Components

```
┌─ UI entry points ──────────────────────────────────────────┐
│ /(app)/dashboard         "Generate {Spring} checklist" btn │
│ /(app)/items/[id]        "Suggest reminders" button        │
│ /(app)/items/new (post)  Interstitial /items/[id]/         │
│                            suggest-after-create            │
│ /(app)/checklists/[id]   "Suggest items to add" button     │
│ /(app)/suggest           Free-form prompt + kind selector  │
└────────────────────────────┬───────────────────────────────┘
                             ▼
┌─ Server Actions (lib/ai/suggest/actions.ts) ───────────────┐
│  proposeReminders({ itemId? })                             │
│      → { logId, proposals: ProposedReminder[] }            │
│  proposeChecklist({ season? | freeFormPrompt? })           │
│      → { logId, name, description?, items: [...] }         │
│  saveAcceptedReminders({ logId, accepted[], itemId? })     │
│  saveAcceptedChecklist({ logId, name, items[] })           │
└────────────────────────────┬───────────────────────────────┘
                             ▼
┌─ lib/ai/ ──────────────────────────────────────────────────┐
│  client.ts            Anthropic singleton (env-keyed)      │
│  context-builder.ts   inventory + HouseProfile + season    │
│  schemas.ts           Zod: proposedReminderSchema, etc.    │
│  prompts.ts           system prompt + SYSTEM_PROMPT_VERSION│
│  log.ts               write/update AISuggestionLog rows    │
│  rate-limit.ts        per-user counter (Postgres)          │
└────────────────────────────┬───────────────────────────────┘
                             ▼
                Anthropic Claude Haiku 4.5
                (messages.parse + zodOutputFormat,
                 prompt caching on system+inventory)
```

Key contract: every Suggest action follows the same shape — **build context → call `messages.parse` → log response → return `{ logId, proposals[] }`** to the client. `saveAccepted*` actions take `logId` to update `acceptedItemIds` on the log row.

### Why no worker queue

Plan 4a established a per-action enqueue → pg-boss → worker pattern for Meilisearch sync. Plan 4b deliberately does not use it. Suggest is:

- **User-initiated** — the user is staring at a spinner waiting for the result. A worker would just add a polling layer.
- **Low-volume** — bounded by per-user rate limit (10/hr). At household scale this is dozens of calls per week, total.
- **Synchronous-friendly** — Haiku 4.5 + structured output completes in ~1-3s on this prompt size. Acceptable Server Action latency.

Only writes that the *user is not waiting on* (search index sync, embedding sync in Plan 4c, push notifications in Plan 3) belong in the worker.

## Data model

### New models

```prisma
model Checklist {
  id          String          @id @default(cuid())
  name        String
  description String?         // markdown
  schedule    Json?           // null = ad-hoc; same shape as Reminder.recurrence
  nextDueOn   DateTime?
  active      Boolean         @default(true)
  createdAt   DateTime        @default(now())
  updatedAt   DateTime        @updatedAt
  items       ChecklistItem[]
}

model ChecklistItem {
  id          String     @id @default(cuid())
  checklistId String
  position    Int
  title       String
  itemId      String?    // optional FK to a household Item
  checklist   Checklist  @relation(fields: [checklistId], references: [id], onDelete: Cascade)
  item        Item?      @relation(fields: [itemId], references: [id], onDelete: SetNull)
  @@index([checklistId, position])
}

model AISuggestionLog {
  id                   String    @id @default(cuid())
  userId               String
  kind                 String    // "reminders" | "checklist"
  systemPromptVersion  String    // e.g. "v1"
  userPrompt           String?   // free-form text from /suggest, or null
  inventorySnapshotIds String[]  // item IDs included in context
  response             Json?     // parsed Claude output, null on error
  acceptedItemIds      Json      @default("[]")  // updated on save
  errorReason          String?   // "rate_limited" | "upstream_5xx" | "timeout" | "schema_violation" | "user_rate_limit"
  model                String    // "claude-haiku-4-5"
  inputTokens          Int?
  outputTokens         Int?
  cacheReadTokens      Int?
  cacheCreationTokens  Int?
  latencyMs            Int?
  createdAt            DateTime  @default(now())
  user                 User      @relation(fields: [userId], references: [id])
  @@index([userId, createdAt])
}
```

### Modified

```prisma
model Item {
  // ... existing fields
  includeInSuggestions Boolean  @default(true)
}
```

The default-`true` column add is zero-downtime; existing rows backfill via the default.

### Migration

Single migration `20260501_plan_4b_suggest`. One `prisma migrate dev` step. No data backfill.

### Notes on choices

- **`ChecklistItem.itemId` `onDelete: SetNull`** rather than cascade — keeps the checklist intact when a referenced item is deleted, since the checklist row often remains meaningful (e.g., "Replace HVAC filter" still applies after the unit is replaced).
- **`AISuggestionLog.acceptedItemIds: Json`** instead of separate columns. Mixed kinds (reminder IDs vs checklist-item IDs) live in a single `string[]` JSON array. Querying it as relational columns would require two foreign-key columns and a CHECK constraint; the JSON array is honest about "this is observability data, not relational." Implementation note: `acceptedItemIds` is `Json` (queried with Postgres JSON operators / Prisma `Json` filters) while `inventorySnapshotIds` is `String[]` (Postgres array, queried with `has` / `hasSome`). The admin stats page must use the right operators for each — a single `length` calculation across both columns is not portable.
- **No `householdId`** — single-household model is repo-wide.

## AI call shape

### Zod schemas (`lib/ai/schemas.ts`)

Single source of truth — same schema used for `messages.parse()`, preview-form validation, and DB insert validation.

```ts
import { z } from 'zod';

const recurrenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interval'), days: z.number().int().min(1).max(3650) }),
  z.object({ kind: z.literal('monthly'), dayOfMonth: z.number().int().min(1).max(31) }),
  z.object({ kind: z.literal('yearly'), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) }),
]);

export const proposedReminderSchema = z.object({
  title: z.string().min(3).max(120),
  description: z.string().max(500).optional(),
  recurrence: recurrenceSchema,
  leadTimeDays: z.number().int().min(0).max(60).default(3),
  rationale: z.string().max(200).describe('One sentence explaining why this reminder is suggested'),
});

export const proposeRemindersResponseSchema = z.object({
  proposals: z.array(proposedReminderSchema).max(10),
});

export const proposedChecklistItemSchema = z.object({
  title: z.string().min(3).max(120),
  itemId: z.string().nullable().describe('ID of household item this row is about, or null'),
  rationale: z.string().max(200),
});

export const proposeChecklistResponseSchema = z.object({
  name: z.string().min(3).max(80),
  description: z.string().max(500).optional(),
  items: z.array(proposedChecklistItemSchema).min(1).max(20),
});
```

`itemId` is omitted from `proposedReminderSchema` because it's the entry-point context's job to attach it server-side, not the LLM's. Item-detail flow attaches the focused item; dashboard flow leaves it null.

### Prompt structure

```
[SYSTEM]                                            ← cached
  You are a household maintenance assistant for {householdName}.
  Suggest evidence-based maintenance tasks. Be specific about what
  the user owns. Always include a one-sentence `rationale`.
  Privacy: do not invent items not in the inventory.
  Schema version: v1.

[SYSTEM] House profile                              ← cached
  Location: {city}, {climateZone}
  Property type: {propertyType}
  Today: {YYYY-MM-DD}
  Season: {spring|summer|fall|winter}

[SYSTEM] Inventory ({n} items)                      ← cached
  - id=cuid1 | "Carrier Furnace" | HVAC | Basement | Carrier 58STA
  - id=cuid2 | "Honda Mower"     | Tool | Garage   | Honda HRX217
  ...
  ← cache_control: { type: 'ephemeral' } breakpoint here

[USER] (per-call, NOT cached)
  Generate reminders for item id=cuid1.
   -- or --
  Generate a {Spring} maintenance checklist.
   -- or --
  {free-form prompt from /suggest}
```

### Caching mechanics

- Anthropic prompt caching is positional: everything before the last `cache_control` marker is cached.
- Cache TTL: default 5min ephemeral. No 1-hour beta in v1.
- `inputTokens`, `cacheReadTokens`, `cacheCreationTokens` come back on every response. All three are logged.

### Call site

```ts
// lib/ai/suggest/actions.ts (excerpt)
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const result = await anthropic.messages.parse({
  model: 'claude-haiku-4-5',
  max_tokens: 2048,
  system: [
    { type: 'text', text: SYSTEM_PROMPT },
    { type: 'text', text: houseProfileBlock },
    { type: 'text', text: inventoryBlock, cache_control: { type: 'ephemeral' } },
  ],
  messages: [{ role: 'user', content: userBlock }],
  output_config: { format: zodOutputFormat(proposeRemindersResponseSchema) },
});
```

`result.parsed_output` is typed and validated. **Implementation note:** confirm that `output_config` is supported on Haiku 4.5 in the current SDK version at implementation time. If it isn't (extremely unlikely — structured outputs are a model-family-wide feature), fall back to forced tool-use with the same Zod schema converted via `betaZodTool`.

### Empty proposals

If `result.parsed_output.proposals.length === 0`, the action returns successfully — the UI shows a "No suggestions for this context" state. Logged as a normal row, not an error.

### Inventory line format

Pipe-delimited: `- id=<cuid> | "<name>" | <category> | <location> | <manufacturer> <model>`. ~25 tokens per item. The model parses this without trouble.

### Privacy filters in the context builder

Always applied:

- `where: { archivedAt: null, includeInSuggestions: true }`
- `aiIndexable` and `Attachment.extractedText` are not used in 4b — those are 4c (Ask) concerns.

`SYSTEM_PROMPT_VERSION` is a string constant in `lib/ai/prompts.ts`. Bump on any prompt change so old log rows stay attributable.

## Application surface

### Server Actions (`lib/ai/suggest/actions.ts`)

```ts
'use server';

export async function proposeReminders(input: { itemId?: string }): Promise<{
  logId: string;
  proposals: ProposedReminder[];
} | { error: string }>;

export async function proposeChecklist(
  input:
    | { mode: 'seasonal'; season: 'spring' | 'summer' | 'fall' | 'winter' }
    | { mode: 'freeform'; freeFormPrompt: string }
    | { mode: 'append'; forChecklistId: string },
): Promise<{ logId: string; name: string; description?: string; items: ProposedChecklistItem[] } | { error: string }>;
//
// The three modes are mutually exclusive (discriminated union enforced by Zod
// at the action boundary). Composing "seasonal items appended to existing
// checklist X" is not supported in v1 — the user can save the seasonal
// suggestion and then run "Suggest items to add" against it.

export async function saveAcceptedReminders(input: {
  logId: string;
  accepted: ProposedReminder[];
  itemId?: string;
}): Promise<{ savedIds: string[] } | { error: string }>;

export async function saveAcceptedChecklist(input: {
  logId: string;
  name: string;
  description?: string;
  items: ProposedChecklistItem[];
  appendToChecklistId?: string;
}): Promise<{ checklistId: string } | { error: string }>;
```

All four gated by `requireSession()`.

### UI components

**Shared (`app/(app)/_components/SuggestionPreview.tsx`):** polymorphic on `kind: "reminders" | "checklist"` (two values, not three). The "add items to an existing checklist" flow is the same `kind="checklist"` view with an `appendToChecklistId` prop — the rows are structurally identical to the new-checklist case, only the save action differs. Renders rows with checkbox + collapsed/expanded view. Inline edit on title + recurrence (per discussion, called "B-minimal" — no description/lead/auto-svc-record edit in the preview; those are one click away on the saved row). `rationale` shown as muted helper text, not editable. Built on RHF `useFieldArray`.

**Per-entry-point hosts:**

| Entry point | Host | Trigger |
|---|---|---|
| `/dashboard` | `<SeasonalChecklistCard>` (new) | Button "Generate {season} checklist" → dialog with `<SuggestionPreview kind="checklist">` (mode: seasonal) |
| `/items/[id]` | "Generate reminders" button on item detail | Inline expandable section (not a new tab) under existing tabs |
| `/items/new` post-save | `/items/[id]/suggest-after-create` page | Auto-rendered after item create redirects |
| `/checklists/[id]` | "Suggest items to add" button on the editor | Dialog with `<SuggestionPreview kind="checklist" appendToChecklistId={id}>` (mode: append) |
| `/suggest` | New page | Top: kind selector + free-form textarea + optional item picker. Bottom: `<SuggestionPreview>` after submit |

**Settings (`/settings` or item-detail overflow menu):** per-item `includeInSuggestions` toggle. UI placement: item-detail overflow menu (kebab) — keeps it out of the main create/edit form, since it's a power-user privacy concern.

**Loading state:** "Thinking…" spinner with cancel button. Cancel aborts the client wait but the in-flight Server Action completes and writes its log row regardless.

**Error states:** toast on Anthropic failure; "No suggestions" UI when proposals are empty.

### Search index extension

`Checklist` is added as a new `kind` to the unified `house` Meilisearch index built in Plan 4a. Server Action calls `boss.send(Queue.SearchIndex, { kind: 'checklist', id, op })` after every checklist create/update/delete. `ChecklistItem` is a child and not indexed independently. `lib/search/document.ts` gets a `buildChecklistDocument(id)` case.

### Admin

`/admin/ai` (new section on the existing admin page): total calls today, failure rate, accept rate, average latency, total tokens. Read straight from `AISuggestionLog`. Admin-only via existing role gate.

## Errors, rate limits, observability

### Error matrix

| Failure | Where caught | User sees | Logged |
|---|---|---|---|
| Anthropic 429 | SDK retry once + manual retry once after 2s | Toast "Service busy — try again in a minute" | `errorReason: "rate_limited"` |
| Anthropic 5xx | Same retry path | Toast "Couldn't reach AI service" | `errorReason: "upstream_5xx"` |
| Anthropic timeout (30s) | `AbortController` server-side | Toast "Took too long — try again" | `errorReason: "timeout"` |
| Schema parse failure | `messages.parse()` throws | Toast "Got an unexpected response — try again" | `errorReason: "schema_violation"` + raw text |
| Empty proposals | Not an error | "No suggestions" UI | normal log row |
| Per-user rate cap | `lib/ai/rate-limit.ts` before API call | Toast "Hourly limit reached (10/hr)" | `errorReason: "user_rate_limit"`, no API call |
| User-supplied prompt > 2K chars | Zod input validation | Form-level error | not logged |

### Rate limit

- Per-user, **10 calls/hour**.
- Implementation: `SELECT count(*) FROM "AISuggestionLog" WHERE "userId" = $1 AND "createdAt" > NOW() - INTERVAL '1 hour'`. Reuses the log itself; no new table.
- Returned as a structured error so the UI can show `X/10 used this hour`.

### Auth gates

- All Suggest Server Actions: `requireSession()`. Single-household model — any signed-in user may suggest.
- `saveAccepted*` actions: same gate. Reminder / Checklist rows don't have user ownership in the schema, but `AISuggestionLog.userId` records who triggered the action.

### Observability

- Pino structured log at the action boundary: `{ event: 'ai.suggest', kind, userId, latencyMs, inputTokens, outputTokens, cacheReadTokens, ok: bool }`.
- `/admin/ai` page reads `AISuggestionLog` directly.

## Testing

### Layout

```
tests/
├── unit/ai/
│   ├── context-builder.test.ts
│   ├── prompts.test.ts
│   ├── schemas.test.ts
│   └── rate-limit.test.ts
├── unit/checklists/
│   └── actions.test.ts
├── integration/ai/
│   ├── propose-reminders.test.ts
│   ├── propose-checklist.test.ts
│   ├── save-accepted.test.ts
│   └── error-paths.test.ts
├── integration/search/
│   └── checklist-index.test.ts
├── e2e/
│   ├── suggest-from-item.spec.ts
│   ├── suggest-seasonal.spec.ts
│   └── suggest-after-create.spec.ts
├── smoke/                                  # NIGHTLY ONLY
│   └── ai-suggest.smoke.test.ts
└── fixtures/suggest/
    ├── reminders-furnace.json
    ├── reminders-mower.json
    ├── checklist-spring.json
    └── checklist-empty.json
```

### Mock surface

`tests/setup/anthropic-mock.ts` mocks `@anthropic-ai/sdk` via `vi.mock`. `mockMessagesParse(fixture)` sets the next response. **Default behavior throws** so tests must opt in explicitly — prevents silent passes on un-mocked AI calls.

### Fixtures

Real recorded responses from a one-time manual smoke run, hand-edited as needed. Checked into git. Regenerated by re-running the smoke test on schema changes.

### CI integration

- `pnpm test` (existing) — unit + integration + e2e with mocks. Fast, deterministic, free.
- `pnpm test:smoke` (new) — runs `tests/smoke/`. Wired to a **nightly GitHub Actions job** with `ANTHROPIC_API_KEY` from secrets. Failure auto-opens a GitHub issue.
- `pnpm test:smoke` is **not** run on PRs.

### Critical assertions

- Context builder excludes archived + `includeInSuggestions=false`.
- `messages.parse` is called with `cache_control` marker on the inventory block.
- `saveAccepted*` actions update `AISuggestionLog.acceptedItemIds` AND insert child rows in a single Prisma transaction.
- Rate limit blocks the 11th call within an hour.
- Empty proposals don't trigger error UI.

Cache hit rate is observed via production `cacheReadTokens`, not unit-tested.

## Build sequence

The full implementation plan will be authored by the writing-plans skill from this spec. The rough phasing:

1. Schema + migration (Item.includeInSuggestions, Checklist, ChecklistItem, AISuggestionLog).
2. `lib/ai/` foundation: client, schemas, prompts, context-builder, log, rate-limit. Pure modules + unit tests.
3. Server Actions: proposeReminders, proposeChecklist, saveAccepted*. Integration tests with mocked Claude.
4. Checklist CRUD UI: `/checklists` index (list of templates) and `/checklists/[id]` editor + Meilisearch index extension. Both pages are in scope for 4b — the index page is the entry point for finding existing checklists; the editor is where saved AI-generated checklists land.
5. SuggestionPreview shared component.
6. Five entry-point hosts.
7. Settings: per-item `includeInSuggestions` toggle.
8. Admin `/admin/ai` stats page.
9. Smoke test + nightly CI workflow.
10. E2E coverage.

Each step ends with green tests + a commit. Step 1 lands schema with no feature flag (additive only). Steps 2-3 are usable from a Server Action call but invisible to users. Step 6 lights up the feature. Steps 7-10 are polish/observability and may land in any order after 6.

## Dependencies & environment

- Add `@anthropic-ai/sdk` (latest patch). Patch-pinned per repo convention.
- New env var `ANTHROPIC_API_KEY` in `lib/env.ts` Zod schema (required at runtime). Add a placeholder in the Docker build env, matching the convention from commit `4f8b6f0` for VAPID.
- No new services, no new docker-compose entries.

## Cost & performance

- Per Suggest call: ~6K input tokens (mostly cached after first call), ~500-1000 output tokens, Haiku 4.5.
- First call in a session: ~$0.005. Subsequent cached calls: ~$0.001 (≈80% reduction on cached prefix).
- Latency: ~1-3s wall-clock for `messages.parse()`.
- Storage: `AISuggestionLog` rows ~5KB each (parsed response is the bulk). At ~100 calls/year = ~500KB/year. Negligible.

## Open questions for review

- **Haiku 4.5 + `output_config` confirmation.** SDK docs example shows Sonnet 4.5; we expect Haiku 4.5 to support it identically (model-family-wide feature) but should confirm during implementation. Fallback: forced tool-use via `betaZodTool` with the same Zod schemas.
- **Rate limit window.** 10/hr is a foot-gun guard, not adversarial protection. If the actual usage pattern bumps against it during dogfooding, raise to 20/hr or move to a sliding window — both are one-line changes.
