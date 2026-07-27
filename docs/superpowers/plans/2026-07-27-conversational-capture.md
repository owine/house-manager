# Conversational Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/ask` into a unified read-write chat where unstructured dumps become structured records the user approves change-by-change.

**Architecture:** Single-shot Anthropic call per turn with a cached inventory snapshot, returning `{ reply, proposals[] }`. The model proposes *intent* and never mints an ID or sees a current value; the server validates every ID against the snapshot, re-reads each target row to compute a true before/after diff, and persists proposals as `PENDING` rows. Applying is a separate action guarded by `baseUpdatedAt` optimistic concurrency.

**Tech Stack:** Next.js 16 (App Router, RSC), Prisma 7 / Postgres 18 + pgvector, `@anthropic-ai/sdk` (`messages.parse` + `zodOutputFormat`), Voyage embeddings, Meilisearch, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-26-conversational-capture-design.md` (commit `0d49bda`)

**Branch:** `feat/conversational-capture`

---

## Read this before Task 1

Three rules from `CLAUDE.md` govern most of this plan. Violating any of them produces code that passes lint, typecheck and tests, then fails somewhere unrelated.

1. **Calendar dates are not instants.** `@db.Date` columns (`performedOn`, `purchaseDate`, `installDate`) are *already a day*. Read them in UTC; never run one through a timezone. A `date` column silently truncates a bad write rather than rejecting it. The house timezone answers exactly one question: *what day is it now*.
2. **`enqueueSearchIndex` / `enqueueEmbed` are not uniform across entities.** `System` is in neither `SEARCH_KINDS` nor `EmbeddingEntityType`. Copy the side effects from the existing action for that entity — never by analogy with a different one. Task 13 has the table.
3. **Never `--no-verify`.** `git commit` can fail *silently* behind the Biome pre-commit hook. After every commit step, confirm HEAD actually moved.

Run `pnpm verify` before pushing. Use `pnpm`, never `npx`/`npm`.

---

## File Structure

**New — `lib/chat/` (feature module, follows the repo's schema/queries/actions triple):**

| File | Responsibility |
|---|---|
| `lib/chat/schema.ts` | All Zod. Turn envelope + the `ChatProposal.payload` discriminated union. The *entire* model-facing schema lives here; `lib/ai/schemas.ts` is left untouched. |
| `lib/chat/dice.ts` | Pure character-bigram Dice similarity. No I/O. |
| `lib/chat/dates.ts` | Pure `YYYY-MM-DD` → UTC-midnight parsing and anchor-relative resolution. No I/O. |
| `lib/chat/title.ts` | Pure session-title derivation from the first turn. No I/O. |
| `lib/chat/dedup.ts` | Near-duplicate note lookup; rewrites `CREATE_NOTE` → `UPDATE_NOTE`. |
| `lib/chat/resolve.ts` | Validates proposed IDs against the snapshot, plus dates and XOR targets. |
| `lib/chat/queries.ts` | Read-only Prisma. No `'use server'`, no `auth()`. |
| `lib/chat/actions.ts` | `'use server'`. Turn, apply, reject — including the target re-read that produces `baseUpdatedAt` + `beforeSnapshot`. |
| `lib/chat/prompt.ts` | The chat system prompt + snapshot block builder. |

**New — UI:**

| File | Responsibility |
|---|---|
| `components/chat/ChatThread.tsx` | `'use client'`. The conversation. |
| `components/chat/ProposalCard.tsx` | `'use client'`. One proposal + Accept/Reject. |
| `components/chat/DiffRow.tsx` | Before/after rendering, inferred-value badges. |

**Modified:**

| File | Change |
|---|---|
| `prisma/schema.prisma` | 3 models, 3 enums, `System.metadata`, `AISuggestionLog` back-relation |
| `lib/embedding/canonicalize.ts` | `canonicalizeItem` skips `_`-prefixed metadata keys |
| `lib/ai/rate-limit.ts` | `checkRateLimit(userId, kind)` |
| `lib/ai/client.ts` | add `ANTHROPIC_CHAT_MAX_TOKENS` constant |
| `lib/ask/actions.ts` | rate-limit call site + hardcoded `/10` string |
| `app/(app)/ask/page.tsx` | new empty session; renders `ChatThread` |

**New — routes:**

| File | Responsibility |
|---|---|
| `app/(app)/ask/[sessionId]/page.tsx` | Server component. Loads one session and renders `ChatThread`. |

**Deleted (Task 16, last):** `lib/ask/actions.ts`'s `askQuestion` and `components/ask/AskForm.tsx`, once chat replaces them. `lib/ask/retrieve.ts` and `strip-tags.ts` are **kept** — chat uses both.

---

# Phase 1 — Foundations

Independent, low-risk changes. Each ships on its own and none change user-visible behaviour.

---

### Task 1: `canonicalizeItem` skips `_`-prefixed metadata keys

Provenance (§9) is stored under a reserved `_provenance` key in `Item.metadata`. `canonicalizeItem` currently iterates **every** metadata entry into embedded text and `JSON.stringify`s object values, so without this the provenance map lands in the item's embedding as raw JSON.

**Files:**
- Modify: `lib/embedding/canonicalize.ts:109-114`
- Test: `lib/embedding/canonicalize.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `lib/embedding/canonicalize.test.ts`:

```ts
it('omits underscore-prefixed metadata keys from canonical text', () => {
  // ItemForCanonical requires `category: { name }` — NOT `categoryName`.
  // See lib/embedding/canonicalize.ts:16-27.
  const text = canonicalizeItem({
    name: 'Kitchen Pendant',
    category: { name: 'Lighting' },
    metadata: {
      wattage: '9W',
      _provenance: { wattage: 'inferred' },
    },
  });

  expect(text).toContain('wattage: 9W');
  expect(text).not.toContain('_provenance');
  expect(text).not.toContain('inferred');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec vitest run lib/embedding/canonicalize.test.ts -t "underscore-prefixed"
```

Expected: FAIL — the output contains `_provenance: {"wattage":"inferred"}`.

- [ ] **Step 3: Write minimal implementation**

In `lib/embedding/canonicalize.ts`, change the metadata block to filter on the key:

```ts
  if (item.metadata && Object.keys(item.metadata).length > 0) {
    const meta = Object.entries(item.metadata)
      // `_`-prefixed keys are internal (e.g. `_provenance` from conversational
      // capture). They must never reach embedded text — they carry no retrieval
      // value and would inject raw JSON into the chunk.
      .filter(([k, v]) => !k.startsWith('_') && present(v))
      .map(([k, v]) => `  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    if (meta.length > 0) lines.push('Metadata:', ...meta);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm exec vitest run lib/embedding/canonicalize.test.ts
```

Expected: PASS, including all pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add lib/embedding/canonicalize.ts lib/embedding/canonicalize.test.ts
git commit -m "feat(embedding): omit underscore-prefixed metadata from canonical text"
git log --oneline -1   # confirm HEAD moved
```

---

### Task 2: Per-kind rate limits

`checkRateLimit` counts every `AISuggestionLog` row regardless of `kind` — one global 10/hour budget. Chat needs 40/hour. Note this **relaxes** the cap for existing kinds (each gets its own 10 instead of sharing one); that is intended and documented in the spec.

`AISuggestionLog.kind` is a `String`, not an enum, so the map needs an explicit default for unknown kinds.

**Files:**
- Modify: `lib/ai/rate-limit.ts`
- Modify: `lib/ask/actions.ts:95` (call site) and `:107` (hardcoded `/10` string)
- Modify: `tests/integration/ai/rate-limit.test.ts` — **existing**, calls `checkRateLimit(userId)` at `:45`, `:52`, `:59` and will not compile after this change
- Test: `lib/ai/rate-limit.test.ts` (create — pure `limitForKind` only)

> **Do not mock `@/lib/db`.** No unit test in this repo does; rate-limit *counting* is tested exclusively against Testcontainers in `tests/integration/ai/rate-limit.test.ts`. Keep it that way: the new unit test covers only the pure map lookup, and the counting behaviour stays in the existing integration test.

- [ ] **Step 1: Write the failing unit test**

Create `lib/ai/rate-limit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { limitForKind } from './rate-limit';

describe('limitForKind', () => {
  it('gives chat a higher budget than the one-shot kinds', () => {
    expect(limitForKind('chat')).toBe(40);
    expect(limitForKind('ask')).toBe(10);
  });

  // AISuggestionLog.kind is a String column, not an enum, so there is no
  // compile-time exhaustiveness — an unknown kind MUST fall back rather than
  // returning undefined and disabling the limit entirely.
  it('falls back to the default for an unknown kind', () => {
    expect(limitForKind('something-new')).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec vitest run lib/ai/rate-limit.test.ts
```

Expected: FAIL — `limitForKind` is not exported.

- [ ] **Step 3: Write minimal implementation**

Replace `lib/ai/rate-limit.ts` entirely:

```ts
import { prisma } from '@/lib/db';

const HOUR_MS = 60 * 60 * 1000;

/** Default budget for one-shot AI kinds. */
export const RATE_LIMIT_PER_HOUR = 10;

// Per-kind hourly budgets. A capture conversation burns 3-4 turns on a single
// task, so chat gets a larger allowance than the one-shot kinds.
//
// `AISuggestionLog.kind` is a String column, not an enum, so this map is
// stringly-typed and MUST have a default for unknown kinds.
const LIMITS: Record<string, number> = {
  chat: 40,
};

export function limitForKind(kind: string): number {
  return LIMITS[kind] ?? RATE_LIMIT_PER_HOUR;
}

export type RateLimitCheck = {
  allowed: boolean;
  used: number;
  remaining: number;
  limit: number;
};

export async function checkRateLimit(userId: string, kind: string): Promise<RateLimitCheck> {
  const since = new Date(Date.now() - HOUR_MS);
  const limit = limitForKind(kind);
  const used = await prisma.aISuggestionLog.count({
    where: { userId, kind, createdAt: { gte: since } },
  });
  return {
    allowed: used < limit,
    used,
    remaining: Math.max(0, limit - used),
    limit,
  };
}
```

- [ ] **Step 4: Update every existing caller**

`checkRateLimit` now requires a second argument. Find them all:

```bash
grep -rn "checkRateLimit" lib worker tests app
```

In `lib/ask/actions.ts:95`, pass the kind and take the limit from the result — the hardcoded `10` at `:107` would otherwise be wrong for any kind whose budget differs:

```ts
  const rl = await checkRateLimit(userId, 'ask');
  if (!rl.allowed) {
    // ... existing createSuggestionLog call unchanged ...
    return { ok: false, formError: `Hourly limit reached (${rl.used}/${rl.limit}).` };
  }
```

Do the same in `lib/ai/suggest/reminders.ts` and `lib/ai/suggest/checklist.ts` — both hardcode their limit in the user-facing string too. Pass `'reminders'` / `'checklist'` respectively.

Update `tests/integration/ai/rate-limit.test.ts` (`:45`, `:52`, `:59`) to pass a kind, and add one case asserting a different kind's usage does **not** count against the one under test — that is the whole point of the change.

- [ ] **Step 5: Run tests and typecheck**

```bash
pnpm exec vitest run lib/ai/rate-limit.test.ts
pnpm typecheck
pnpm exec vitest run tests/integration/ai/rate-limit.test.ts
```

Expected: all PASS. Typecheck is what catches any caller you missed in Step 4.

- [ ] **Step 6: Commit**

```bash
git add lib/ai/rate-limit.ts lib/ai/rate-limit.test.ts lib/ask/actions.ts lib/ai/suggest tests/integration/ai/rate-limit.test.ts
git commit -m "feat(ai): scope rate limits per suggestion kind"
git log --oneline -1
```

---

### Task 3: Chat-specific output ceiling

`ANTHROPIC_MAX_TOKENS = 2048` is a shared **output** ceiling. A chat reply plus several proposals carrying note bodies will exceed it, and `messages.parse` throws on a truncated response — so the failure mode for a large dump is total loss of the turn.

`max_tokens` is already passed per call site, so no signature change is needed — just a second exported constant that Task 12 passes instead of the default. `lib/ask/actions.ts` and the two `lib/ai/suggest/` modules keep their current behaviour, untouched.

(The spec described this as an "optional parameter". A constant is the smaller change and achieves the same thing; the spec's intent — existing callers unaffected — is preserved.)

**Files:**
- Modify: `lib/ai/client.ts`

- [ ] **Step 1: Add the chat constant**

Append to `lib/ai/client.ts`:

```ts
// Chat turns return a reply plus up to several proposals carrying note bodies,
// which does not fit in ANTHROPIC_MAX_TOKENS. `messages.parse` throws on a
// truncated response, so an undersized ceiling loses the whole turn.
export const ANTHROPIC_CHAT_MAX_TOKENS = 4096;
```

There is no behaviour change and nothing to test yet — `max_tokens` is passed per call site, so Task 12 simply passes this constant instead of the default. Existing callers are untouched.

- [ ] **Step 2: Verify nothing broke**

```bash
pnpm typecheck && pnpm exec vitest run lib/ai
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/ai/client.ts
git commit -m "feat(ai): add chat-specific max_tokens ceiling"
git log --oneline -1
```

---

# Phase 2 — Schema

---

### Task 4: Prisma models, enums, and `System.metadata`

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<generated>/migration.sql`

- [ ] **Step 1: Add the enums and models**

Append to `prisma/schema.prisma`:

```prisma
enum ChatRole {
  USER
  ASSISTANT
}

enum ChatProposalKind {
  CREATE_NOTE
  UPDATE_NOTE
  CREATE_ITEM
  UPDATE_ITEM
  UPDATE_SYSTEM
  CREATE_SERVICE_RECORD
}

enum ChatProposalStatus {
  PENDING
  ACCEPTED
  REJECTED
  STALE      // target changed underneath; recompute the diff and re-confirm
  ORPHANED   // target row was deleted
  INVALID    // stored payload no longer parses against the current union
}

model ChatSession {
  id        String        @id @default(cuid())
  userId    String
  title     String
  createdAt DateTime      @default(now())
  updatedAt DateTime      @updatedAt

  messages  ChatMessage[]

  @@index([userId])
  @@index([updatedAt])
  @@map("chat_sessions")
}

model ChatMessage {
  id        String   @id @default(cuid())
  sessionId String
  session   ChatSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  role      ChatRole
  content   String   @db.Text

  aiSuggestionLogId String?
  aiSuggestionLog   AISuggestionLog? @relation(fields: [aiSuggestionLogId], references: [id], onDelete: SetNull)

  createdAt DateTime @default(now())

  proposals ChatProposal[]

  @@index([sessionId, createdAt])
  @@map("chat_messages")
}

model ChatProposal {
  id        String   @id @default(cuid())
  messageId String
  message   ChatMessage @relation(fields: [messageId], references: [id], onDelete: Cascade)

  kind       ChatProposalKind
  targetType String?
  // Polymorphic, deliberately no FK — same trade-off as `Embedding`, and the
  // same cost: no cascade on entity delete. Apply re-reads the target and marks
  // the proposal ORPHANED on a miss.
  targetId   String?

  payload    Json

  status     ChatProposalStatus @default(PENDING)
  // Snapshot of the target row's `updatedAt` at propose time. Optimistic
  // concurrency for the update kinds; null for the create kinds.
  baseUpdatedAt DateTime?
  // The target row's current values for ONLY the fields this proposal
  // touches, captured in the SAME read that produced baseUpdatedAt. This is
  // the "before" half of the diff. Null for the create kinds. Refreshed by
  // refreshProposal when a proposal goes STALE.
  //
  // Two rules, both load-bearing:
  //   1. Scope it to the touched fields. Snapshotting the whole row would drag
  //      in Decimal columns (purchasePrice, installCost, cost), which
  //      serialize into Json as strings and silently break the diff render.
  //      No proposal kind touches a Decimal field today; keep it that way.
  //   2. Store calendar dates as YYYY-MM-DD strings, matching the payload's
  //      own wire format. A Date written to a Json column reads back as an
  //      ISO string, and formatCalendarDate takes a CalendarDate, not a
  //      string — passing the raw value through would not typecheck.
  beforeSnapshot Json?

  appliedEntityId String?
  appliedAt       DateTime?
  createdAt       DateTime  @default(now())

  @@index([messageId])
  @@index([status])
  @@map("chat_proposals")
}
```

- [ ] **Step 2: Add the back-relation and `System.metadata`**

On `model AISuggestionLog`, add:

```prisma
  chatMessages ChatMessage[]
```

On `model System` (after `notes`), add:

```prisma
  metadata        Json       @default("{}")
```

> `System` is neither embedded nor Meili-indexed, so provenance stored here is **UI-only** — it renders as a badge but never surfaces through Ask or search. That is expected; see spec §2.

- [ ] **Step 3: Generate the migration**

```bash
docker compose up -d db
pnpm db:migrate
```

- [ ] **Step 4: Eyeball the generated SQL**

Open the new `prisma/migrations/<timestamp>_*/migration.sql` and confirm:
- It **creates** three tables and three enum types, adds `systems.metadata`, adds `chat_messages.aiSuggestionLogId`.
- It **does not DROP** the IVFFlat pgvector index on `embeddings`, any XOR `CHECK` constraint on the multi-target join tables, or any `NULLS NOT DISTINCT` unique index.

No hand-written SQL is required here — the new tables are polymorphic-by-string like `Embedding`, so there is no XOR constraint and no trigram index to add.

If the dev DB blocks, reset and reseed rather than doing checksum surgery — it is disposable.

- [ ] **Step 5: Verify the client regenerated**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(db): add chat session, message and proposal tables"
git log --oneline -1
```

---

# Phase 3 — Pure helpers

All three are pure functions with no I/O, fully unit-testable, and carry the logic most likely to be subtly wrong.

---

### Task 5: Character-bigram Dice similarity

Used by the near-duplicate note check (Task 10). **Character** bigrams, not word tokens: the titles this feature generates are short and often single-token (`"Lightbulbs"`, `"Filters"`), and word-token Dice can only ever return 1.0 or 0.0 between two single-token titles. Bigrams also absorb plurals, spacing and typos.

**Files:**
- Create: `lib/chat/dice.ts`
- Test: `lib/chat/dice.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/chat/dice.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { diceSimilarity, NOTE_DEDUP_THRESHOLD } from './dice';

describe('diceSimilarity', () => {
  it('scores identical titles 1', () => {
    expect(diceSimilarity('Lightbulbs', 'Lightbulbs')).toBe(1);
  });

  it('ignores case, punctuation and whitespace', () => {
    expect(diceSimilarity('Light bulbs', 'lightbulbs')).toBe(1);
    expect(diceSimilarity('Lightbulbs!', 'lightbulbs')).toBe(1);
  });

  it('scores a restatement above the dedup threshold', () => {
    expect(diceSimilarity('Lightbulbs', 'Lightbulbs (2)')).toBeGreaterThan(
      NOTE_DEDUP_THRESHOLD,
    );
  });

  it('scores unrelated titles near zero', () => {
    expect(diceSimilarity('Lightbulbs', 'Roof warranty')).toBeLessThan(0.2);
  });

  // Documented limitation, asserted so nobody "fixes" the threshold to chase it.
  // Synonym drift is a semantic relationship, not a string one — only the
  // deferred RAG supplement will catch this pair.
  it('does NOT catch synonym drift', () => {
    expect(diceSimilarity('Lightbulbs', 'Bulb types')).toBeLessThan(
      NOTE_DEDUP_THRESHOLD,
    );
  });

  it('handles strings too short to form a bigram', () => {
    expect(diceSimilarity('a', 'a')).toBe(1);
    expect(diceSimilarity('a', 'b')).toBe(0);
    expect(diceSimilarity('', 'anything')).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec vitest run lib/chat/dice.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `lib/chat/dice.ts`:

```ts
// Character-bigram Dice similarity, used to detect near-duplicate note titles
// before proposing a new note (see the conversational-capture spec, §12).
//
// Character bigrams rather than word tokens: the titles this feature generates
// are short and frequently single-token ("Lightbulbs", "Filters"), where
// word-token Dice can only ever return 1.0 or 0.0. Bigrams also absorb plurals,
// spacing and typos.
//
// Known limitation: this is lexical, not semantic. It catches restatements
// ("Lightbulbs" / "Light bulbs" / "Lightbulbs (2)") but NOT synonym drift
// ("Lightbulbs" / "Bulb types" scores ~0.35). That is by design — no threshold
// catches the latter without also producing false positives.

/**
 * Match threshold. A guess pending real data: `prisma/seed.ts` creates no
 * notes, so there is no corpus in this repo to calibrate against. Expect to
 * tune once there is real usage.
 */
export const NOTE_DEDUP_THRESHOLD = 0.5;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Dice coefficient over character bigrams. Returns 0..1. */
export function diceSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;

  // Too short to form a bigram — fall back to equality so single-character
  // titles don't silently score 0 against themselves.
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0;

  const ga = bigrams(na);
  const gb = bigrams(nb);

  let intersection = 0;
  for (const [g, countA] of ga) {
    const countB = gb.get(g);
    if (countB) intersection += Math.min(countA, countB);
  }

  const total = na.length - 1 + (nb.length - 1);
  return (2 * intersection) / total;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm exec vitest run lib/chat/dice.test.ts
```

Expected: PASS, all seven cases.

- [ ] **Step 5: Commit**

```bash
git add lib/chat/dice.ts lib/chat/dice.test.ts
git commit -m "feat(chat): add character-bigram Dice similarity for note dedup"
git log --oneline -1
```

---

### Task 6: Calendar-date parsing and anchor resolution

**This is the repo's most expensive recurring bug class — read `lib/time/tz.ts` before writing a line.**

The model returns dates as plain `YYYY-MM-DD` strings. The server parses them to **UTC midnight**, never through a timezone. The house timezone is used for exactly one thing: computing what day it is *now*, to anchor relative expressions.

**Files:**
- Create: `lib/chat/dates.ts`
- Test: `lib/chat/dates.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/chat/dates.test.ts`. **Every date test injects a fixed anchor** — a test that reads the clock passes today and fails next week (this already bit the repo in PR #205/#206):

```ts
import { describe, expect, it } from 'vitest';
import { parseCalendarDate, resolveAnchorDay } from './dates';

describe('parseCalendarDate', () => {
  it('parses YYYY-MM-DD to UTC midnight', () => {
    const d = parseCalendarDate('2026-07-03');
    expect(d?.toISOString()).toBe('2026-07-03T00:00:00.000Z');
  });

  // The whole point: a calendar date must not shift when the house is behind
  // UTC. Reading 2026-07-03 through America/Chicago would yield July 2.
  it('does not shift the day regardless of house timezone', () => {
    const d = parseCalendarDate('2026-07-03');
    expect(d?.getUTCDate()).toBe(3);
    expect(d?.getUTCMonth()).toBe(6);
    expect(d?.getUTCFullYear()).toBe(2026);
  });

  it('rejects a timestamp, not just a date', () => {
    expect(parseCalendarDate('2026-07-03T20:00:00Z')).toBeNull();
  });

  it('rejects malformed and impossible dates', () => {
    expect(parseCalendarDate('July 3rd')).toBeNull();
    expect(parseCalendarDate('2026-13-01')).toBeNull();
    expect(parseCalendarDate('2026-02-30')).toBeNull();
    expect(parseCalendarDate('')).toBeNull();
  });
});

describe('resolveAnchorDay', () => {
  // 2026-07-04T01:30:00Z is still July 3rd in Chicago (UTC-5).
  it('reads an instant through the house timezone to find "today"', () => {
    const instant = new Date('2026-07-04T01:30:00.000Z');
    expect(resolveAnchorDay(instant, 'America/Chicago')).toBe('2026-07-03');
    expect(resolveAnchorDay(instant, 'UTC')).toBe('2026-07-04');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec vitest run lib/chat/dates.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `lib/chat/dates.ts`:

```ts
import { startOfDayUtc, tzParts } from '@/lib/time/tz';

// Calendar dates vs instants — see the rule at the top of lib/time/tz.ts.
//
// The model returns dates as plain YYYY-MM-DD strings. They are ALREADY a day:
// parse them to UTC midnight and never run them through a timezone. Passing a
// calendar date through tzParts reads 2026-07-15T00:00:00Z as "Jul 14" in
// Chicago and every date slides back a day.
//
// The house timezone answers exactly one question: what day is it NOW. That is
// `resolveAnchorDay`, and it is the only tz use in this module.

const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a model-supplied `YYYY-MM-DD` string to UTC midnight.
 * Returns null for anything else — including a full timestamp, which would
 * indicate the model ignored its instructions.
 */
export function parseCalendarDate(value: string): Date | null {
  if (!CALENDAR_DATE_RE.test(value)) return null;

  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;

  // Reject impossible dates that Date silently rolls over (2026-02-30 -> Mar 2).
  if (d.toISOString().slice(0, 10) !== value) return null;

  return d;
}

/**
 * What calendar day is it *now* at the house? Returned as `YYYY-MM-DD` for
 * injection into the prompt, so the model resolves "Tuesday" / "last week"
 * against the right today.
 *
 * This is the one legitimate timezone use here: `now` is an instant, and an
 * instant must be read THROUGH the house timezone to find its day.
 */
export function resolveAnchorDay(now: Date, timezone: string): string {
  const { year, month, day } = tzParts(now, timezone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
```

Change the import line to `import { tzParts } from '@/lib/time/tz';` — do **not** re-export `startOfDayUtc` from this module. Nothing here consumes it, and `lib/time/tz.ts` is directly importable; a pass-through export would just be flagged by `lint:knip` on pre-push.

`tzParts` returns `{ year, month, day, … }` and accepts a plain `Date` (`lib/time/tz.ts:2-9,87`). Do not re-roll `Intl` parsing here — all wall-clock math belongs in `lib/time/tz.ts`.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm exec vitest run lib/chat/dates.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/chat/dates.ts lib/chat/dates.test.ts
git commit -m "feat(chat): add calendar-date parsing and house-day anchoring"
git log --oneline -1
```

---

### Task 7: Payload discriminated union

`ChatProposal.payload` is an untyped JSON column read back days later. It is parsed on **read** as well as write — a stored payload that no longer matches the union yields status `INVALID` rather than throwing.

Each field carries `{ value, source }` so provenance (§9) survives from proposal to apply.

**Files:**
- Create: `lib/chat/schema.ts`
- Test: `lib/chat/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/chat/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { NOTE_BODY_MAX, parseStoredPayload, proposalPayloadSchema } from './schema';

const createNote = {
  kind: 'CREATE_NOTE' as const,
  title: { value: 'Lightbulbs', source: 'user' as const },
  body: { value: '## Kitchen\n9W A19 2700K', source: 'inferred' as const },
  itemId: null,
};

describe('proposalPayloadSchema', () => {
  it('accepts a well-formed CREATE_NOTE payload', () => {
    expect(proposalPayloadSchema.safeParse(createNote).success).toBe(true);
  });

  it('discriminates on kind', () => {
    const r = proposalPayloadSchema.safeParse({ ...createNote, kind: 'UPDATE_ITEM' });
    expect(r.success).toBe(false);
  });

  it('rejects a note body over the length ceiling', () => {
    const r = proposalPayloadSchema.safeParse({
      ...createNote,
      body: { value: 'x'.repeat(NOTE_BODY_MAX + 1), source: 'user' },
    });
    expect(r.success).toBe(false);
  });

  it('requires categoryId on CREATE_ITEM', () => {
    const r = proposalPayloadSchema.safeParse({
      kind: 'CREATE_ITEM',
      name: { value: 'Pendant', source: 'user' },
    });
    expect(r.success).toBe(false);
  });

  it('carries provenance through', () => {
    const r = proposalPayloadSchema.parse(createNote);
    if (r.kind !== 'CREATE_NOTE') throw new Error('wrong kind');
    expect(r.body.source).toBe('inferred');
  });
});

describe('parseStoredPayload', () => {
  it('returns the payload when it still parses', () => {
    expect(parseStoredPayload(createNote)).toEqual(createNote);
  });

  it('returns null instead of throwing when the union has moved on', () => {
    expect(parseStoredPayload({ kind: 'SOMETHING_REMOVED' })).toBeNull();
    expect(parseStoredPayload(null)).toBeNull();
    expect(parseStoredPayload('not an object')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec vitest run lib/chat/schema.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `lib/chat/schema.ts`:

```ts
import { z } from 'zod';

// The ENTIRE model-facing schema for conversational capture lives here — the
// turn envelope and the proposal payload union both.
//
// Deliberate deviation from precedent: lib/ai/schemas.ts holds model-facing zod
// for Ask and the email classifier, but this union is also the persistence
// contract read back by the apply action, so it belongs with the feature.
// Keeping the envelope here too avoids inverting the dependency direction —
// lib/ask/actions.ts imports FROM lib/ai/schemas.ts and never the reverse.

/**
 * Server-enforced ceiling on a proposed note body.
 *
 * Chunking happens after canonicalization at ~500 tokens (~2000 chars), and
 * `canonicalizeNote` prepends the title to the body — so chunk 1+ of a long
 * note is bare text with no title and retrieves badly. Markdown tables fare
 * worse: `chunkText` splits on newlines, so trailing chunks are bare rows with
 * no header. Keeping bodies short also keeps inferred-value markers in the same
 * chunk as the facts they annotate.
 *
 * Note this does NOT fix the same pathology for hand-written notes, which
 * `createNoteSchema` allows up to 20,000 chars. It only stops this path adding
 * more.
 */
export const NOTE_BODY_MAX = 1800;

/** A field value plus where it came from. `inferred` renders with a badge. */
const provenanced = <T extends z.ZodTypeAny>(inner: T) =>
  z.object({ value: inner, source: z.enum(['user', 'inferred']) });

const pString = provenanced(z.string().min(1));
const pOptionalString = provenanced(z.string()).optional();
/** Calendar dates cross the wire as YYYY-MM-DD strings, never timestamps. */
const pCalendarDate = provenanced(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional();

const noteBody = provenanced(z.string().min(1).max(NOTE_BODY_MAX));

export const proposalPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('CREATE_NOTE'),
    title: pString,
    body: noteBody,
    itemId: z.string().nullable().default(null),
  }),
  z.object({
    kind: z.literal('UPDATE_NOTE'),
    noteId: z.string().min(1),
    title: pString.optional(),
    body: noteBody,
  }),
  z.object({
    kind: z.literal('CREATE_ITEM'),
    name: pString,
    // Non-null on the Item model. The model picks from the snapshot and the
    // server validates the pick — never defaulted.
    categoryId: z.string().min(1),
    manufacturer: pOptionalString,
    model: pOptionalString,
    serialNumber: pOptionalString,
    location: pOptionalString,
    purchaseDate: pCalendarDate,
  }),
  z.object({
    kind: z.literal('UPDATE_ITEM'),
    itemId: z.string().min(1),
    name: pString.optional(),
    manufacturer: pOptionalString,
    model: pOptionalString,
    serialNumber: pOptionalString,
    location: pOptionalString,
    notes: pOptionalString,
    purchaseDate: pCalendarDate,
  }),
  z.object({
    kind: z.literal('UPDATE_SYSTEM'),
    systemId: z.string().min(1),
    name: pString.optional(),
    kindLabel: pOptionalString,
    location: pOptionalString,
    notes: pOptionalString,
    installDate: pCalendarDate,
  }),
  z.object({
    kind: z.literal('CREATE_SERVICE_RECORD'),
    summary: pString,
    performedOn: provenanced(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    notes: pOptionalString,
    selfPerformed: z.boolean().default(false),
    targets: z
      .array(z.object({ itemId: z.string().nullable(), systemId: z.string().nullable() }))
      .min(1),
  }),
]);

export type ProposalPayload = z.infer<typeof proposalPayloadSchema>;

/**
 * Parse a payload read back from the DB. Returns null rather than throwing when
 * the stored shape no longer matches the union (i.e. the payload predates a
 * schema change) — the caller marks the proposal INVALID.
 */
export function parseStoredPayload(raw: unknown): ProposalPayload | null {
  const parsed = proposalPayloadSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** What the model returns for one turn. */
export const chatTurnOutputSchema = z.object({
  reply: z.string(),
  proposals: z.array(proposalPayloadSchema).default([]),
});

const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(8000),
});

/**
 * Input for one chat turn. The last user message allows 8000 chars — Ask's
 * 500-char cap is incompatible with a feature about dumping unstructured
 * thoughts.
 */
export const chatTurnInputSchema = z.object({
  sessionId: z.string().optional(),
  messages: z
    .array(chatMessageSchema)
    .min(1)
    .max(20)
    .refine(
      (msgs) => {
        const last = msgs[msgs.length - 1];
        if (last?.role !== 'user') return false;
        const trimmed = last.content.trim();
        return trimmed.length >= 3 && trimmed.length <= 8000;
      },
      {
        message: 'Last message must be from the user, between 3 and 8000 characters',
        path: ['messages'],
      },
    ),
});

export type ChatTurnInput = z.input<typeof chatTurnInputSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm exec vitest run lib/chat/schema.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/chat/schema.ts lib/chat/schema.test.ts
git commit -m "feat(chat): add proposal payload union and turn schemas"
git log --oneline -1
```

---

# Phase 4 — Server pipeline

---

### Task 8: Read queries

**Files:**
- Create: `lib/chat/queries.ts`

Read-only Prisma. **No `'use server'`, no `auth()`** — per the feature-module convention, queries take params and return data; the caller owns the auth check.

- [ ] **Step 1: Write the module**

Create `lib/chat/queries.ts`:

Only `getChatSession` is built. A `listChatSessions` would have no consumer in v1 — Task 15 needs one session at a time — and `lint:knip` flags unused exports on pre-push. Add it when a session-list UI exists.

```ts
import { prisma } from '@/lib/db';

/**
 * One session with its full thread. Returns null when the session does not
 * exist OR belongs to another user — callers must not distinguish the two.
 */
export async function getChatSession(id: string, userId: string) {
  const session = await prisma.chatSession.findFirst({
    where: { id, userId },
    select: {
      id: true,
      title: true,
      messages: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          role: true,
          content: true,
          createdAt: true,
          proposals: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              kind: true,
              targetType: true,
              targetId: true,
              payload: true,
              status: true,
              baseUpdatedAt: true,
              // Required — this is the "before" half of every update-kind
              // diff. Omitting it renders every card with an empty before.
              beforeSnapshot: true,
              appliedEntityId: true,
            },
          },
        },
      },
    },
  });
  return session;
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/chat/queries.ts
git commit -m "feat(chat): add session read queries"
git log --oneline -1
```

---

### Task 9: Proposal validation and ID resolution

The model **never mints an ID**. Every ID it returns is checked against the snapshot it was given — the same discipline as `validateCandidateIds` in `lib/incoming-email/ai-classify.ts`.

**Files:**
- Create: `lib/chat/resolve.ts`
- Test: `lib/chat/resolve.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/chat/resolve.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ProposalPayload } from './schema';
import { type Snapshot, validateProposal } from './resolve';

const snapshot: Snapshot = {
  itemIds: new Set(['item-1']),
  systemIds: new Set(['sys-1']),
  categoryIds: new Set(['cat-1']),
  noteIds: new Set(['note-1']),
};

const createItem = (over: Record<string, unknown> = {}): ProposalPayload =>
  ({
    kind: 'CREATE_ITEM',
    name: { value: 'Pendant', source: 'user' },
    categoryId: 'cat-1',
    ...over,
  }) as ProposalPayload;

describe('validateProposal', () => {
  it('accepts a proposal whose IDs are all in the snapshot', () => {
    expect(validateProposal(createItem(), snapshot).ok).toBe(true);
  });

  it('rejects a hallucinated categoryId', () => {
    const r = validateProposal(createItem({ categoryId: 'cat-nope' }), snapshot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/categoryId/);
  });

  it('rejects a hallucinated itemId on UPDATE_ITEM', () => {
    const r = validateProposal(
      { kind: 'UPDATE_ITEM', itemId: 'item-nope', name: { value: 'x', source: 'user' } } as ProposalPayload,
      snapshot,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects a service record targeting an unknown system', () => {
    const r = validateProposal(
      {
        kind: 'CREATE_SERVICE_RECORD',
        summary: { value: 'Flush', source: 'user' },
        performedOn: { value: '2026-07-03', source: 'user' },
        selfPerformed: true,
        targets: [{ itemId: null, systemId: 'sys-nope' }],
      } as ProposalPayload,
      snapshot,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects an unparseable calendar date', () => {
    const r = validateProposal(
      {
        kind: 'CREATE_SERVICE_RECORD',
        summary: { value: 'Flush', source: 'user' },
        performedOn: { value: '2026-02-30', source: 'user' },
        selfPerformed: true,
        targets: [{ itemId: 'item-1', systemId: null }],
      } as ProposalPayload,
      snapshot,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/date/i);
  });

  it('allows a null itemId on CREATE_NOTE (house-general knowledge)', () => {
    const r = validateProposal(
      {
        kind: 'CREATE_NOTE',
        title: { value: 'Lightbulbs', source: 'user' },
        body: { value: '## Kitchen', source: 'user' },
        itemId: null,
      } as ProposalPayload,
      snapshot,
    );
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec vitest run lib/chat/resolve.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `lib/chat/resolve.ts`:

```ts
import { parseCalendarDate } from './dates';
import type { ProposalPayload } from './schema';

// The model is handed a snapshot of every ID it may reference and MUST NOT mint
// one. Same discipline as validateCandidateIds in lib/incoming-email/ai-classify.
// A proposal referencing an unknown ID is dropped, never written.

export type Snapshot = {
  itemIds: Set<string>;
  systemIds: Set<string>;
  categoryIds: Set<string>;
  noteIds: Set<string>;
};

export type ValidationResult = { ok: true } | { ok: false; reason: string };

const bad = (reason: string): ValidationResult => ({ ok: false, reason });

/** Calendar dates arrive as YYYY-MM-DD and must parse to a real day. */
function checkDate(label: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  return parseCalendarDate(value) ? null : `${label}: not a valid calendar date`;
}

export function validateProposal(p: ProposalPayload, snap: Snapshot): ValidationResult {
  switch (p.kind) {
    case 'CREATE_NOTE':
      // itemId is optional — untargeted notes hold house-general knowledge and
      // are fully embedded and searchable.
      if (p.itemId && !snap.itemIds.has(p.itemId)) return bad('itemId not in snapshot');
      return { ok: true };

    case 'UPDATE_NOTE':
      if (!snap.noteIds.has(p.noteId)) return bad('noteId not in snapshot');
      return { ok: true };

    case 'CREATE_ITEM': {
      if (!snap.categoryIds.has(p.categoryId)) return bad('categoryId not in snapshot');
      const e = checkDate('purchaseDate', p.purchaseDate?.value);
      return e ? bad(e) : { ok: true };
    }

    case 'UPDATE_ITEM': {
      if (!snap.itemIds.has(p.itemId)) return bad('itemId not in snapshot');
      const e = checkDate('purchaseDate', p.purchaseDate?.value);
      return e ? bad(e) : { ok: true };
    }

    case 'UPDATE_SYSTEM': {
      if (!snap.systemIds.has(p.systemId)) return bad('systemId not in snapshot');
      const e = checkDate('installDate', p.installDate?.value);
      return e ? bad(e) : { ok: true };
    }

    case 'CREATE_SERVICE_RECORD': {
      const e = checkDate('performedOn', p.performedOn.value);
      if (e) return bad(e);
      for (const t of p.targets) {
        if (t.itemId && !snap.itemIds.has(t.itemId)) return bad('target itemId not in snapshot');
        if (t.systemId && !snap.systemIds.has(t.systemId))
          return bad('target systemId not in snapshot');
        // XOR, both directions. `service_record_targets` carries a hand-written
        // CHECK constraint (squashed migration.sql:747) that Prisma cannot
        // regenerate. Letting a both-set target through would throw a Prisma
        // constraint error from inside a server action, violating the
        // never-throw skeleton.
        if (!t.itemId && !t.systemId) return bad('target must name an item or a system');
        if (t.itemId && t.systemId) return bad('target must name exactly one of item or system');
      }
      return { ok: true };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm exec vitest run lib/chat/resolve.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/chat/resolve.ts lib/chat/resolve.test.ts
git commit -m "feat(chat): validate proposed IDs against the snapshot"
git log --oneline -1
```

---

### Task 10: Near-duplicate note rewrite

Turns a `CREATE_NOTE` into an `UPDATE_NOTE` when a similar note already exists, so repeated dumps about the same topic supersede rather than accumulate.

**Synchronous and application-side, not RAG** — embeddings are written asynchronously by the `embed.content` worker, so a note created in turn 1 is not RAG-retrievable in turn 3 of the same conversation, which is exactly the case this exists to catch.

**Files:**
- Create: `lib/chat/dedup.ts`
- Test: `lib/chat/dedup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/chat/dedup.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { findDuplicateNote } from './dedup';

const existing = [
  { id: 'note-1', title: 'Lightbulbs' },
  { id: 'note-2', title: 'Roof warranty' },
];

describe('findDuplicateNote', () => {
  it('matches a restatement of an existing title', () => {
    expect(findDuplicateNote('Light bulbs', existing)?.id).toBe('note-1');
  });

  it('returns null when nothing is similar enough', () => {
    expect(findDuplicateNote('Furnace filter sizes', existing)).toBeNull();
  });

  it('returns the highest-scoring match when several pass', () => {
    const many = [
      { id: 'a', title: 'Lightbulb' },
      { id: 'b', title: 'Lightbulbs' },
    ];
    expect(findDuplicateNote('Lightbulbs', many)?.id).toBe('b');
  });

  it('handles an empty corpus', () => {
    expect(findDuplicateNote('Anything', [])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec vitest run lib/chat/dedup.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `lib/chat/dedup.ts`:

```ts
import { diceSimilarity, NOTE_DEDUP_THRESHOLD } from './dice';

export type NoteTitle = { id: string; title: string };

/**
 * Find the existing note a draft title most likely restates.
 *
 * Synchronous and application-side rather than RAG: embeddings are written
 * asynchronously by the embed.content worker (and skipped entirely when
 * ASK_ENABLED is false), so a note created earlier in the SAME conversation is
 * not yet RAG-retrievable — which is the case this is here to catch.
 *
 * A house has hundreds of notes, not millions, so scanning them all in
 * application code is cheap and needs no pg_trgm extension.
 *
 * Returns the highest-scoring match above the threshold, or null.
 */
export function findDuplicateNote(
  draftTitle: string,
  existing: readonly NoteTitle[],
): NoteTitle | null {
  let best: NoteTitle | null = null;
  let bestScore = 0;

  for (const note of existing) {
    const score = diceSimilarity(draftTitle, note.title);
    if (score >= NOTE_DEDUP_THRESHOLD && score > bestScore) {
      best = note;
      bestScore = score;
    }
  }

  return best;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm exec vitest run lib/chat/dedup.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/chat/dedup.ts lib/chat/dedup.test.ts
git commit -m "feat(chat): rewrite duplicate note proposals as updates"
git log --oneline -1
```

---

### Task 11: System prompt and snapshot builder

**Files:**
- Create: `lib/chat/prompt.ts`
- Test: `lib/chat/prompt.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/chat/prompt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildSnapshotBlock, CHAT_SYSTEM_PROMPT } from './prompt';

describe('CHAT_SYSTEM_PROMPT', () => {
  it('forbids inventing IDs', () => {
    expect(CHAT_SYSTEM_PROMPT).toMatch(/never.*(invent|make up)/i);
  });

  it('requires YYYY-MM-DD dates', () => {
    expect(CHAT_SYSTEM_PROMPT).toContain('YYYY-MM-DD');
  });

  it('instructs short topic-scoped notes', () => {
    expect(CHAT_SYSTEM_PROMPT).toMatch(/##/);
  });
});

describe('buildSnapshotBlock', () => {
  it('includes the anchor date and every referenceable id', () => {
    const block = buildSnapshotBlock({
      anchorDay: '2026-07-03',
      items: [{ id: 'item-1', name: 'Water Heater', categoryName: 'Plumbing', location: 'Basement' }],
      systems: [{ id: 'sys-1', name: 'HVAC', location: null }],
      categories: [{ id: 'cat-1', name: 'Lighting' }],
      notes: [{ id: 'note-1', title: 'Lightbulbs' }],
    });

    expect(block).toContain('2026-07-03');
    expect(block).toContain('item-1');
    expect(block).toContain('sys-1');
    expect(block).toContain('cat-1');
    expect(block).toContain('note-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec vitest run lib/chat/prompt.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `lib/chat/prompt.ts`:

```ts
export const CHAT_SYSTEM_PROMPT = `You are the assistant inside a self-hosted home information manager.

The user will either ASK you something about their house, or TELL you something
new. Decide which from the turn itself — a single turn may do both.

When the user ASKS: answer from the retrieved context. If the context does not
support an answer, say so. Do not guess.

When the user TELLS you something: propose structured changes to their records.

RULES FOR PROPOSALS

1. IDs. You are given a snapshot of every item, system, category and note you may
   reference. Only ever use an id from that snapshot. NEVER invent an id, and
   never propose a change to something that is not listed. If the user refers to
   something you cannot find, say so and propose nothing for it.

2. Dates. Always emit calendar dates as YYYY-MM-DD strings. Never emit a
   timestamp. Today's date at the house is given in the snapshot — resolve
   relative expressions ("Tuesday", "last week") against it.

3. Notes. Prefer a note for knowledge that is not an event. Keep every note
   SHORT and scoped to ONE topic, using "##" headed sections. Do NOT produce one
   large markdown table — long tables are split during indexing and the trailing
   pieces lose their header row, making them unretrievable. If you have more
   than one topic, propose several small notes instead of one big one.
   Leave itemId null when the knowledge is house-general rather than about one
   specific item.

4. Provenance. You may enrich what the user typed using your own knowledge — for
   example decoding a model number into its specifications. Mark every value you
   inferred with source "inferred". Mark everything the user actually said with
   source "user". Never present an inference as something the user told you.

5. Scope. You may create notes, items and service records, and update notes,
   items and systems. You may NOT delete, archive or unlink anything.

Be brief in your reply. The proposals carry the detail.`;

export type SnapshotInput = {
  anchorDay: string;
  items: Array<{ id: string; name: string; categoryName: string; location: string | null }>;
  systems: Array<{ id: string; name: string; location: string | null }>;
  categories: Array<{ id: string; name: string }>;
  notes: Array<{ id: string; title: string }>;
};

/**
 * The snapshot the model resolves references against. Every id it may legally
 * emit appears here; `validateProposal` re-checks each one server-side.
 */
export function buildSnapshotBlock(s: SnapshotInput): string {
  const lines = [
    `Today at the house: ${s.anchorDay}`,
    '',
    'CATEGORIES (id | name)',
    ...s.categories.map((c) => `${c.id} | ${c.name}`),
    '',
    'SYSTEMS (id | name | location)',
    ...s.systems.map((x) => `${x.id} | ${x.name} | ${x.location ?? '-'}`),
    '',
    'ITEMS (id | name | category | location)',
    ...s.items.map((i) => `${i.id} | ${i.name} | ${i.categoryName} | ${i.location ?? '-'}`),
    '',
    'NOTES (id | title)',
    ...s.notes.map((n) => `${n.id} | ${n.title}`),
  ];
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm exec vitest run lib/chat/prompt.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/chat/prompt.ts lib/chat/prompt.test.ts
git commit -m "feat(chat): add chat system prompt and snapshot builder"
git log --oneline -1
```

---

### Task 12: The turn action

Wires everything together. Model this closely on `lib/ask/actions.ts` — it already does auth, rate limit, embed, retrieve, Anthropic call, and logging.

**Files:**
- Create: `lib/chat/actions.ts`
- Create: `lib/chat/title.ts` and `lib/chat/title.test.ts`
- Create: `tests/integration/chat/turn.test.ts`
- Create: `tests/fixtures/chat/*.json` (Anthropic response fixtures)

> **This is an integration test, not a unit test.** `lib/ask/actions.test.ts` contains **no mocks at all** — it only exercises `askQuestionInputSchema`. The real precedent for testing an Anthropic-calling server action in this repo is `tests/integration/ai/propose-reminders.test.ts`, which combines Testcontainers with three shared helpers:
>
> - `tests/integration/ai/_mock-ai-client.ts` — `mockParse(fixture)`, `mockParseError(err)`, `getLastCall()`, `resetMock()`
> - `tests/integration/ai/_mock-auth.ts` — `signInAs(userId)`, `currentUserId()`
> - `tests/integration/helpers.ts` — `setupIntegration` / `teardownIntegration`
>
> **The closer precedent is `tests/integration/ask-flow.test.ts:1-24`** — read it first. It is the only integration test that already solves *all three* of this task's problems: it mocks Voyage **and** Anthropic via `vi.hoisted`, and it carries an `askEnabled` toggle in its hoisted mock state.
>
> That last part is not optional. `chatTurn` gates on `getEnv().ASK_ENABLED`, and `helpers.ts:42-48` sets only `DATABASE_URL` and `MEILI_*` — **nothing sets `ASK_ENABLED`**. Copying `propose-reminders.test.ts` alone yields a turn action that early-returns on the env gate, and every test fails identically with an unhelpful message.
>
> Use `ask-flow.test.ts` for the hoisted mock structure and the env gate; use `_mock-ai-client.ts` / `_mock-auth.ts` for the parse helpers if you prefer them. Fixtures go in `tests/fixtures/chat/` alongside `tests/fixtures/suggest/`.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/chat/turn.test.ts`.

The `vi.mock('@/lib/ai/client')` factory returns a **complete replacement module** — it hand-lists every export. A named import absent from the factory throws `No "X" export is defined on the mock`. So the factory must include `ANTHROPIC_CHAT_MAX_TOKENS: 4096` alongside `getAnthropic`, `ANTHROPIC_MODEL` and `ANTHROPIC_MAX_TOKENS`.

Also mock `@/lib/embedding/voyage` (`embedTexts` → one `Float32Array(1024)`) and `@/lib/ask/retrieve` (`retrieveTopK` → `[]`) so the turn needs no live Voyage key.

**Add `vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))` now, even though `chatTurn` does not call it yet.** Task 13 adds `applyProposal` to the *same* module, which imports `revalidatePath` at top level — without the mock, this file goes green here and silently regresses at Task 13. `ask-flow.test.ts` and `rename-cascade.test.ts` do not carry this mock; `propose-reminders.test.ts:17` does. Copy it from there.

`getHouseTimezone()` needs no seeding — it falls back to `HOUSE_DEFAULT_TIMEZONE` when no `HouseProfile` row exists (`lib/house-profile/queries.ts:19-22`), which is what makes the date assertion deterministic.

Cases, each driven by a fixture passed to `mockParse`:

```ts
// 1. Drops a proposal whose id is absent from the snapshot.
//    Seed one item; fixture proposes UPDATE_ITEM against 'item-nope'.
//    Assert: ok === true, reply preserved, zero ChatProposal rows.
//
// 2. Rewrites a duplicate CREATE_NOTE into UPDATE_NOTE.
//    Seed a note titled "Lightbulbs"; fixture proposes CREATE_NOTE
//    titled "Light bulbs". Assert: one proposal, kind UPDATE_NOTE,
//    targetId === the seeded note id.
//
// 3. Drops an over-length note body, keeps the turn's other proposals,
//    and appends the explanation to the reply (see Step 3, point 10).
//
// 4. Records baseUpdatedAt + beforeSnapshot for update kinds and leaves
//    both null for create kinds.
//
// 5. Rejects a CREATE_SERVICE_RECORD target with BOTH itemId and systemId
//    set (the XOR constraint), and one with neither.
//
// 6. Stores performedOn as the correct UTC day. Fixture says "2026-07-03";
//    assert the stored payload round-trips to 2026-07-03T00:00:00.000Z.
//
// 7. mockParseError → ok === false, an ASSISTANT ChatMessage row carrying
//    the error reason exists, and an AISuggestionLog row has errorReason set.
//
// 8. Rate limit: 40 chat turns in the hour blocks the 41st, and Ask usage
//    does not count against it.
//
// 9. ChatSession.title is the first non-empty line of the first user turn,
//    truncated to 80 chars on a word boundary. Include a case where the
//    first line is blank and one where the turn is a single 8000-char blob.
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm exec vitest run tests/integration/chat/turn.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `chatTurn`**

Create `lib/chat/actions.ts`. The pipeline, in order:

1. `auth()` → `{ ok: false, formError: 'Unauthorized' }` if absent. **Never throw.**
2. `getEnv().ASK_ENABLED` gate, mirroring `lib/ask/actions.ts`.
3. `chatTurnInputSchema.safeParse(input)` → `fieldErrors` on failure.
4. `checkRateLimit(userId, 'chat')` → `formError` with `rl.limit`, and write an error `AISuggestionLog` row exactly as Ask does.
5. `getHouseTimezone()` then `resolveAnchorDay(new Date(), tz)` for the anchor.
6. `embedTexts([lastTurn], { inputType: 'query' })` → `retrieveTopK(embedding, { k: 12 })`.
7. Build the snapshot (items, systems, categories, note titles) and `buildSnapshotBlock`.
8. `getAnthropic().messages.parse({ model: ANTHROPIC_MODEL, max_tokens: ANTHROPIC_CHAT_MAX_TOKENS, system: [{ type: 'text', text: CHAT_SYSTEM_PROMPT }, { type: 'text', text: snapshotBlock, cache_control: { type: 'ephemeral' } }], messages, output_config: { format: zodOutputFormat(chatTurnOutputSchema) } })`.
9. For each returned proposal, in order:
   - `validateProposal(p, snapshot)` → on failure, **drop it** and record the reason in the log. Never write it.
   - `CREATE_NOTE` only: `findDuplicateNote(title, existingNoteTitles)` → on a match, rewrite to `{ kind: 'UPDATE_NOTE', noteId: match.id, title, body }`.
   - **Update kinds only:** re-read the target row once, taking both `updatedAt` (→ `baseUpdatedAt`) and the current values of the fields this proposal touches (→ `beforeSnapshot`). One read produces both; do not read twice.
10. **Note-length breach.** `proposalPayloadSchema` rejects a body over `NOTE_BODY_MAX`, so an over-length proposal fails parse and is dropped like any other invalid one. Because the reply is authored by the model *before* the server drops anything, the server **appends** a sentence to `reply` when it drops one for length:
    `"\n\n(One proposed note was too long to store well and was dropped — try splitting that topic into its own message.)"`
    The other proposals in the turn are unaffected.
11. `createSuggestionLog({ kind: 'chat', ... })` → returns the created row. **Do this before persisting `ChatMessage`** — `ChatMessage.aiSuggestionLogId` is a forward FK, so writing the message first leaves the column permanently null and silently defeats the admin-dashboard link.
12. Persist, in one `prisma.$transaction`: `ChatSession` (create when `sessionId` is absent), the USER `ChatMessage`, the ASSISTANT `ChatMessage` carrying `aiSuggestionLogId` from step 11, and the surviving `ChatProposal` rows.
13. Return `{ ok: true, data: { sessionId, messageId, reply, proposals } }`.

**Session title** (step 12) — extract to `lib/chat/title.ts` so it is unit-testable. It does not go in `schema.ts`: that file is Zod-only per the feature-module convention.

Write `lib/chat/title.test.ts` alongside it, covering: a normal first line; a leading blank line; a line over 80 chars cut on a word boundary; a single 8000-char blob with no spaces (falls back to a hard cut, not an empty string); and an all-whitespace turn (yields `'Untitled'`).

```ts
export function deriveSessionTitle(firstTurn: string): string {
  const line = firstTurn.split('\n').map((l) => l.trim()).find(Boolean) ?? 'Untitled';
  if (line.length <= 80) return line;
  const cut = line.slice(0, 80);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
```

**Prior turns are replayed from `ChatMessage`, not client state.** Only the latest turn is wrapped with retrieved context — matching `lib/ask/actions.ts:153-160`. Do not re-send earlier turns' chunks.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm exec vitest run tests/integration/chat/turn.test.ts
pnpm exec vitest run lib/chat/title.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/chat/actions.ts lib/chat/title.ts lib/chat/title.test.ts tests/integration/chat tests/fixtures/chat
git commit -m "feat(chat): add conversational turn action"
git log --oneline -1
```

---

### Task 13: Apply and reject actions

**The side effects are NOT uniform across kinds.** Copy them from the existing action for each entity. Writing `UPDATE_SYSTEM` by analogy with `UPDATE_ITEM` will not compile (good); writing `UPDATE_ITEM` by analogy with `CREATE_ITEM` compiles fine and silently leaves every child embedding carrying the item's old name (bad).

| kind | side effects | revalidatePath |
|---|---|---|
| `CREATE_NOTE` | `enqueueSearchIndex('note', id, 'upsert')` + `enqueueEmbed('NOTE', id)` | `/notes`, `/dashboard`, `/items/<itemId>` if linked |
| `UPDATE_NOTE` | same | as above, **for both old and new item** if re-targeted |
| `CREATE_ITEM` | `enqueueSearchIndex('item', …)` + `enqueueEmbed('ITEM', …)` | `/items`, `/dashboard` |
| `UPDATE_ITEM` | above **+ `enqueueItemRenameCascade(id)`** | `/items`, `/items/<id>`, `/dashboard` |
| `CREATE_SERVICE_RECORD` | `enqueueSearchIndex('service', …)` + `enqueueEmbed('SERVICE_RECORD', …)` | `/service-records`, `/dashboard`, `/vendors/<vendorId>`, and **per target** `/items/<id>` / `/systems/<id>` |
| `UPDATE_SYSTEM` | **`enqueueSystemRenameCascade(id)` only** | `/systems`, `/systems/<id>` |

`enqueueItemRenameCascade` is called **unconditionally**, not gated on a name change — `lib/items/actions.ts:102` has no guard, because the embed worker hashes canonical text and skips no-op re-embeds. Do not add an `if (nameChanged)` guard.

Reuse the revalidation helpers in `lib/notes/actions.ts`, `lib/service-records/actions.ts`, `lib/items/actions.ts` and `lib/systems/actions.ts` rather than re-deriving paths.

**Files:**
- Modify: `lib/chat/actions.ts`
- Test: `tests/integration/chat/apply.test.ts` (create)

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/chat/apply.test.ts`.

> **Read `tests/integration/rename-cascade.test.ts:9-16` first, not `notes.test.ts`.** Two of this task's most important assertions — that `UPDATE_SYSTEM` fires the cascade and does *not* index or embed, and that `UPDATE_ITEM` fires the rename cascade — require spies on `@/lib/embedding/enqueue`, `@/lib/search/client` and `@/lib/embedding/cascade`. `notes.test.ts` mocks nothing and cannot support them. `rename-cascade.test.ts` is the precedent: it `vi.mock`s `@/lib/embedding/enqueue` into a call-recording array **before** importing the cascade module, with a comment explaining why the ordering matters (the helper imports eagerly).

`revalidatePath` throws outside a request scope, so this file **must** carry `vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))` — see `propose-reminders.test.ts:17`.

Cover:

```ts
// - Each of the six kinds applies, writes the row, sets appliedEntityId +
//   appliedAt, and flips status to ACCEPTED.
// - UPDATE_SYSTEM fires enqueueSystemRenameCascade and does NOT attempt to
//   search-index or embed the system.
// - UPDATE_ITEM fires enqueueItemRenameCascade in addition to index + embed.
// - baseUpdatedAt mismatch yields STALE and performs NO write.
// - A deleted target yields ORPHANED and performs NO write.
// - Re-applying an ACCEPTED proposal is a no-op, not a duplicate row.
// - An unparseable stored payload yields INVALID rather than throwing.
// - CREATE_SERVICE_RECORD with nested targets: { create: [...] } passes the
//   calendar-date guard and stores performedOn as the correct UTC day.
// - An applied note ENQUEUES an embed job — assert against the enqueue spy,
//   not the embeddings table. enqueueEmbed only sends a pg-boss job
//   (lib/embedding/enqueue.ts:27-38) and no worker runs in the integration
//   harness, so asserting on the table would never pass.
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm exec vitest run tests/integration/chat/apply.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `applyProposal` and `rejectProposal`**

Append to `lib/chat/actions.ts`. `applyProposal(proposalId: unknown)` sequence:

1. `auth()`; load the proposal joined to its message → session; **verify `session.userId` matches** — proposals are reachable by id and the entities they write are house-global.
2. Status must be `PENDING`; anything else returns `formError` (this is the idempotency guard — an `ACCEPTED` proposal cannot apply twice).
3. `parseStoredPayload(proposal.payload)` → null means status `INVALID`, return `formError` "this proposal predates a schema change and can no longer be applied".
4. **Update kinds only:** re-read the target. Missing → `ORPHANED`, `formError` "the record this refers to was deleted". Then compare `baseUpdatedAt` to the row's current `updatedAt`; mismatch → `STALE`, `formError` prompting re-confirmation. `STALE` is not an error state to log.
5. Write the row. Calendar dates go through `parseCalendarDate` — **never** `new Date()`.
6. Merge `_provenance` into `metadata` for `CREATE_ITEM` / `UPDATE_ITEM` / `UPDATE_SYSTEM`, preserving existing keys. **Shape is a flat field → source map**, matching what Task 1's canonicalizer test assumes:

   ```jsonc
   { "_provenance": { "model": "inferred", "serialNumber": "user" } }
   ```

   Merge, never replace: read the row's current `metadata`, spread the existing `_provenance` beneath the new entries, and write the result. A field the user later corrects by hand keeps whatever provenance was last written for it.

   Note `UPDATE_SYSTEM` must write `metadata` via `prisma.system.update` directly — `updateSystemWithIdSchema` does not accept the field, and this path deliberately bypasses the form schema.
7. Fire that kind's side effects from the table above. Non-fatal.
8. Set `status: 'ACCEPTED'`, `appliedEntityId`, `appliedAt`.
9. `revalidatePath` per the table, plus `/ask`.
10. Return `{ ok: true, data: { id } }`.

`rejectProposal(proposalId: unknown)` is the same auth + ownership check, then **status must be `PENDING` or `STALE`** — without that guard an already-`ACCEPTED` proposal can be marked rejected, mislabelling a change that was actually applied. Then `status: 'REJECTED'`. No writes, no side effects.

**`refreshProposal(proposalId: unknown)` — the way out of `STALE`.**

Without this, `STALE` is a dead end: step 2 rejects anything not `PENDING`, so a proposal that goes stale can never be applied, only rejected. Four places assume otherwise — the schema comment, spec §5 step 2, Task 14's re-confirm affordance, and Task 17's stale e2e — so the action is required, not optional.

1. Same auth + ownership check.
2. Status must be `STALE`; anything else returns `formError`.
3. Re-read the target. Missing → `ORPHANED`, `formError`.
4. Recompute `baseUpdatedAt` and `beforeSnapshot` from that read — one read, both values, same as Task 12 step 9.
5. Set `status: 'PENDING'`.
6. Return `{ ok: true, data: { proposal } }` — the **full refreshed proposal**, not just its id. The card is handed its new state directly and does no querying (Task 14).

The user then reviews the refreshed before/after and clicks Accept as normal. This deliberately does **not** auto-apply: the whole point of `STALE` is that the record changed underneath and the user has not seen the new state.

Add to the Task 13 integration test:

```ts
// - refreshProposal on a STALE proposal recomputes baseUpdatedAt and
//   beforeSnapshot from the current row and returns it to PENDING.
// - The refreshed proposal then applies successfully.
// - refreshProposal on a PENDING proposal returns formError and changes nothing.
// - refreshProposal on a deleted target yields ORPHANED, not PENDING.
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm exec vitest run tests/integration/chat/apply.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/chat/actions.ts tests/integration/chat/apply.test.ts
git commit -m "feat(chat): apply and reject proposals with per-kind side effects"
git log --oneline -1
```

---

# Phase 5 — UI

Follow the existing conventions: shadcn primitives backed by **`@base-ui/react`, not Radix** — use the `render` prop, never `asChild`. Add primitives with `pnpm dlx shadcn@latest add <name>`.

---

### Task 14: Diff row and proposal card

**Files:**
- Create: `components/chat/DiffRow.tsx`
- Create: `components/chat/ProposalCard.tsx`
- Test: `components/chat/ProposalCard.test.tsx`

- [ ] **Step 1: Write the failing component test**

Create `components/chat/ProposalCard.test.tsx`:

```tsx
// - Renders the proposal kind as a human label ("New note", "Update item").
// - Renders a before/after pair for update kinds and a single value for creates.
// - Renders an "inferred" badge on fields whose source is 'inferred', and no
//   badge on 'user' fields.
// - Accept and Reject call their handlers with the proposal id.
// - A STALE proposal renders the re-confirm affordance instead of plain Accept.
// - An ORPHANED proposal explains the record was deleted; an INVALID one
//   explains the proposal predates a schema change. The two messages differ.
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm exec vitest run components/chat/ProposalCard.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement both components**

`DiffRow` renders one field: label, optional before value (struck through / muted), after value, and an "inferred" badge when `source === 'inferred'`.

**Where the before-values come from:** `ChatProposal.beforeSnapshot` (Task 4), captured server-side in the same read that produced `baseUpdatedAt`. The card does no querying — it is handed both halves. Create kinds have `beforeSnapshot: null` and render a single value with no strike-through.

`ProposalCard` composes `DiffRow`s inside a shadcn `Card`, with `Button`s for Accept/Reject wired through `useTransition` for pending state. Terminal statuses (`ACCEPTED`, `REJECTED`, `ORPHANED`, `INVALID`) render their explanation and no action buttons.

**`STALE` renders a "Review changes" button bound to `refreshProposal`**, not to Accept. That action returns the **refreshed proposal** — new `beforeSnapshot`, new `baseUpdatedAt`, status back to `PENDING` — and the card replaces its own state with it so the user sees the new diff before accepting. (Task 13's `refreshProposal` must therefore return the proposal, not just `{ id }`.)

**Rendering dates.** Date fields in `beforeSnapshot` are `YYYY-MM-DD` **strings**, not `Date`s. `formatCalendarDate` takes a *branded* `CalendarDate` (`lib/time/tz.ts:41`), so a plain `Date` is not assignable and `tsc` will reject it. Render with `formatCalendarDate(asCalendarDate(parseCalendarDate(v)))` using `asCalendarDate` from `lib/time/tz.ts:69`. **Never `new Date(v)`** — that reintroduces the timezone shift the string format exists to prevent.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm exec vitest run components/chat/ProposalCard.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/chat/DiffRow.tsx components/chat/ProposalCard.tsx components/chat/ProposalCard.test.tsx
git commit -m "feat(chat): add proposal card and diff row components"
git log --oneline -1
```

---

### Task 15: Chat thread

**Files:**
- Create: `components/chat/ChatThread.tsx`
- Create: `app/(app)/ask/[sessionId]/page.tsx`
- Modify: `app/(app)/ask/page.tsx`

- [ ] **Step 1: Implement `ChatThread`**

`'use client'`. Model it on `components/ask/AskForm.tsx:1-60` — reuse its textarea, submit affordance, and thread rendering. Changes:

- Actions are **injected as props** by the server page, not imported. One component; the server page passes `chatTurn`, `applyProposal`, `rejectProposal` and `refreshProposal`. Omitting the last one strands every `STALE` card with no handler and leaves the action knip-flagged as unused at Task 18's push.
- Assistant turns render `reply` plus a `ProposalCard` per proposal.
- Accepting or rejecting updates that card's status in place.
- `useTransition` for pending state; `sonner` for toasts. `useActionState` is used nowhere in this repo — do not introduce it.

- [ ] **Step 2: Update the page and add the session route**

A session needs a URL — both the e2e (Task 17) and "session reload" depend on it, and `/ask` alone cannot address one. Following this repo's `[id]` convention (`/items/[id]`, `/systems/[id]`):

- `app/(app)/ask/page.tsx` — a **new**, empty session. On the first turn, `chatTurn` creates the `ChatSession` and the client `router.replace`s to its URL so a reload does not lose the thread.
- `app/(app)/ask/[sessionId]/page.tsx` — **create.** Server component: `auth()` for the user id, `getChatSession(sessionId, userId)`, `notFound()` when null (which covers both "does not exist" and "belongs to someone else" — do not distinguish them), then render `ChatThread` with the loaded thread and the actions injected.

Both routes live under `app/(app)/`, which is the only auth boundary — a page created at top level ships publicly with no auth and nothing errors.

**Gate the composer, not the page** (this is what makes Task 17 possible). Keep reading `process.env.ASK_ENABLED` directly rather than `getEnv()`, as `page.tsx:10` does today, so the page still renders on a partially-configured deployment. But pass the flag down as a prop and let `ChatThread` hide only the textarea and submit button when it is false. Existing sessions and their proposal cards must still render and still apply with the flag off — turning the feature off should not strand proposals the user already captured.

- [ ] **Step 3: Verify manually**

```bash
docker compose up -d db meilisearch
pnpm dev
```

Visit `/ask`. Dump "I reset the water heater on the 3rd" and confirm a proposal card appears with the correct date. Accept it and confirm the service record exists.

- [ ] **Step 4: Commit**

```bash
git add components/chat/ChatThread.tsx "app/(app)/ask/page.tsx" "app/(app)/ask/[sessionId]/page.tsx"
git commit -m "feat(chat): render conversational capture at /ask"
git log --oneline -1
```

---

### Task 16: Retire `askQuestion`

Only now, once chat fully replaces it.

**Files:**
- Modify: `lib/ask/actions.ts` — remove `askQuestion` and, if nothing else references them, `enrichCitations` / `EnrichedAskAnswer` / `EnrichedAskCitation`
- Delete: `components/ask/AskForm.tsx` (imports `askQuestion` at `:16`)
- Delete: `components/ask/AskAnswer.tsx` and `components/ask/CitationChip.tsx` — only `AskForm` renders them
- Modify/delete: `lib/ask/actions.test.ts` — it tests `askQuestionInputSchema`, so it goes if that schema goes

**Keep** `lib/ask/retrieve.ts` and `lib/ask/strip-tags.ts` — chat uses both.

**Correction to the Task 7 note:** removing `askQuestion` orphans `askQuestionInputSchema`, `askAnswerSchema`, `askCitationSchema` in `lib/ai/schemas.ts` and `ASK_SYSTEM_PROMPT` in `lib/ai/prompts.ts`. The "`lib/ai/schemas.ts` is left untouched" rule applies while *building* chat — it prevents an inverted dependency. It does not survive this deletion task. Let `lint:knip` tell you exactly what is now unreachable and delete precisely that; do not guess, and do not add a knip ignore to keep something alive.

- [ ] **Step 1: Remove and verify**

```bash
pnpm lint          # knip flags anything now unreachable
pnpm typecheck
pnpm test:unit
```

Expected: PASS. `lint:knip` runs on pre-push and will catch any export left dangling — fix by deleting it, not by adding a knip ignore.

- [ ] **Step 2: Commit**

```bash
git add -A lib/ask components/ask
git commit -m "refactor(ask): retire one-shot askQuestion in favour of chat"
git log --oneline -1
```

---

# Phase 6 — End-to-end and verification

---

### Task 17: `@critical` e2e spec

**Files:**
- Create: `tests/e2e/chat-capture.spec.ts`
- Create: a seed helper that inserts a `ChatSession` + `ChatMessage` + `PENDING` `ChatProposal` directly

> **Scope this narrowly, and understand why.** `tests/e2e/_env-local.sh:61-63` sets `ANTHROPIC_API_KEY="sk-ant-test-placeholder"`, `VOYAGE_API_KEY="fixture"` and **`ASK_ENABLED="false"`**. Task 15 keeps the `ASK_ENABLED` gate, so `/ask` renders the *disabled* fallback under the e2e harness. A test that types a dump and waits for the model to respond is not flaky here — it **cannot run at all**, because there is no Anthropic fake and no live key.
>
> So the e2e covers **the half that does not need the model**: reviewing and applying a proposal that already exists. Seed the session, message and `PENDING` proposal straight into the DB, navigate to it, and drive the card. The model-dependent half (dump → proposals) is covered by the integration tests in Task 12, where `_mock-ai-client` supplies the response.
>
> Full dump→propose e2e is blocked on the fakes server (the planned "Phase 2" of the testing strategy). Do not build it here, and do not flip `ASK_ENABLED` to `true` in the shared env to force it — that would send real requests to a placeholder key and fail the whole suite.

> Task 15 Step 2 already gates only the composer on `ASK_ENABLED`, which is what makes the seeded session reachable with the flag off. Nothing further is needed here — do not re-edit the page.

- [ ] **Step 1: Write the spec**

One `@critical` test: sign in, navigate to the seeded session, assert the proposal card renders with the right before/after, click Accept, assert the underlying record now exists.

Non-critical tests in the same file: reject; a `STALE` proposal (mutate the target row between seed and visit) showing the re-confirm affordance; session reload preserving the thread.

**Playwright gotcha:** click `label[for="…"]`, not a bare `RadioGroupItem` — the underlying control is visually collapsed and Playwright errors with "outside of viewport". See the target pickers in `tests/e2e/systems.spec.ts`.

- [ ] **Step 2: Run it**

```bash
pnpm test:e2e:local tests/e2e/chat-capture.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/chat-capture.spec.ts
git commit -m "test(chat): add critical e2e for capture and accept"
git log --oneline -1
```

---

### Task 18: Full verification

- [ ] **Step 1: Run the full local gate**

```bash
pnpm test:local
```

This runs unit → integration → e2e → coverage floor. CI only runs the lean gate, so the full e2e suite and the coverage floor are your responsibility here.

- [ ] **Step 2: If coverage is red, add tests**

**Never** lower a threshold in `vitest.config.ts`. The floor only ratchets up. Neither the unit nor the integration subset clears it alone — the `coverage` job merges both blobs.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/conversational-capture
gh pr create --fill
```

Then: watch **strictly** the "Sourcery review" check. If it runs, address its comments first. Then `gh pr merge --auto --squash`, then `gh pr checks --watch --fail-fast`. Run both watches in the background.

---

## Deferred — do not build

Explicitly out of scope, recorded so nobody adds them opportunistically:

- Reminders and warranties as proposal kinds. Reminders drag in recurrence rules and the `reminder_targets` XOR relaxation; warranties need date-range validation. Both also need a concurrency answer `baseUpdatedAt` cannot give, since `ReminderTarget` has no `updatedAt`.
- Agentic tool-use loop (`search_entities` / `read_entity`).
- RAG-based cross-session note deduplication, layered over Task 10.
- A sweeper for stale `PENDING` proposals, analogous to `notify-log.sweep`.
- Destructive proposal kinds.
- Retro-fitting the 1800-char note ceiling onto the manual note form.
