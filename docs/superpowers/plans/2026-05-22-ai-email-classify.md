# AI-Assisted Incoming-Email Classification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the brittle heuristic email classifier with a single Anthropic call that classifies (kind + vendor + target) and extracts (cost/date/scope) in one pass, broadening auto-stub to TICKET+INVOICE at high confidence, with the heuristic kept as a fallback.

**Architecture:** A new `lib/incoming-email/ai-classify.ts` makes one `messages.parse` call (ported from the extract job) returning a unified schema. The `classify-incoming-email` worker job calls it, guards hallucinated IDs, persists + logs, and auto-stubs a draft ServiceRecord. The separate `extract-incoming-email` job is folded in; the inbox's re-extract/re-classify collapse to one action.

**Tech Stack:** Anthropic SDK (`messages.parse` + `zodOutputFormat`), Zod, Prisma, pg-boss, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-22-ai-email-classify-design.md`

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `lib/ai/schemas.ts` | `incomingEmailClassifyExtractSchema` + type | Modify |
| `lib/ai/log.ts` | add `'incoming-email-classify'` to `CreateLogInput.kind` | Modify |
| `lib/incoming-email/ai-classify.ts` | `aiClassifyExtract()` + pure helpers `validateCandidateIds`, `shouldAutoStub` | Create |
| `lib/incoming-email/ai-classify.test.ts` | unit tests for the pure helpers | Create |
| `worker/jobs/classify-incoming-email.ts` | unified orchestration (AI → guard → persist → log → auto-stub → heuristic fallback) | Modify |
| `worker/jobs/extract-incoming-email.ts` | folded into classify | Delete |
| `worker/index.ts` | drop extract registration + startup-log/comment | Modify |
| `lib/queue.ts` | drop `ExtractIncomingEmail` member | Modify |
| `lib/incoming-email/actions.ts` | collapse `reextractIncomingEmail` into the reclassify path | Modify |
| `components/incoming-email/ReextractButton.tsx`, `ExtractedFieldsCard.tsx` | point at unified action, relabel "Re-run AI" | Modify |
| `tests/integration/incoming-email-actions.test.ts` | update reextract→reclassify assertion | Modify |
| `tests/integration/incoming-email-extract-job.test.ts` | port meaningful cases onto the unified job (or replace) | Modify/Delete |
| `tests/integration/incoming-email-classify-job.test.ts` (or existing) | unified-job integration with mocked Anthropic | Modify/Create |

---

## Task 1: Unified schema + log kind

**Files:** `lib/ai/schemas.ts`, `lib/ai/log.ts`.

- [ ] **Step 1: Add the schema** to `lib/ai/schemas.ts` after `incomingEmailExtractionSchema`:

```ts
// Unified classify + extract result for inbound vendor emails. Classification
// fields (kind/vendor/target/confidence) join the extraction fields so a single
// AI call seeds everything. vendorId/targetItemId/targetSystemId are chosen from
// candidate lists passed in the prompt — the worker re-validates they exist
// (the model can hallucinate ids).
export const incomingEmailClassifyExtractSchema = z.object({
  kind: z.enum(['ESTIMATE', 'INVOICE', 'TICKET', 'UNKNOWN']),
  vendorId: z
    .string()
    .nullable()
    .describe('id of the matching vendor from the candidate list, or null if none clearly matches'),
  targetItemId: z
    .string()
    .nullable()
    .describe('id of the matching item from the candidate list, or null'),
  targetSystemId: z
    .string()
    .nullable()
    .describe('id of the matching system from the candidate list, or null. Pick item OR system, not both.'),
  confidence: z
    .enum(['low', 'medium', 'high'])
    .describe('overall confidence in the kind + vendor + target match'),
  summary: incomingEmailExtractionSchema.shape.summary,
  cost: incomingEmailExtractionSchema.shape.cost,
  performedOn: incomingEmailExtractionSchema.shape.performedOn,
  scope: incomingEmailExtractionSchema.shape.scope,
  rationale: incomingEmailExtractionSchema.shape.rationale,
});
export type IncomingEmailClassifyExtract = z.infer<typeof incomingEmailClassifyExtractSchema>;
```

- [ ] **Step 2: Add the log kind** — in `lib/ai/log.ts`, extend the `kind` union to include `'incoming-email-classify'`.

- [ ] **Step 3: Verify** `pnpm typecheck` clean. Commit:
```bash
git add lib/ai/schemas.ts lib/ai/log.ts
git commit -m "feat(inbox): unified classify+extract AI schema + log kind"
```

---

## Task 2: AI module + pure helpers (TDD)

**Files:** `lib/incoming-email/ai-classify.ts` (create), `lib/incoming-email/ai-classify.test.ts` (create).

The pure helpers are unit-tested here; `aiClassifyExtract` (the Anthropic call) is exercised via the job integration test in Task 3 (mocked SDK).

- [ ] **Step 1: Write failing tests** `lib/incoming-email/ai-classify.test.ts` for the two pure helpers:

```ts
import { describe, expect, it } from 'vitest';
import { shouldAutoStub, validateCandidateIds } from './ai-classify';

describe('validateCandidateIds', () => {
  const vendors = [{ id: 'v1', name: 'Acme' }];
  const items = [{ id: 'i1', name: 'Furnace' }];
  const systems = [{ id: 's1', name: 'HVAC' }];

  it('keeps ids that exist in the candidate lists', () => {
    const out = validateCandidateIds(
      { vendorId: 'v1', targetItemId: 'i1', targetSystemId: null },
      { vendors, items, systems },
    );
    expect(out).toEqual({ vendorId: 'v1', targetItemId: 'i1', targetSystemId: null });
  });

  it('drops hallucinated ids (not in the lists) to null', () => {
    const out = validateCandidateIds(
      { vendorId: 'v-nope', targetItemId: 'i-nope', targetSystemId: 's-nope' },
      { vendors, items, systems },
    );
    expect(out).toEqual({ vendorId: null, targetItemId: null, targetSystemId: null });
  });

  it('keeps item over system when the model returned both', () => {
    const out = validateCandidateIds(
      { vendorId: null, targetItemId: 'i1', targetSystemId: 's1' },
      { vendors, items, systems },
    );
    expect(out).toEqual({ vendorId: null, targetItemId: 'i1', targetSystemId: null });
  });
});

describe('shouldAutoStub', () => {
  const base = { vendorId: 'v1', targetItemId: 'i1', targetSystemId: null, confidence: 'high' as const };
  it('stubs for TICKET and INVOICE at high confidence with vendor + target', () => {
    expect(shouldAutoStub({ ...base, kind: 'TICKET' })).toBe(true);
    expect(shouldAutoStub({ ...base, kind: 'INVOICE' })).toBe(true);
  });
  it('does not stub for ESTIMATE or UNKNOWN', () => {
    expect(shouldAutoStub({ ...base, kind: 'ESTIMATE' })).toBe(false);
    expect(shouldAutoStub({ ...base, kind: 'UNKNOWN' })).toBe(false);
  });
  it('does not stub below high confidence', () => {
    expect(shouldAutoStub({ ...base, kind: 'TICKET', confidence: 'medium' })).toBe(false);
  });
  it('does not stub without a vendor or without a target', () => {
    expect(shouldAutoStub({ ...base, kind: 'TICKET', vendorId: null })).toBe(false);
    expect(shouldAutoStub({ ...base, kind: 'TICKET', targetItemId: null, targetSystemId: null })).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify it fails** (`shouldAutoStub`/`validateCandidateIds` not defined): `pnpm vitest run lib/incoming-email/ai-classify.test.ts`.

- [ ] **Step 3: Implement** `lib/incoming-email/ai-classify.ts`:
  - Pure helpers (make tests pass):
    - `validateCandidateIds(ids, candidates)` → returns `{vendorId,targetItemId,targetSystemId}` with any id not in the respective list set to null; if both item and system survive, **null the system** (item-wins, matching the heuristic + `promoteToServiceRecord`).
    - `shouldAutoStub({kind, vendorId, targetItemId, targetSystemId, confidence})` → `(kind === 'TICKET' || kind === 'INVOICE') && confidence === 'high' && !!vendorId && (!!targetItemId || !!targetSystemId)`.
  - `aiClassifyExtract(input)`: **port** the call from `worker/jobs/extract-incoming-email.ts` (PDF `loadPdfAttachments` + caps, `document` blocks first, `getAnthropic().messages.parse({... output_config:{format: zodOutputFormat(incomingEmailClassifyExtractSchema)} } as never)`, `parsed_output`, `usage`). Move/share `loadPdfAttachments` (extract it here or into a shared `lib/incoming-email/pdf-attachments.ts` since the extract job is being deleted). Build the prompt: the existing extract `SYSTEM_PROMPT` (cost/performedOn/scope rules) **plus** classification guidance + "choose vendor/target by id from the numbered candidate lists below, or null". The user text appends numbered candidate lists (vendors, items, systems) with their ids. Return `{ result: IncomingEmailClassifyExtract, usage }` and let the caller log/persist (keep this module free of DB writes so it's unit-testable; the job owns persistence + logging).

- [ ] **Step 4: Run tests** → pure helpers pass. `pnpm typecheck`.

- [ ] **Step 5: Commit**
```bash
git add lib/incoming-email/ai-classify.ts lib/incoming-email/ai-classify.test.ts lib/incoming-email/pdf-attachments.ts
git commit -m "feat(inbox): aiClassifyExtract module + id-guard/auto-stub helpers"
```

---

## Task 3: Rewrite the classify job orchestration

**Files:** `worker/jobs/classify-incoming-email.ts`, plus its integration test.

- [ ] **Step 1: Update/author the integration test** (mock `getAnthropic` like other AI job tests; seed a vendor + item + email). Cases:
  - High-confidence INVOICE with vendor+item → persists `kind/vendorId/targets/aiExtracted*`, writes an `AISuggestionLog` row with `kind:'incoming-email-classify'`, **auto-stubs** a draft ServiceRecord linked via `createdServiceRecordId`.
  - Medium confidence → classifies/persists but **no** ServiceRecord.
  - Hallucinated vendorId (not seeded) → dropped to null, no stub.
  - `getAnthropic().messages.parse` throws → **heuristic fallback** runs (assert kind/vendor come from `classifyEmail`), error logged, job doesn't throw fatally (or rethrows per pg-boss retry contract — match existing behavior).

- [ ] **Step 2: Run, verify failing.**

- [ ] **Step 3: Implement** the rewrite of `classifyOne(id)`:
  - Keep the row load + candidate lists + `loadPdfTextForEmail` + `ownsRow` logic.
  - Add the **system-user lookup** (`prisma.user.findFirst({orderBy:{createdAt:'asc'}})`, skip-if-none) — needed for the log.
  - `try`: `aiClassifyExtract({...row, emailDate: row.receivedAt, pdfs, vendors, items, systems})` → `validateCandidateIds` → map to `result.targets` array (item XOR system) → `createSuggestionLog({kind:'incoming-email-classify', userId, response, model, tokens, latencyMs})` → persist (existing transaction, now also writing `aiExtracted*`) → if `shouldAutoStub(...)` and not already linked, run the existing stub transaction with `performedOn = aiExtractedPerformedOn ?? receivedAt`, `summary = aiExtractedSummary ?? subject`, `notes = aiExtractedScope ?? '[Auto-created…]'`.
  - `catch`: log error + `createSuggestionLog({errorReason})`, then **fallback** to `classifyEmail({...})` and persist its kind/vendor/targets via the same path (no aiExtracted*), no auto-stub (or auto-stub per heuristic's own `shouldAutoStubServiceRecord` — keep heuristic semantics in the fallback). Validate `performedOn` with the existing date check.
  - Reuse the extract job's `MAX_BODY_CHARS`/PDF caps via the shared module from Task 2.

- [ ] **Step 4: Run** the integration test + `pnpm typecheck`.

- [ ] **Step 5: Commit**
```bash
git add worker/jobs/classify-incoming-email.ts tests/integration/incoming-email-classify-job.test.ts
git commit -m "feat(inbox): AI classify+extract orchestration with heuristic fallback + auto-stub"
```

---

## Task 4: Remove the extract job + collapse the inbox actions/UI

**Files:** delete `worker/jobs/extract-incoming-email.ts`; `worker/index.ts`, `lib/queue.ts`, `lib/incoming-email/actions.ts`, `components/incoming-email/ReextractButton.tsx`, `components/incoming-email/ExtractedFieldsCard.tsx`, the two integration tests.

- [ ] **Step 1:** Delete `worker/jobs/extract-incoming-email.ts` (its PDF loader now lives in the shared module from Task 2; confirm nothing else imports it). Remove the `Queue.ExtractIncomingEmail` registration + the `boss.work(Queue.ExtractIncomingEmail, …)` + the startup-log string + the related comment in `worker/index.ts`.
- [ ] **Step 2:** Remove the `ExtractIncomingEmail` member from `lib/queue.ts` (`QUEUES` auto-derives, so this cleanly drops it).
- [ ] **Step 3:** In `lib/incoming-email/actions.ts`, collapse: keep `reclassifyIncomingEmail` (→ `Queue.ClassifyIncomingEmail`); remove `reextractIncomingEmail` (or repoint it to the classify queue if a caller is easier to keep). Update `ReextractButton.tsx` + its use in `ExtractedFieldsCard.tsx` to call the unified action and relabel to "Re-run AI"; reconcile so only **one** re-run control renders (drop the duplicate if a reclassify button already exists). Update `canReextract`/empty-state copy accordingly.
- [ ] **Step 4:** Update `tests/integration/incoming-email-actions.test.ts` (the reextract→`incoming-email.extract` assertion now targets the unified classify queue / single action). Port the meaningful assertions from `tests/integration/incoming-email-extract-job.test.ts` onto the Task 3 unified-job test, then delete (or repurpose) the extract-job test file.
- [ ] **Step 5:** `pnpm typecheck && pnpm lint` → clean (catches any dangling import/reference). Commit:
```bash
git add -A
git commit -m "refactor(inbox): fold extract job into unified classify; collapse re-run action/UI"
```

---

## Task 5: Full verification

- [ ] **Step 1:** `pnpm test:unit` and `pnpm test:integration` → green (incl. the new ai-classify unit tests + the unified-job integration test).
- [ ] **Step 2:** `pnpm typecheck && pnpm lint` (biome + tokens + knip) → clean. Knip will flag any now-unused export from the deleted extract path — clean those up.
- [ ] **Step 3:** Grep for stragglers: `rg "ExtractIncomingEmail|extract-incoming-email|reextract" --glob '!docs/**'` → only intended references remain (e.g. DB column `aiExtracted*` which we keep).
- [ ] **Step 4:** Sanity-reason the flow end to end: an UNKNOWN newsletter → one AI call, kind=UNKNOWN, no stub, logged (admin shows it); a high-confidence invoice from a registered vendor → vendor/target matched, draft ServiceRecord created.

## Notes & Risks

- **Highest-risk task is #4** (removing the extract job): the spec's "Removed / collapsed — exact call sites" lists every reference; typecheck+lint+grep are the safety net.
- Keep `aiClassifyExtract` free of DB writes (pure-ish, SDK call only) so the job owns persistence/logging and the helpers stay unit-testable.
- The heuristic `lib/incoming-email/classify.ts` and its tests are **unchanged** — it's the fallback.
- No DB migration: `IncomingEmail.kind` enum already has the four values; `aiExtracted*` columns exist; `AISuggestionLog.kind` is a string column.
- `ANTHROPIC_API_KEY` is already required by `lib/env.ts`; no new env.
