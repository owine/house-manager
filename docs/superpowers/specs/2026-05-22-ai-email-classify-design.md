# AI-assisted incoming-email classification — Design

**Date:** 2026-05-22
**Status:** Approved (design)
**Branch:** `feat/ai-email-classify` (off `main`)
**Context:** The Inbox feature ingests vendor emails and tries to auto-stub a draft `ServiceRecord`. A registered vendor's real invoice/receipt failed to do so: the **heuristic** classifier returned `kind=UNKNOWN`, `vendorMatched=false` (both keyword and vendor matching are brittle), so nothing was stubbed — and because the AI extract step is gated behind a service-worthy kind, no Anthropic call ran, which is also why the admin AI page showed "No AI calls." This replaces the heuristic gate with an AI classify+extract pass.

## Problem

`lib/incoming-email/classify.ts` classifies kind via fixed keyword regexes and matches vendors via 5 string heuristics. Real vendor mail (billing-platform senders, "receipt"/"statement" wording, names not in the body) slips through to `UNKNOWN`/no-vendor. Today's pipeline: heuristic **classify** → (only for TICKET/INVOICE/ESTIMATE) AI **extract** → auto-stub only when `kind===TICKET` + vendor + target. Two failure modes converge: brittle classification, and an auto-stub policy that excludes invoices.

## Decisions (from brainstorming)

- **AI-first, one call per ingested email.** Volume is low (dedicated forwarding address); a single Anthropic call per email is acceptable. No cost pre-filter.
- **Unify classify + extract** into one `messages.parse` call returning kind + vendor + target + cost/date/scope + confidence. Removes the brittle gate and the second call.
- **Auto-stub kinds: TICKET + INVOICE** (completed work). ESTIMATE classifies/extracts but stays review-only. Gated additionally on **`confidence === high`** + vendor + target.
- **Fallback:** pg-boss retries transient AI failures; on sustained failure, fall back to the existing heuristic `classifyEmail` (kept, with its tests) for best-effort kind/vendor/target.

## Architecture

### New AI module — `lib/incoming-email/ai-classify.ts`

`aiClassifyExtract(input)` — mirrors `worker/jobs/extract-incoming-email.ts`'s call shape (PDF document blocks first, then text; `getAnthropic().messages.parse` with `zodOutputFormat`; `ANTHROPIC_MODEL`/`ANTHROPIC_MAX_TOKENS`; PDF size caps reused).

**Input:** `{ fromAddress, fromName, subject, bodyText, emailDate, pdfs }` plus **candidate lists** `vendors: {id,name}[]`, `items: {id,name}[]`, `systems: {id,name}[]` (same lists the heuristic receives). The prompt renders the candidates as numbered lists and instructs the model to return the matching **id** (or null) — never free text.

**Output schema** (new, in `lib/ai/schemas.ts`) `incomingEmailClassifyExtractSchema`:
```ts
{
  kind: 'ESTIMATE' | 'INVOICE' | 'TICKET' | 'UNKNOWN',
  vendorId: string | null,        // MUST be one of the candidate vendor ids
  targetItemId: string | null,    // item XOR system (model told to pick at most one)
  targetSystemId: string | null,
  confidence: 'low' | 'medium' | 'high',
  // existing extraction fields, carried over verbatim:
  summary: string | null,
  cost: number | null,            // nonnegative
  performedOn: string | null,     // YYYY-MM-DD
  scope: string | null,           // markdown
  rationale: string,              // confidence/caveats sentence
}
```
The system prompt = the current extract prompt (cost/performedOn/scope rules) **plus** classification guidance (what each kind means; pick vendor/target id from the candidates or null; how to judge confidence). `confidence` is an enum (not a 0–1 float) — coarse and easier for the model to calibrate; only `high` drives auto-stub.

> **Two different `kind`s — don't conflate:** `IncomingEmail.kind` is the Prisma enum `IncomingEmailKind` (`ESTIMATE/INVOICE/TICKET/UNKNOWN`); the AI schema's `kind` enum uses those exact four values, so it maps straight onto the column with **no migration and no new enum value**. Separately, `CreateLogInput.kind` (the AI *log* kind) is a plain string-column union; adding `'incoming-email-classify'` there is a code-only union edit, also no migration.

### Worker orchestration — `worker/jobs/classify-incoming-email.ts`

Becomes the single AI-driven job:
1. Load the email row + candidate vendor/item/system lists + PDF text/attachments (as today, incl. the `loadPdfTextForEmail` augmentation and the `ownsRow` state guard).
2. Call `aiClassifyExtract`.
3. **ID-hallucination guard:** discard any returned `vendorId`/`targetItemId`/`targetSystemId` not present in the candidate lists (LLMs can invent ids). A dropped id becomes `null`.
4. Validate `performedOn` parses to a real date (reuse extract's check; prefer null over a bad date).
5. Persist `kind`, `vendorId`, targets (replace-set, gated by `ownsRow`), and the `aiExtracted*` fields, in the existing transaction shape. Set `state` AUTO_LINKED/UNTRIAGED by the same rule.
6. **Log** every call (success and error) via `createSuggestionLog` with a new `kind: 'incoming-email-classify'` (the `CreateLogInput.kind` union gains this value — string column, no migration). This restores admin "By kind" visibility.
7. **Auto-stub** a draft `ServiceRecord` when `kind ∈ {TICKET, INVOICE}` **and** a validated `vendorId` **and** a validated target **and** `confidence === 'high'`, reusing the existing stub transaction (vendor, `performedOn = aiExtractedPerformedOn ?? receivedAt`, `summary = aiExtractedSummary ?? subject`, `notes = aiExtractedScope ?? '[Auto-created…]'`, link via `createdServiceRecordId`, skip if already linked). Otherwise classify only — the inbox keeps its one-click promote.

**Removed / collapsed — exact call sites.** `worker/jobs/extract-incoming-email.ts`, the `Queue.ExtractIncomingEmail` member (`lib/queue.ts`; `QUEUES` auto-derives from `Object.values`, so removing the line drops its registration cleanly), and the extract job registration + startup-log string + comment block in `worker/index.ts` are removed. Because the job now classifies **and** extracts, the existing **`reclassifyIncomingEmail`** action (`lib/incoming-email/actions.ts`, → `Queue.ClassifyIncomingEmail`) and **`reextractIncomingEmail`** (same file, → `Queue.ExtractIncomingEmail`) become the **same operation** — collapse to one:
- Keep a single re-run action on `Queue.ClassifyIncomingEmail` (repoint or remove `reextractIncomingEmail`; keep `reclassifyIncomingEmail`).
- `components/incoming-email/ReextractButton.tsx` + its use in `components/incoming-email/ExtractedFieldsCard.tsx` (incl. the `canReextract` gate and the "try again via Re-extract above" empty-state copy) → point at the unified action and relabel to "Re-run AI" (or fold into the existing reclassify affordance if one is already rendered).
- Update the two integration tests that assert the old behavior: `tests/integration/incoming-email-actions.test.ts` (asserts `reextract` enqueues `incoming-email.extract`) and `tests/integration/incoming-email-extract-job.test.ts` (the extract-job suite — port its meaningful cases onto the unified job or replace).

> The exact button/affordance reconciliation (one re-run control, not two) is settled in the plan after eyeballing `ExtractedFieldsCard` and any reclassify button, but the decision is fixed: **one unified re-run path on `Queue.ClassifyIncomingEmail`; no `Queue.ExtractIncomingEmail`.**

**System-user lookup moves into this job.** The `createSuggestionLog` call needs a `userId`; today the *extract* job does `prisma.user.findFirst({ orderBy: { createdAt: 'asc' } })` with a skip-if-none guard. The unified classify job must carry that lookup forward (the current classify job doesn't have it).

### Fallback

On `aiClassifyExtract` throwing (after pg-boss's retries), catch, log the error (`createSuggestionLog` with `errorReason` + a warn line), then run the existing pure `classifyEmail(...)` for best-effort kind/vendor/target (no extract fields), persisting through the same path. The heuristic module and its tests stay.

## Error handling

- Transient Anthropic errors → throw → pg-boss retry (existing behavior).
- Sustained failure → heuristic fallback (above).
- Hallucinated ids → dropped by the guard.
- Bad `performedOn` → null.
- Auto-stub DB failure → non-fatal (logged + Sentry), classification still persisted — as today.

## Testing

- **Unit (mocked `getAnthropic`):** success path persists fields + auto-stubs at high confidence; medium/low confidence does NOT auto-stub; INVOICE high-confidence auto-stubs, ESTIMATE never auto-stubs; AI throw → heuristic fallback path runs; ID-guard drops a hallucinated vendor/target id; bad date → null.
- **Unit (pure):** the auto-stub decision predicate (kind × vendor × target × confidence matrix); the ID-validation helper.
- **Heuristic tests:** unchanged (it remains the fallback).
- **Integration:** `handleClassifyIncomingEmail` end-to-end against a seeded email + mocked Anthropic fixture → row updated, `AISuggestionLog` written with `kind:'incoming-email-classify'`, draft ServiceRecord created/linked.

## Out of scope (YAGNI)

- Fine-tuning / training.
- Multi-target per email (schema stays single best item XOR system, like today).
- Inbox UI changes beyond existing promote/review flows.
- Non-PDF (image) attachment input.
- A 0–1 numeric confidence (enum is sufficient for the high-only gate).
