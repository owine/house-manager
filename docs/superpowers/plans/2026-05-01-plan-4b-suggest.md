# Plan 4b — Suggest: AI-generated reminders & checklists — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Claude-powered structured-output suggestions for maintenance reminders and seasonal checklists across 5 entry points, plus the deferred Checklist + ChecklistItem template tables, plus `AISuggestionLog` telemetry, plus per-user rate limiting.

**Architecture:** Synchronous Server Actions (no worker queue). Each call: build context (HouseProfile + inventory filtered by `includeInSuggestions`) → `anthropic.messages.parse` with a Zod schema and a prompt-cache marker → log to `AISuggestionLog` → return proposals to the client. Save actions update the same log row's `acceptedItemIds`. Checklist becomes the 7th `kind` in the unified Meilisearch index built in Plan 4a. See `docs/superpowers/specs/2026-05-01-plan-4b-suggest-design.md`.

**Tech Stack:** Next.js 16 App Router, TypeScript 6, Prisma 7, Postgres 16, Auth.js v5, Meilisearch 1.42 (existing), pg-boss 12 (existing — used only to enqueue checklist search-index sync, not for AI calls), `@anthropic-ai/sdk` (new dep), Zod 4, React Hook Form 7, Vitest 4 + Testcontainers, Playwright, Biome 2.

---

## Task 0: Pre-flight greps (do this first, no commit)

Before starting Task 1, take 5 minutes to locate the existing patterns this plan calls back to. The plan tells you to grep for these in various tasks; doing it once up front saves context-switching mid-task.

- [ ] **Reminder model**: confirm `prisma/schema.prisma` `model Reminder` has `recurrence Json`, `nextDueOn DateTime`, `leadTimeDays Int`, `notifyUserIds String[]`, `autoCreateServiceRecord Boolean`. (Verified during plan-writing — should match. If it doesn't, Task 11's reminder-creation logic needs adjustment.)
- [ ] **Search infrastructure** (Plan 4a): read `lib/search/{client,schema,document}.ts` and `worker/jobs/search-index.ts` to internalize the existing kind dispatch pattern. Task 14 mirrors it.
- [ ] **Helpers**: `tests/integration/helpers.ts` — confirm `setupIntegration`, `signInAs`, and `waitForIndexed` exist. If `signInAs` is named differently (e.g., `mockAuth`), update Tasks 9-13 to match.
- [ ] **Logger**: `grep -rn "pino\|logger" lib/` — the spec calls for a Pino structured log at the action boundary. **As of plan-writing the repo has NO logger module.** Tasks 9 and 10 below add a single `console.log({event, ...})` line at the action boundary as a placeholder, with a `// TODO(plan-5): replace with project logger` comment. Don't add Pino as a dep in this plan.
- [ ] **Auth**: `lib/auth.ts` exports `auth()`. There is no `requireSession()` despite the spec's wording — use `auth()` per the convention block above.
- [ ] **EmptyState**: `grep -rn "EmptyState" components/` — used in Task 16. Confirm import path (`@/components/EmptyState`).
- [ ] **Item-create redirect**: `grep -n "router.push\|redirect" app/\(app\)/items/new lib/items/actions.ts` — Task 21 modifies this redirect; locate where the `/items/${id}` push currently lives (in the page's onSubmit, or in the action via `redirect()` from `next/navigation`).
- [ ] **Admin layout**: `ls app/\(app\)/admin 2>/dev/null` — Task 25 either appends to or creates the admin layout.

Note any deltas from this plan's assumptions in your scratch notes — they'll come up again later.

---

## Conventions for the implementer

These are project conventions enforced across every task. Don't deviate without flagging.

- **Commits**: signed via 1Password (just `git commit` — no `-c user.email=`, no `--no-verify`, no `--no-gpg-sign`). Stage explicit paths, never `git add -A`. Conventional-commits subject prefixes (`feat(ai):`, `test(ai):`, `fix(ai):`, `feat(checklists):`, `feat(search):`, etc.).
- **Push cadence**: branch accumulates commits across all tasks; push happens at the end via `superpowers:finishing-a-development-branch`. Branch is already `plan-4b-suggest` (off main, spec already committed as `ee002a4`).
- **Combined Haiku reviewer per task** after implementation, per `feedback_execution_cadence` memory.
- **Dependency pinning**: every new dep uses `~` (patch-level) range per `feedback_dep_pinning`. Run `pnpm view <pkg>@latest version` before adding to confirm currency (per `feedback_dep_currency`).
- **Module-load DATABASE_URL trap** (from Plan 4a): `lib/db.ts` constructs PrismaClient at module load using `process.env.DATABASE_URL`. Any integration test that transitively imports `lib/db` must use the **dynamic-import-in-`beforeAll`** pattern from `tests/integration/notify-job.test.ts`. Static `import { prisma } from '@/lib/db'` at file top blows up with `SCRAM-SERVER-FIRST-MESSAGE: client password must be a string` if `DATABASE_URL` isn't set before the file is parsed. The existing `setupIntegration` helper sets it before tests run — but only if you import it dynamically too.
- **CI / Dockerfile env trap** (from Plan 3 PR cleanup): adding any new required env var to `lib/env.ts` requires three more edits — `.github/workflows/ci.yml` e2e job env block, `Dockerfile` build-step env line (placeholder), and `docker-compose.yml` if running the worker locally. This plan adds **one** new env var (`ANTHROPIC_API_KEY`); Task 2 covers all three locations.
- **Auth pattern**: this codebase uses `auth()` from `@/lib/auth` (not `requireSession()` — the spec used that name as shorthand). The standard guard is:
  ```ts
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };
  ```
  Admin gates additionally check `session.user.role === 'ADMIN'`.
- **`ActionResult` shape**: every Server Action returns `ActionResult<T>` from `lib/result.ts`. The spec showed plain `Promise<{...}>` shapes — use `ActionResult<{...}>` to match the rest of the codebase.
- **Tests location**: pure unit tests colocate as `<module>.test.ts` next to source (e.g., `lib/ai/schemas.test.ts`); DB- or container-touching tests live under `tests/integration/`; E2E specs under `tests/e2e/`.
- **Anthropic SDK call shape verification**: the spec calls `client.messages.parse({ output_config: { format: zodOutputFormat(...) } })`. Task 4 verifies this method/signature is GA on `@anthropic-ai/sdk`'s current version against the live API docs (via `mcp__plugin_context7_context7__query-docs`) before locking in. Fallback path: forced tool-use via `betaZodTool` with the same Zod schemas.
- **No silent error swallowing**: SDK retries get one extra retry-with-backoff layer at the action boundary; on final failure log to `AISuggestionLog` with `errorReason`, return `ok: false`, surface a toast on the client. Never `console.error` and continue with empty proposals.

---

## File structure (new files this plan creates)

```
prisma/migrations/<ts>_plan_4b_suggest/migration.sql       # Task 1
prisma/schema.prisma                                       # modified Task 1

lib/env.ts                                                 # modified Task 2
lib/ai/client.ts                                           # Task 2
lib/ai/schemas.ts                                          # Task 3
lib/ai/schemas.test.ts                                     # Task 3
lib/ai/prompts.ts                                          # Task 4
lib/ai/prompts.test.ts                                     # Task 4
lib/ai/context-builder.ts                                  # Task 5
lib/ai/log.ts                                              # Task 6
lib/ai/rate-limit.ts                                       # Task 7
lib/ai/suggest/actions.ts                                  # Tasks 9-12
tests/setup/anthropic-mock.ts                              # Task 8
tests/fixtures/suggest/*.json                              # Task 8

tests/integration/ai/context-builder.test.ts               # Task 5
tests/integration/ai/log.test.ts                           # Task 6
tests/integration/ai/rate-limit.test.ts                    # Task 7
tests/integration/ai/propose-reminders.test.ts             # Task 9
tests/integration/ai/propose-checklist.test.ts             # Task 10
tests/integration/ai/save-accepted.test.ts                 # Tasks 11-12
tests/integration/ai/error-paths.test.ts                   # Task 13

lib/search/schema.ts                                       # modified Task 14
lib/search/document.ts                                     # modified Task 14
worker/jobs/search-index.ts                                # modified Task 14
tests/integration/checklist-index.test.ts                  # Task 14

lib/checklists/schema.ts                                   # Task 15
lib/checklists/schema.test.ts                              # Task 15
lib/checklists/queries.ts                                  # Task 15
lib/checklists/actions.ts                                  # Task 15
tests/integration/checklists.test.ts                       # Task 15

app/(app)/checklists/page.tsx                              # Task 16
app/(app)/checklists/[id]/page.tsx                         # Task 17
components/checklists/ChecklistEditor.tsx                  # Task 17

app/(app)/_components/SuggestionPreview.tsx                # Task 18
components/ai/SuggestionRow.tsx                            # Task 18

components/ai/GenerateRemindersButton.tsx                  # Task 19
app/(app)/dashboard/SeasonalChecklistCard.tsx              # Task 20
app/(app)/items/[id]/suggest-after-create/page.tsx         # Task 21
components/ai/SuggestChecklistItemsButton.tsx              # Task 22
app/(app)/suggest/page.tsx                                 # Task 23

components/items/IncludeInSuggestionsToggle.tsx            # Task 24
app/(app)/admin/ai/page.tsx                                # Task 25

tests/smoke/ai-suggest.smoke.test.ts                       # Task 26
.github/workflows/nightly-smoke.yml                        # Task 26

tests/e2e/suggest-from-item.spec.ts                        # Task 27
tests/e2e/suggest-seasonal.spec.ts                         # Task 27
tests/e2e/suggest-after-create.spec.ts                     # Task 27
```

---

## Task 1: Schema migration

**Files:**
- Modify: `prisma/schema.prisma`
- Generated: `prisma/migrations/<timestamp>_plan_4b_suggest/migration.sql`

No app code yet. The migration is additive and zero-downtime.

- [ ] **Step 1: Add `Item.includeInSuggestions`**

In `prisma/schema.prisma`, find `model Item { ... }` and add this field (alphabetical with the other booleans is fine; place near `archivedAt`):

```prisma
includeInSuggestions Boolean @default(true)
```

- [ ] **Step 2: Add Checklist + ChecklistItem models**

Add at the bottom of `schema.prisma`, after the existing models:

```prisma
model Checklist {
  id          String          @id @default(cuid())
  name        String
  description String?
  schedule    Json?
  nextDueOn   DateTime?
  active      Boolean         @default(true)
  createdAt   DateTime        @default(now())
  updatedAt   DateTime        @updatedAt
  items       ChecklistItem[]

  @@index([active])
}

model ChecklistItem {
  id          String  @id @default(cuid())
  checklistId String
  position    Int
  title       String
  itemId      String?

  checklist Checklist @relation(fields: [checklistId], references: [id], onDelete: Cascade)
  item      Item?     @relation(fields: [itemId], references: [id], onDelete: SetNull)

  @@index([checklistId, position])
  @@index([itemId])
}
```

- [ ] **Step 3: Add `Item` ↔ `ChecklistItem` back-relation**

Inside `model Item`, add:

```prisma
checklistItems ChecklistItem[]
```

(Prisma requires both sides of the relation. Without this, `prisma migrate` will refuse to generate.)

- [ ] **Step 4: Add `AISuggestionLog` model**

Append:

```prisma
model AISuggestionLog {
  id                   String   @id @default(cuid())
  userId               String
  kind                 String   // "reminders" | "checklist"
  systemPromptVersion  String
  userPrompt           String?
  inventorySnapshotIds String[]
  response             Json?
  acceptedItemIds      Json     @default("[]")
  errorReason          String?
  model                String
  inputTokens          Int?
  outputTokens         Int?
  cacheReadTokens      Int?
  cacheCreationTokens  Int?
  latencyMs            Int?
  createdAt            DateTime @default(now())

  user User @relation(fields: [userId], references: [id])

  @@index([userId, createdAt])
  @@index([createdAt])
}
```

- [ ] **Step 5: Add `User` ↔ `AISuggestionLog` back-relation**

Inside `model User`, add:

```prisma
aiSuggestionLogs AISuggestionLog[]
```

- [ ] **Step 6: Generate the migration**

```bash
pnpm db:migrate
# Prisma will prompt for a name. Enter: plan_4b_suggest
# Expected output: "Applied migration(s): <ts>_plan_4b_suggest"
```

This runs `prisma migrate dev`, which (a) creates the migration SQL file, (b) applies it to the dev DB, and (c) re-runs `prisma generate`.

- [ ] **Step 7: Verify the generated SQL**

```bash
ls prisma/migrations/ | tail -1
cat prisma/migrations/$(ls prisma/migrations/ | tail -1)/migration.sql
```

Expected SQL (modulo formatting):
- `ALTER TABLE "Item" ADD COLUMN "includeInSuggestions" BOOLEAN NOT NULL DEFAULT true;`
- `CREATE TABLE "Checklist" (...)` with `id`, `name`, `description`, `schedule jsonb`, `nextDueOn timestamp`, `active boolean default true`, `createdAt`, `updatedAt`.
- `CREATE TABLE "ChecklistItem" (...)` with `id`, `checklistId`, `position`, `title`, `itemId`. Two indexes (`(checklistId, position)`, `(itemId)`).
- `ALTER TABLE "ChecklistItem" ADD CONSTRAINT ... FOREIGN KEY ("checklistId") REFERENCES "Checklist"(id) ON DELETE CASCADE`.
- `ALTER TABLE "ChecklistItem" ADD CONSTRAINT ... FOREIGN KEY ("itemId") REFERENCES "Item"(id) ON DELETE SET NULL`.
- `CREATE TABLE "AISuggestionLog" (...)` with all spec fields, `inventorySnapshotIds TEXT[]`, `response JSONB`, `acceptedItemIds JSONB DEFAULT '[]'`. Two indexes.
- `ALTER TABLE "AISuggestionLog" ADD CONSTRAINT ... FOREIGN KEY ("userId") REFERENCES "User"(id)`.

If anything is off (e.g., `String[]` rendered as `TEXT` not `TEXT[]`), regenerate with adjustments.

- [ ] **Step 8: Verify Prisma client compiles**

```bash
pnpm typecheck
# Expected: no errors. The new types `Checklist`, `ChecklistItem`, `AISuggestionLog`
# and the new field `Item.includeInSuggestions` should now be in @prisma/client.
```

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(db): add Plan 4b schema (Checklist, ChecklistItem, AISuggestionLog, Item.includeInSuggestions)"
```

---

## Task 2: Anthropic SDK + env var + client singleton

**Files:**
- Modify: `package.json`
- Modify: `lib/env.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `Dockerfile`
- Create: `lib/ai/client.ts`

- [ ] **Step 1: Verify dep currency**

```bash
pnpm view @anthropic-ai/sdk@latest version
pnpm view @anthropic-ai/sdk@latest engines
```

Expected: a recent (within the last ~6 months) major. Confirm Node engine compatible with `~24.15.0`. Per `feedback_dep_currency` memory.

- [ ] **Step 2: Install the dep**

```bash
pnpm add @anthropic-ai/sdk
```

After install, edit `package.json` so the line uses `~` not `^`:

```jsonc
"@anthropic-ai/sdk": "~X.Y.Z"
```

(`pnpm add` writes `^` by default; the project convention is patch-level pinning.)

- [ ] **Step 3: Add `ANTHROPIC_API_KEY` to env schema**

In `lib/env.ts`, add to `EnvSchema` (alphabetical order is fine):

```ts
ANTHROPIC_API_KEY: z.string().min(1),
```

- [ ] **Step 4: Add CI env line**

In `.github/workflows/ci.yml`, find the e2e/test job's `env:` block (look for `MEILI_KEY` as a landmark) and add:

```yaml
ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY || 'sk-ant-test-placeholder-not-used-in-ci' }}
```

The placeholder satisfies env-validation in tests where the real SDK is mocked. The real secret is only used by the nightly smoke job (Task 26).

- [ ] **Step 5: Add Dockerfile build-step env**

In `Dockerfile`, find the build-step `ENV` block (look for `WEB_PUSH_VAPID_PUBLIC_KEY` from commit `4f8b6f0`) and add:

```dockerfile
ENV ANTHROPIC_API_KEY=placeholder-build-time
```

This satisfies `getEnv()` calls during `next build` (Next.js prerendering may eagerly evaluate env validation).

- [ ] **Step 6: Add to docker-compose.yml**

In `docker-compose.yml`, find the `web` service `environment:` block and add:

```yaml
ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
```

Same for the `worker` service if it has its own env block (the worker doesn't call Anthropic, but importing `lib/env` validates all keys regardless).

- [ ] **Step 7: Create the client singleton**

Create `lib/ai/client.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { getEnv } from '@/lib/env';

let _client: Anthropic | undefined;

export function getAnthropic(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      apiKey: getEnv().ANTHROPIC_API_KEY,
      // Default timeout 30s — the spec's error matrix expects this.
      timeout: 30_000,
      maxRetries: 1, // SDK retries once; we add one outer retry in actions.ts.
    });
  }
  return _client;
}

export const ANTHROPIC_MODEL = 'claude-haiku-4-5' as const;
export const ANTHROPIC_MAX_TOKENS = 2048;
```

- [ ] **Step 8: Verify**

```bash
pnpm typecheck
# Expected: no errors. ANTHROPIC_API_KEY now validated at module load,
# Anthropic class imports cleanly.
```

Add `ANTHROPIC_API_KEY=sk-ant-dev-placeholder` to your local `.env` file if it isn't there (the validator will fail otherwise).

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml lib/env.ts lib/ai/client.ts \
        .github/workflows/ci.yml Dockerfile docker-compose.yml
git commit -m "feat(ai): add @anthropic-ai/sdk + ANTHROPIC_API_KEY env + client singleton"
```

---

## Task 3: Zod schemas for AI input/output

**Files:**
- Create: `lib/ai/schemas.ts`
- Create: `lib/ai/schemas.test.ts`

These schemas are the single source of truth — same Zod shapes used by `messages.parse()`, by RHF preview-form validation, and by DB insert validation.

- [ ] **Step 1: Write failing tests**

Create `lib/ai/schemas.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  proposedReminderSchema,
  proposeRemindersResponseSchema,
  proposedChecklistItemSchema,
  proposeChecklistResponseSchema,
  recurrenceSchema,
} from './schemas';

describe('recurrenceSchema', () => {
  it.each([
    { kind: 'interval', days: 30 },
    { kind: 'monthly', dayOfMonth: 15 },
    { kind: 'yearly', month: 4, day: 15 },
  ])('accepts %o', (input) => {
    expect(recurrenceSchema.parse(input)).toEqual(input);
  });

  it('rejects unknown kind', () => {
    expect(() => recurrenceSchema.parse({ kind: 'rrule', rrule: 'FREQ=DAILY' })).toThrow();
  });

  it('rejects out-of-range monthly day', () => {
    expect(() => recurrenceSchema.parse({ kind: 'monthly', dayOfMonth: 32 })).toThrow();
  });

  it('rejects negative interval', () => {
    expect(() => recurrenceSchema.parse({ kind: 'interval', days: 0 })).toThrow();
  });
});

describe('proposedReminderSchema', () => {
  it('accepts a valid reminder', () => {
    const r = proposedReminderSchema.parse({
      title: 'Replace HEPA filter',
      description: 'Manufacturer recommends every 90 days.',
      recurrence: { kind: 'interval', days: 90 },
      leadTimeDays: 7,
      rationale: 'Carrier 58STA spec sheet.',
    });
    expect(r.title).toBe('Replace HEPA filter');
    expect(r.leadTimeDays).toBe(7);
  });

  it('defaults leadTimeDays to 3', () => {
    const r = proposedReminderSchema.parse({
      title: 'Replace HEPA filter',
      recurrence: { kind: 'interval', days: 90 },
      rationale: 'spec',
    });
    expect(r.leadTimeDays).toBe(3);
  });

  it('rejects title under 3 chars', () => {
    expect(() =>
      proposedReminderSchema.parse({
        title: 'no',
        recurrence: { kind: 'interval', days: 90 },
        rationale: 'r',
      }),
    ).toThrow();
  });

  it('rejects rationale over 200 chars', () => {
    expect(() =>
      proposedReminderSchema.parse({
        title: 'OK',
        recurrence: { kind: 'interval', days: 90 },
        rationale: 'x'.repeat(201),
      }),
    ).toThrow();
  });

  it('forbids itemId — that is set server-side', () => {
    const r = proposedReminderSchema.parse({
      title: 'OK',
      recurrence: { kind: 'interval', days: 90 },
      rationale: 'r',
      // @ts-expect-error itemId not in schema
      itemId: 'cuid-leak',
    });
    expect((r as Record<string, unknown>).itemId).toBeUndefined();
  });
});

describe('proposeRemindersResponseSchema', () => {
  it('accepts up to 10 proposals', () => {
    const proposals = Array.from({ length: 10 }, (_, i) => ({
      title: `Reminder ${i}`,
      recurrence: { kind: 'interval' as const, days: 30 },
      rationale: 'r',
    }));
    expect(proposeRemindersResponseSchema.parse({ proposals })).toBeTruthy();
  });

  it('rejects 11+ proposals', () => {
    const proposals = Array.from({ length: 11 }, (_, i) => ({
      title: `Reminder ${i}`,
      recurrence: { kind: 'interval' as const, days: 30 },
      rationale: 'r',
    }));
    expect(() => proposeRemindersResponseSchema.parse({ proposals })).toThrow();
  });

  it('accepts empty proposals (no-suggestion case)', () => {
    expect(proposeRemindersResponseSchema.parse({ proposals: [] }).proposals).toHaveLength(0);
  });
});

describe('proposedChecklistItemSchema', () => {
  it('accepts itemId or null', () => {
    expect(
      proposedChecklistItemSchema.parse({ title: 'Test sump pump', itemId: null, rationale: 'r' }),
    ).toBeTruthy();
    expect(
      proposedChecklistItemSchema.parse({
        title: 'Test sump pump',
        itemId: 'cuid-abc',
        rationale: 'r',
      }),
    ).toBeTruthy();
  });
});

describe('proposeChecklistResponseSchema', () => {
  it('requires at least one item', () => {
    expect(() =>
      proposeChecklistResponseSchema.parse({ name: 'Spring', items: [] }),
    ).toThrow();
  });

  it('caps items at 20', () => {
    const items = Array.from({ length: 21 }, (_, i) => ({
      title: `Item ${i}`,
      itemId: null,
      rationale: 'r',
    }));
    expect(() => proposeChecklistResponseSchema.parse({ name: 'Spring', items })).toThrow();
  });
});
```

- [ ] **Step 2: Run — should fail with module not found**

```bash
pnpm test:unit lib/ai/schemas.test.ts
# Expected: FAIL with "Cannot find module './schemas'"
```

- [ ] **Step 3: Implement schemas**

Create `lib/ai/schemas.ts`:

```ts
import { z } from 'zod';

export const recurrenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interval'), days: z.number().int().min(1).max(3650) }),
  z.object({ kind: z.literal('monthly'), dayOfMonth: z.number().int().min(1).max(31) }),
  z.object({
    kind: z.literal('yearly'),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
  }),
]);
export type ProposedRecurrence = z.infer<typeof recurrenceSchema>;

export const proposedReminderSchema = z.object({
  title: z.string().min(3).max(120),
  description: z.string().max(500).optional(),
  recurrence: recurrenceSchema,
  leadTimeDays: z.number().int().min(0).max(60).default(3),
  rationale: z
    .string()
    .max(200)
    .describe('One sentence explaining why this reminder is suggested'),
}).strict();
export type ProposedReminder = z.infer<typeof proposedReminderSchema>;

export const proposeRemindersResponseSchema = z.object({
  proposals: z.array(proposedReminderSchema).max(10),
});
export type ProposeRemindersResponse = z.infer<typeof proposeRemindersResponseSchema>;

export const proposedChecklistItemSchema = z.object({
  title: z.string().min(3).max(120),
  itemId: z.string().nullable().describe('ID of household item this row is about, or null'),
  rationale: z.string().max(200),
}).strict();
export type ProposedChecklistItem = z.infer<typeof proposedChecklistItemSchema>;

export const proposeChecklistResponseSchema = z.object({
  name: z.string().min(3).max(80),
  description: z.string().max(500).optional(),
  items: z.array(proposedChecklistItemSchema).min(1).max(20),
});
export type ProposeChecklistResponse = z.infer<typeof proposeChecklistResponseSchema>;
```

`.strict()` on `proposedReminderSchema` and `proposedChecklistItemSchema` is important — it strips unknown keys, including any `itemId` the model might invent for reminders (covered by the failing test above).

- [ ] **Step 4: Run — should pass**

```bash
pnpm test:unit lib/ai/schemas.test.ts
# Expected: all tests pass.
```

- [ ] **Step 5: Commit**

```bash
git add lib/ai/schemas.ts lib/ai/schemas.test.ts
git commit -m "feat(ai): add Zod schemas for proposed reminders and checklists"
```

---

## Task 4: Prompts (system text, version, block builders)

**Files:**
- Create: `lib/ai/prompts.ts`
- Create: `lib/ai/prompts.test.ts`

This task verifies the SDK call shape against current Anthropic docs (per the spec's open question) before encoding the system prompt.

- [ ] **Step 1: Verify SDK shape via context7**

Use the `mcp__plugin_context7_context7__query-docs` MCP tool with library id `/anthropics/anthropic-sdk-typescript` and query "Does messages.parse with output_config zodOutputFormat support claude-haiku-4-5? Latest API. What is the cache_control system block syntax?" — this confirms (a) `output_config` is GA on Haiku, (b) the system-block array syntax with `cache_control: { type: 'ephemeral' }` is current. If `output_config` isn't supported on Haiku 4.5, document that finding and switch to the `betaZodTool` fallback path noted in the spec — same Zod schemas, different call site.

Record the SDK version-vs-feature confirmation in a short comment block at the top of `lib/ai/client.ts`.

- [ ] **Step 2: Write failing tests**

Create `lib/ai/prompts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_VERSION,
  buildHouseProfileBlock,
  buildInventoryBlock,
  buildSystemBlocks,
  formatInventoryLine,
  seasonForDate,
} from './prompts';

describe('SYSTEM_PROMPT_VERSION', () => {
  it('is a non-empty string', () => {
    expect(SYSTEM_PROMPT_VERSION).toMatch(/^v\d+/);
  });
});

describe('SYSTEM_PROMPT', () => {
  it('mentions privacy rule about not inventing items', () => {
    expect(SYSTEM_PROMPT).toMatch(/do not invent items/i);
  });

  it('mentions rationale requirement', () => {
    expect(SYSTEM_PROMPT).toMatch(/rationale/i);
  });
});

describe('seasonForDate', () => {
  it.each([
    ['2026-03-15', 'spring'],
    ['2026-06-21', 'summer'],
    ['2026-09-30', 'fall'],
    ['2026-12-15', 'winter'],
    ['2026-01-05', 'winter'],
  ] as const)('%s → %s', (date, expected) => {
    expect(seasonForDate(new Date(date))).toBe(expected);
  });
});

describe('buildHouseProfileBlock', () => {
  it('includes location, climate zone, property type, today, season', () => {
    const block = buildHouseProfileBlock({
      profile: { location: 'Austin, TX', climateZone: '2A', propertyType: 'Single-family' },
      today: new Date('2026-04-15'),
    });
    expect(block).toContain('Austin, TX');
    expect(block).toContain('2A');
    expect(block).toContain('Single-family');
    expect(block).toContain('2026-04-15');
    expect(block).toContain('spring');
  });

  it('handles missing house profile gracefully', () => {
    const block = buildHouseProfileBlock({ profile: null, today: new Date('2026-04-15') });
    expect(block).toContain('not configured');
    expect(block).toContain('2026-04-15');
  });
});

describe('formatInventoryLine', () => {
  it('produces pipe-delimited line with id, name, category, location, manufacturer+model', () => {
    const line = formatInventoryLine({
      id: 'cuid1',
      name: 'Carrier Furnace',
      categoryName: 'HVAC',
      location: 'Basement',
      manufacturer: 'Carrier',
      model: '58STA',
    });
    expect(line).toBe('- id=cuid1 | "Carrier Furnace" | HVAC | Basement | Carrier 58STA');
  });

  it('handles null fields with em-dashes', () => {
    const line = formatInventoryLine({
      id: 'cuid2',
      name: 'Mystery Tool',
      categoryName: 'Tool',
      location: null,
      manufacturer: null,
      model: null,
    });
    expect(line).toBe('- id=cuid2 | "Mystery Tool" | Tool | — | —');
  });
});

describe('buildInventoryBlock', () => {
  it('includes count and one line per item', () => {
    const block = buildInventoryBlock([
      {
        id: 'a',
        name: 'A',
        categoryName: 'X',
        location: 'L',
        manufacturer: 'M',
        model: 'N',
      },
      {
        id: 'b',
        name: 'B',
        categoryName: 'Y',
        location: null,
        manufacturer: null,
        model: null,
      },
    ]);
    expect(block).toMatch(/Inventory \(2 items\)/);
    expect(block).toContain('- id=a |');
    expect(block).toContain('- id=b |');
  });

  it('says "no items" when empty', () => {
    const block = buildInventoryBlock([]);
    expect(block).toMatch(/no items/i);
  });
});

describe('buildSystemBlocks', () => {
  it('returns 3 blocks; cache_control on the last one only', () => {
    const blocks = buildSystemBlocks({
      profile: { location: 'A', climateZone: 'B', propertyType: 'C' },
      today: new Date('2026-04-15'),
      inventory: [],
    });
    expect(blocks).toHaveLength(3);
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].cache_control).toBeUndefined();
    expect(blocks[2].cache_control).toEqual({ type: 'ephemeral' });
  });
});
```

- [ ] **Step 3: Run — should fail**

```bash
pnpm test:unit lib/ai/prompts.test.ts
# Expected: FAIL with module-not-found.
```

- [ ] **Step 4: Implement prompts**

Create `lib/ai/prompts.ts`:

```ts
export const SYSTEM_PROMPT_VERSION = 'v1';

export const SYSTEM_PROMPT = `You are a household maintenance assistant.
Suggest evidence-based maintenance tasks. Be specific about what the user owns.
Always include a one-sentence rationale.

Privacy rules:
- Do not invent items not in the inventory.
- When suggesting reminders for a specific item, ground the rationale in that item's manufacturer/model when known.

Schema version: ${SYSTEM_PROMPT_VERSION}.`;

export type Season = 'spring' | 'summer' | 'fall' | 'winter';

export function seasonForDate(d: Date): Season {
  const m = d.getUTCMonth(); // 0 = Jan
  if (m >= 2 && m <= 4) return 'spring';   // Mar, Apr, May
  if (m >= 5 && m <= 7) return 'summer';   // Jun, Jul, Aug
  if (m >= 8 && m <= 10) return 'fall';    // Sep, Oct, Nov
  return 'winter';                          // Dec, Jan, Feb
}

export type HouseProfileForPrompt = {
  location: string;
  climateZone: string;
  propertyType: string;
} | null;

export function buildHouseProfileBlock(input: {
  profile: HouseProfileForPrompt;
  today: Date;
}): string {
  const dateStr = input.today.toISOString().slice(0, 10);
  const season = seasonForDate(input.today);
  if (!input.profile) {
    return `House profile: not configured.\nToday: ${dateStr}\nSeason: ${season}`;
  }
  return [
    'House profile',
    `  Location: ${input.profile.location}`,
    `  Climate zone: ${input.profile.climateZone}`,
    `  Property type: ${input.profile.propertyType}`,
    `Today: ${dateStr}`,
    `Season: ${season}`,
  ].join('\n');
}

export type InventoryEntry = {
  id: string;
  name: string;
  categoryName: string;
  location: string | null;
  manufacturer: string | null;
  model: string | null;
};

export function formatInventoryLine(e: InventoryEntry): string {
  const mm = [e.manufacturer, e.model].filter(Boolean).join(' ') || '—';
  return `- id=${e.id} | "${e.name}" | ${e.categoryName} | ${e.location ?? '—'} | ${mm}`;
}

export function buildInventoryBlock(entries: InventoryEntry[]): string {
  if (entries.length === 0) {
    return 'Inventory: no items match the suggestion filter.';
  }
  return [`Inventory (${entries.length} items)`, ...entries.map(formatInventoryLine)].join('\n');
}

export type SystemBlock = {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
};

export function buildSystemBlocks(input: {
  profile: HouseProfileForPrompt;
  today: Date;
  inventory: InventoryEntry[];
}): SystemBlock[] {
  return [
    { type: 'text', text: SYSTEM_PROMPT },
    { type: 'text', text: buildHouseProfileBlock({ profile: input.profile, today: input.today }) },
    {
      type: 'text',
      text: buildInventoryBlock(input.inventory),
      cache_control: { type: 'ephemeral' },
    },
  ];
}
```

- [ ] **Step 5: Run — should pass**

```bash
pnpm test:unit lib/ai/prompts.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add lib/ai/prompts.ts lib/ai/prompts.test.ts lib/ai/client.ts
git commit -m "feat(ai): system prompt + block builders + cache_control marker"
```

---

## Task 5: Context builder (Prisma → InventoryEntry[])

**Files:**
- Create: `lib/ai/context-builder.ts`
- Create: `tests/integration/ai/context-builder.test.ts`

The context builder is the only AI-layer module that touches Prisma. Pure logic stays in `prompts.ts`; this module just queries.

- [ ] **Step 1: Write the integration test (use dynamic-import-in-beforeAll)**

Create `tests/integration/ai/context-builder.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupIntegration, type IntegrationContext } from '../helpers';

describe('buildSuggestContext', () => {
  let ctx: IntegrationContext;
  // Imports kept dynamic to avoid the module-load DATABASE_URL trap.
  let buildSuggestContext: typeof import('@/lib/ai/context-builder').buildSuggestContext;

  beforeAll(async () => {
    ctx = await setupIntegration();
    ({ buildSuggestContext } = await import('@/lib/ai/context-builder'));
  }, 60_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  it('returns inventory filtered to non-archived, includeInSuggestions=true items', async () => {
    const cat = await ctx.prisma.category.findFirstOrThrow();
    await ctx.prisma.item.createMany({
      data: [
        { name: 'Active include', categoryId: cat.id, includeInSuggestions: true },
        { name: 'Active exclude', categoryId: cat.id, includeInSuggestions: false },
        {
          name: 'Archived include',
          categoryId: cat.id,
          includeInSuggestions: true,
          archivedAt: new Date(),
        },
      ],
    });

    const result = await buildSuggestContext({ today: new Date('2026-04-15') });

    expect(result.inventory.map((i) => i.name).sort()).toEqual(['Active include']);
    expect(result.inventorySnapshotIds).toHaveLength(1);
  });

  it('returns null profile when none exists; populated when present', async () => {
    let result = await buildSuggestContext({ today: new Date('2026-04-15') });
    expect(result.profile).toBeNull();

    await ctx.prisma.houseProfile.create({
      data: { location: 'Austin, TX', climateZone: '2A', propertyType: 'Single-family' },
    });
    result = await buildSuggestContext({ today: new Date('2026-04-15') });
    expect(result.profile).toEqual({
      location: 'Austin, TX',
      climateZone: '2A',
      propertyType: 'Single-family',
    });
  });

  it('focuses on a single item when itemId is provided', async () => {
    const cat = await ctx.prisma.category.findFirstOrThrow();
    const focused = await ctx.prisma.item.create({
      data: {
        name: 'Focused furnace',
        categoryId: cat.id,
        manufacturer: 'Carrier',
        model: '58STA',
      },
    });
    await ctx.prisma.item.create({
      data: { name: 'Other thing', categoryId: cat.id },
    });

    const result = await buildSuggestContext({
      today: new Date('2026-04-15'),
      focusedItemId: focused.id,
    });

    // Inventory still contains all visible items (the LLM gets full context),
    // but the result also exposes the focused item's full details for the user prompt.
    expect(result.focusedItem?.id).toBe(focused.id);
    expect(result.focusedItem?.manufacturer).toBe('Carrier');
    expect(result.inventory.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run — should fail**

```bash
pnpm test:integration tests/integration/ai/context-builder.test.ts
# Expected: FAIL — module not found.
```

- [ ] **Step 3: Implement context builder**

Create `lib/ai/context-builder.ts`:

```ts
import { prisma } from '@/lib/db';
import type { HouseProfileForPrompt, InventoryEntry } from './prompts';

export type FocusedItem = {
  id: string;
  name: string;
  categoryName: string;
  location: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  metadata: unknown;
};

export type SuggestContext = {
  profile: HouseProfileForPrompt;
  inventory: InventoryEntry[];
  inventorySnapshotIds: string[];
  focusedItem: FocusedItem | null;
};

export async function buildSuggestContext(input: {
  today: Date;
  focusedItemId?: string;
}): Promise<SuggestContext> {
  const [profileRow, items, focused] = await Promise.all([
    prisma.houseProfile.findFirst(),
    prisma.item.findMany({
      where: { archivedAt: null, includeInSuggestions: true },
      select: {
        id: true,
        name: true,
        location: true,
        manufacturer: true,
        model: true,
        category: { select: { name: true } },
      },
      orderBy: { name: 'asc' },
    }),
    input.focusedItemId
      ? prisma.item.findUnique({
          where: { id: input.focusedItemId },
          select: {
            id: true,
            name: true,
            location: true,
            manufacturer: true,
            model: true,
            serialNumber: true,
            metadata: true,
            category: { select: { name: true } },
          },
        })
      : null,
  ]);

  const profile: HouseProfileForPrompt = profileRow
    ? {
        location: profileRow.location,
        climateZone: profileRow.climateZone,
        propertyType: profileRow.propertyType,
      }
    : null;

  const inventory: InventoryEntry[] = items.map((i) => ({
    id: i.id,
    name: i.name,
    categoryName: i.category?.name ?? 'Uncategorized',
    location: i.location,
    manufacturer: i.manufacturer,
    model: i.model,
  }));

  const focusedItem: FocusedItem | null = focused
    ? {
        id: focused.id,
        name: focused.name,
        categoryName: focused.category?.name ?? 'Uncategorized',
        location: focused.location,
        manufacturer: focused.manufacturer,
        model: focused.model,
        serialNumber: focused.serialNumber,
        metadata: focused.metadata,
      }
    : null;

  return {
    profile,
    inventory,
    inventorySnapshotIds: inventory.map((i) => i.id),
    focusedItem,
  };
}
```

- [ ] **Step 4: Run — should pass**

```bash
pnpm test:integration tests/integration/ai/context-builder.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add lib/ai/context-builder.ts tests/integration/ai/context-builder.test.ts
git commit -m "feat(ai): context builder filters by includeInSuggestions+archivedAt"
```

---

## Task 6: AISuggestionLog writer

**Files:**
- Create: `lib/ai/log.ts`
- Create: `tests/integration/ai/log.test.ts`

Two-write pattern: `createSuggestionLog()` on response, `markAccepted()` on save. Failures also produce a row (with `errorReason`).

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/ai/log.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupIntegration, type IntegrationContext } from '../helpers';

describe('AISuggestionLog writer', () => {
  let ctx: IntegrationContext;
  let logModule: typeof import('@/lib/ai/log');

  beforeAll(async () => {
    ctx = await setupIntegration();
    logModule = await import('@/lib/ai/log');
  }, 60_000);

  afterAll(async () => {
    await ctx.teardown();
  });

  it('createSuggestionLog persists a row with full telemetry', async () => {
    const user = await ctx.prisma.user.create({ data: { email: 'a@x', name: 'A' } });
    const row = await logModule.createSuggestionLog({
      userId: user.id,
      kind: 'reminders',
      userPrompt: 'free form',
      inventorySnapshotIds: ['cuid-a', 'cuid-b'],
      response: { proposals: [{ title: 'X' }] },
      model: 'claude-haiku-4-5',
      inputTokens: 5000,
      outputTokens: 200,
      cacheReadTokens: 4500,
      cacheCreationTokens: 0,
      latencyMs: 1234,
    });
    const persisted = await ctx.prisma.aISuggestionLog.findUniqueOrThrow({ where: { id: row.id } });
    expect(persisted.userId).toBe(user.id);
    expect(persisted.systemPromptVersion).toBe('v1');
    expect(persisted.inventorySnapshotIds).toEqual(['cuid-a', 'cuid-b']);
    expect(persisted.cacheReadTokens).toBe(4500);
    expect(persisted.acceptedItemIds).toEqual([]);
    expect(persisted.errorReason).toBeNull();
  });

  it('createSuggestionLog with errorReason sets response null', async () => {
    const user = await ctx.prisma.user.create({ data: { email: 'b@x', name: 'B' } });
    const row = await logModule.createSuggestionLog({
      userId: user.id,
      kind: 'checklist',
      userPrompt: null,
      inventorySnapshotIds: [],
      response: null,
      errorReason: 'upstream_5xx',
      model: 'claude-haiku-4-5',
    });
    expect(row.response).toBeNull();
    expect(row.errorReason).toBe('upstream_5xx');
  });

  it('markAccepted appends ids to the JSON array on the existing row', async () => {
    const user = await ctx.prisma.user.create({ data: { email: 'c@x', name: 'C' } });
    const row = await logModule.createSuggestionLog({
      userId: user.id,
      kind: 'reminders',
      userPrompt: null,
      inventorySnapshotIds: [],
      response: { proposals: [] },
      model: 'claude-haiku-4-5',
    });
    await logModule.markAccepted(row.id, ['rem-1', 'rem-2']);
    await logModule.markAccepted(row.id, ['rem-3']);
    const after = await ctx.prisma.aISuggestionLog.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.acceptedItemIds).toEqual(['rem-1', 'rem-2', 'rem-3']);
  });
});
```

- [ ] **Step 2: Run — should fail**

```bash
pnpm test:integration tests/integration/ai/log.test.ts
```

- [ ] **Step 3: Implement log writer**

Create `lib/ai/log.ts`:

```ts
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { SYSTEM_PROMPT_VERSION } from './prompts';

export type CreateLogInput = {
  userId: string;
  kind: 'reminders' | 'checklist';
  userPrompt: string | null;
  inventorySnapshotIds: string[];
  response: Prisma.InputJsonValue | null;
  errorReason?: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  latencyMs?: number;
};

export async function createSuggestionLog(input: CreateLogInput) {
  return prisma.aISuggestionLog.create({
    data: {
      userId: input.userId,
      kind: input.kind,
      systemPromptVersion: SYSTEM_PROMPT_VERSION,
      userPrompt: input.userPrompt,
      inventorySnapshotIds: input.inventorySnapshotIds,
      response: input.response ?? Prisma.DbNull,
      errorReason: input.errorReason,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheCreationTokens: input.cacheCreationTokens,
      latencyMs: input.latencyMs,
    },
  });
}

/**
 * Append `ids` to the existing acceptedItemIds JSON array for `logId`.
 * Uses a Prisma raw query because Prisma doesn't expose JSONB array_append.
 */
export async function markAccepted(logId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.$executeRaw`
    UPDATE "AISuggestionLog"
    SET "acceptedItemIds" =
      COALESCE("acceptedItemIds", '[]'::jsonb) || ${JSON.stringify(ids)}::jsonb
    WHERE id = ${logId}
  `;
}
```

Note: `Prisma` is imported as a **value** (not `import type`) because `Prisma.DbNull` is a runtime sentinel — `import type` would compile-error at the use site. `Prisma.DbNull` is the explicit "store JSON null" marker, distinct from "field absent" — required by Prisma 7.

- [ ] **Step 4: Run — should pass**

```bash
pnpm test:integration tests/integration/ai/log.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add lib/ai/log.ts tests/integration/ai/log.test.ts
git commit -m "feat(ai): AISuggestionLog writer with two-write accept tracking"
```

---

## Task 7: Per-user rate limit (10/hr)

**Files:**
- Create: `lib/ai/rate-limit.ts`
- Create: `tests/integration/ai/rate-limit.test.ts`

Reuses `AISuggestionLog` itself as the counter — no new table.

- [ ] **Step 1: Write failing test**

```ts
// tests/integration/ai/rate-limit.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupIntegration, type IntegrationContext } from '../helpers';

describe('checkRateLimit', () => {
  let ctx: IntegrationContext;
  let userId: string;
  let mod: typeof import('@/lib/ai/rate-limit');

  beforeAll(async () => {
    ctx = await setupIntegration();
    mod = await import('@/lib/ai/rate-limit');
  }, 60_000);
  afterAll(async () => ctx.teardown());

  beforeEach(async () => {
    await ctx.prisma.aISuggestionLog.deleteMany({});
    const user = await ctx.prisma.user.upsert({
      where: { email: 'rl@x' },
      create: { email: 'rl@x', name: 'RL' },
      update: {},
    });
    userId = user.id;
  });

  async function seedLogs(count: number, ageMinutes = 0) {
    const now = new Date();
    for (let i = 0; i < count; i++) {
      await ctx.prisma.aISuggestionLog.create({
        data: {
          userId,
          kind: 'reminders',
          systemPromptVersion: 'v1',
          model: 'm',
          createdAt: new Date(now.getTime() - ageMinutes * 60_000),
          inventorySnapshotIds: [],
        },
      });
    }
  }

  it('allows when under limit', async () => {
    await seedLogs(9);
    const r = await mod.checkRateLimit(userId);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(1);
  });

  it('blocks at the 11th call', async () => {
    await seedLogs(10);
    const r = await mod.checkRateLimit(userId);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it('does not count rows older than 1 hour', async () => {
    await seedLogs(15, 75); // 75 minutes ago
    const r = await mod.checkRateLimit(userId);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(10);
  });
});
```

- [ ] **Step 2: Run — should fail**

```bash
pnpm test:integration tests/integration/ai/rate-limit.test.ts
```

- [ ] **Step 3: Implement**

Create `lib/ai/rate-limit.ts`:

```ts
import { prisma } from '@/lib/db';

export const RATE_LIMIT_PER_HOUR = 10;

export type RateLimitCheck = {
  allowed: boolean;
  used: number;
  remaining: number;
  windowResetsAt: Date;
};

export async function checkRateLimit(userId: string): Promise<RateLimitCheck> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const used = await prisma.aISuggestionLog.count({
    where: { userId, createdAt: { gte: since } },
  });
  const remaining = Math.max(0, RATE_LIMIT_PER_HOUR - used);
  return {
    allowed: used < RATE_LIMIT_PER_HOUR,
    used,
    remaining,
    windowResetsAt: new Date(since.getTime() + 60 * 60 * 1000),
  };
}
```

- [ ] **Step 4: Run — should pass**

```bash
pnpm test:integration tests/integration/ai/rate-limit.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add lib/ai/rate-limit.ts tests/integration/ai/rate-limit.test.ts
git commit -m "feat(ai): per-user rate limit (10/hr) reusing AISuggestionLog as counter"
```

---

## Task 8: Anthropic mock harness + first fixtures

**Files:**
- Create: `tests/setup/anthropic-mock.ts`
- Create: `tests/fixtures/suggest/reminders-furnace.json`
- Create: `tests/fixtures/suggest/reminders-empty.json`
- Create: `tests/fixtures/suggest/checklist-spring.json`

The mock replaces `@anthropic-ai/sdk` for unit and integration tests. Default behavior **throws** to prevent silent test passes when an action accidentally calls the real API.

- [ ] **Step 1: Create the fixture files**

`tests/fixtures/suggest/reminders-furnace.json`:

```json
{
  "id": "msg_test_furnace",
  "type": "message",
  "role": "assistant",
  "model": "claude-haiku-4-5",
  "content": [],
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 5800,
    "output_tokens": 320,
    "cache_creation_input_tokens": 5200,
    "cache_read_input_tokens": 0
  },
  "parsed_output": {
    "proposals": [
      {
        "title": "Replace furnace air filter",
        "description": "Replace the 1\" furnace filter every 90 days.",
        "recurrence": { "kind": "interval", "days": 90 },
        "leadTimeDays": 7,
        "rationale": "Carrier 58STA documentation recommends 90-day filter intervals."
      },
      {
        "title": "Annual furnace inspection",
        "recurrence": { "kind": "yearly", "month": 10, "day": 15 },
        "leadTimeDays": 14,
        "rationale": "Pre-heating-season combustion check is industry standard."
      }
    ]
  }
}
```

`tests/fixtures/suggest/reminders-empty.json`:

```json
{
  "id": "msg_test_empty",
  "type": "message",
  "role": "assistant",
  "model": "claude-haiku-4-5",
  "content": [],
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 5500,
    "output_tokens": 30,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 5200
  },
  "parsed_output": { "proposals": [] }
}
```

`tests/fixtures/suggest/checklist-spring.json`:

```json
{
  "id": "msg_test_spring",
  "type": "message",
  "role": "assistant",
  "model": "claude-haiku-4-5",
  "content": [],
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 5900,
    "output_tokens": 600,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 5200
  },
  "parsed_output": {
    "name": "Spring 2026 Maintenance",
    "description": "Pre-warm-season tasks for HVAC, exterior, and tools.",
    "items": [
      { "title": "Clean condenser coils", "itemId": null, "rationale": "Spring HVAC startup." },
      { "title": "Sharpen mower blades", "itemId": null, "rationale": "Pre-mowing-season." },
      { "title": "Inspect roof for winter damage", "itemId": null, "rationale": "Annual exterior check." }
    ]
  }
}
```

- [ ] **Step 2: Create the mock harness**

`tests/setup/anthropic-mock.ts`:

```ts
import { vi } from 'vitest';

type ParsedResponse = {
  parsed_output: unknown;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

let nextResponse: ParsedResponse | Error | null = null;
let lastCall: { args: unknown[] } | null = null;

export function mockMessagesParse(response: ParsedResponse): void {
  nextResponse = response;
}

export function mockMessagesParseError(err: Error): void {
  nextResponse = err;
}

export function getLastParseCall(): { args: unknown[] } | null {
  return lastCall;
}

export function resetAnthropicMock(): void {
  nextResponse = null;
  lastCall = null;
}

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = {
      parse: vi.fn(async (...args: unknown[]) => {
        lastCall = { args };
        if (nextResponse === null) {
          throw new Error(
            'Anthropic mock: no response queued. Call mockMessagesParse(fixture) first.',
          );
        }
        const r = nextResponse;
        nextResponse = null; // single-shot
        if (r instanceof Error) throw r;
        return r;
      }),
    };
  }
  return { default: MockAnthropic };
});
```

- [ ] **Step 3: Wire into vitest config**

In `vitest.config.ts`, find the `setupFiles` array (or `test.setupFiles`) and add `'tests/setup/anthropic-mock.ts'`. If a file like that already aggregates setups, add the import there. Verify by checking the config:

```bash
grep -n "setupFiles" vitest.config.ts
```

(If `vitest.config.ts` has no `setupFiles` yet, add `setupFiles: ['tests/setup/anthropic-mock.ts']` inside the `test:` block.)

- [ ] **Step 4: Smoke-test the harness with a tiny test**

Create a temporary `tests/setup/anthropic-mock.test.ts` (delete after passing — this is just a harness sanity check):

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import {
  getLastParseCall,
  mockMessagesParse,
  mockMessagesParseError,
  resetAnthropicMock,
} from './anthropic-mock';
import fixture from '../fixtures/suggest/reminders-furnace.json';

describe('anthropic mock', () => {
  beforeEach(resetAnthropicMock);

  it('returns the queued fixture', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: 'test' });
    mockMessagesParse(fixture as never);
    const result = await client.messages.parse({} as never);
    expect((result as { parsed_output: { proposals: unknown[] } }).parsed_output.proposals).toHaveLength(2);
    expect(getLastParseCall()?.args).toBeTruthy();
  });

  it('throws when no fixture is queued', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: 'test' });
    await expect(client.messages.parse({} as never)).rejects.toThrow(/no response queued/);
  });

  it('queues an error', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: 'test' });
    mockMessagesParseError(new Error('upstream 500'));
    await expect(client.messages.parse({} as never)).rejects.toThrow('upstream 500');
  });
});
```

- [ ] **Step 5: Run + delete the smoke test**

```bash
pnpm test:unit tests/setup/anthropic-mock.test.ts
# Expected: pass.
rm tests/setup/anthropic-mock.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add tests/setup/anthropic-mock.ts tests/fixtures/suggest \
        vitest.config.ts
git commit -m "test(ai): mock harness + first fixtures (reminders, empty, checklist)"
```

---

## Task 9: Server Action — proposeReminders

**Files:**
- Create: `lib/ai/suggest/actions.ts` (begin — `proposeReminders` only)
- Create: `tests/integration/ai/propose-reminders.test.ts`

This is the first AI Server Action. It establishes the pattern Tasks 10-12 follow.

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/ai/propose-reminders.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getLastParseCall,
  mockMessagesParse,
  resetAnthropicMock,
} from '@/tests/setup/anthropic-mock';
import fixture from '@/tests/fixtures/suggest/reminders-furnace.json';
import emptyFixture from '@/tests/fixtures/suggest/reminders-empty.json';
import { setupIntegration, signInAs, type IntegrationContext } from '../helpers';

describe('proposeReminders', () => {
  let ctx: IntegrationContext;
  let proposeReminders: typeof import('@/lib/ai/suggest/actions').proposeReminders;

  beforeAll(async () => {
    ctx = await setupIntegration();
    ({ proposeReminders } = await import('@/lib/ai/suggest/actions'));
  }, 60_000);
  afterAll(async () => ctx.teardown());
  beforeEach(resetAnthropicMock);

  it('returns proposals + logId on success', async () => {
    const user = await ctx.prisma.user.create({ data: { email: 'p@x', name: 'P' } });
    await signInAs(user.id);
    mockMessagesParse(fixture as never);

    const result = await proposeReminders({});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.proposals).toHaveLength(2);
    expect(result.data.logId).toBeTruthy();

    const log = await ctx.prisma.aISuggestionLog.findUniqueOrThrow({
      where: { id: result.data.logId },
    });
    expect(log.userId).toBe(user.id);
    expect(log.kind).toBe('reminders');
    expect(log.cacheCreationTokens).toBe(5200);
  });

  it('passes a cache_control marker on the inventory block', async () => {
    const user = await ctx.prisma.user.create({ data: { email: 'p2@x', name: 'P' } });
    await signInAs(user.id);
    mockMessagesParse(fixture as never);
    await proposeReminders({});
    const args = getLastParseCall()?.args[0] as { system: { cache_control?: object }[] };
    const last = args.system[args.system.length - 1];
    expect(last.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('attaches focused item details when itemId is provided', async () => {
    const user = await ctx.prisma.user.create({ data: { email: 'p3@x', name: 'P' } });
    const cat = await ctx.prisma.category.findFirstOrThrow();
    const item = await ctx.prisma.item.create({
      data: { name: 'Carrier Furnace', categoryId: cat.id, manufacturer: 'Carrier', model: '58STA' },
    });
    await signInAs(user.id);
    mockMessagesParse(fixture as never);

    await proposeReminders({ itemId: item.id });
    const args = getLastParseCall()?.args[0] as { messages: { content: string }[] };
    const userMsg = args.messages[0].content;
    expect(userMsg).toContain('Carrier Furnace');
    expect(userMsg).toContain(item.id);
  });

  it('returns empty proposals successfully (no error)', async () => {
    const user = await ctx.prisma.user.create({ data: { email: 'p4@x', name: 'P' } });
    await signInAs(user.id);
    mockMessagesParse(emptyFixture as never);
    const result = await proposeReminders({});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.data.proposals).toEqual([]);
  });

  it('rejects unauthenticated calls', async () => {
    await signInAs(null);
    const result = await proposeReminders({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.formError).toBe('Unauthorized');
  });
});
```

This requires a `signInAs(userId | null)` helper in `tests/integration/helpers.ts`. Plan 4a's tests already mock `auth()` — extend the helper if it doesn't already have this exact signature. (Look at how `tests/integration/items.test.ts` handles auth — copy that pattern.)

- [ ] **Step 2: Run — should fail**

```bash
pnpm test:integration tests/integration/ai/propose-reminders.test.ts
```

- [ ] **Step 3: Implement `proposeReminders`**

Create `lib/ai/suggest/actions.ts`:

```ts
'use server';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { auth } from '@/lib/auth';
import type { ActionResult } from '@/lib/result';
import { ANTHROPIC_MAX_TOKENS, ANTHROPIC_MODEL, getAnthropic } from '../client';
import { buildSuggestContext, type FocusedItem } from '../context-builder';
import { createSuggestionLog } from '../log';
import { buildSystemBlocks } from '../prompts';
import { checkRateLimit } from '../rate-limit';
import {
  type ProposedReminder,
  proposeRemindersResponseSchema,
} from '../schemas';

export type ProposeRemindersData = {
  logId: string;
  proposals: ProposedReminder[];
};

function buildReminderUserMessage(focused: FocusedItem | null): string {
  if (focused) {
    return `Generate up to 5 maintenance reminders for this item:
id=${focused.id}
name="${focused.name}"
category=${focused.categoryName}
manufacturer=${focused.manufacturer ?? '—'}
model=${focused.model ?? '—'}

Return reminders that are specific to this item. Use the inventory only for cross-references.`;
  }
  return `Generate up to 5 broad household maintenance reminders based on the inventory and house profile.`;
}

export async function proposeReminders(input: {
  itemId?: string;
}): Promise<ActionResult<ProposeRemindersData>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };
  const userId = session.user.id;

  const rl = await checkRateLimit(userId);
  if (!rl.allowed) {
    await createSuggestionLog({
      userId,
      kind: 'reminders',
      userPrompt: null,
      inventorySnapshotIds: [],
      response: null,
      errorReason: 'user_rate_limit',
      model: ANTHROPIC_MODEL,
    });
    return { ok: false, formError: `Hourly limit reached (${rl.used}/10).` };
  }

  const ctx = await buildSuggestContext({ today: new Date(), focusedItemId: input.itemId });

  const start = Date.now();
  let result;
  try {
    result = await getAnthropic().messages.parse({
      model: ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: buildSystemBlocks({
        profile: ctx.profile,
        today: new Date(),
        inventory: ctx.inventory,
      }),
      messages: [{ role: 'user', content: buildReminderUserMessage(ctx.focusedItem) }],
      output_config: { format: zodOutputFormat(proposeRemindersResponseSchema) },
    } as never);
  } catch (e) {
    const errorReason = classifyAnthropicError(e);
    await createSuggestionLog({
      userId,
      kind: 'reminders',
      userPrompt: null,
      inventorySnapshotIds: ctx.inventorySnapshotIds,
      response: null,
      errorReason,
      model: ANTHROPIC_MODEL,
      latencyMs: Date.now() - start,
    });
    console.log(
      JSON.stringify({ event: 'ai.suggest', kind: 'reminders', userId, ok: false, errorReason }),
    );
    return { ok: false, formError: userFacingMessage(errorReason) };
  }

  const parsed = (result as { parsed_output: { proposals: ProposedReminder[] } }).parsed_output;
  const usage = (result as { usage?: Record<string, number> }).usage ?? {};

  const log = await createSuggestionLog({
    userId,
    kind: 'reminders',
    userPrompt: null,
    inventorySnapshotIds: ctx.inventorySnapshotIds,
    response: parsed,
    model: ANTHROPIC_MODEL,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
    latencyMs: Date.now() - start,
  });

  // Structured log line at the action boundary (per spec observability section).
  // TODO(plan-5): replace with project logger once one exists.
  console.log(
    JSON.stringify({
      event: 'ai.suggest',
      kind: 'reminders',
      userId,
      latencyMs: Date.now() - start,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      ok: true,
    }),
  );

  return { ok: true, data: { logId: log.id, proposals: parsed.proposals } };
}

export function classifyAnthropicError(e: unknown): string {
  const msg = (e as Error)?.message ?? '';
  const status = (e as { status?: number })?.status;
  if (status === 429) return 'rate_limited';
  if (status && status >= 500 && status < 600) return 'upstream_5xx';
  if (msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('aborted')) {
    return 'timeout';
  }
  if (msg.toLowerCase().includes('zoderror') || msg.toLowerCase().includes('schema')) {
    return 'schema_violation';
  }
  return 'unknown';
}

function userFacingMessage(reason: string): string {
  switch (reason) {
    case 'rate_limited':
      return 'Service busy — try again in a minute.';
    case 'upstream_5xx':
      return "Couldn't reach AI service.";
    case 'timeout':
      return 'Took too long — try again.';
    case 'schema_violation':
      return 'Got an unexpected response — try again.';
    default:
      return 'Something went wrong generating suggestions.';
  }
}
```

- [ ] **Step 4: Run — should pass**

```bash
pnpm test:integration tests/integration/ai/propose-reminders.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add lib/ai/suggest/actions.ts tests/integration/ai/propose-reminders.test.ts \
        tests/integration/helpers.ts
git commit -m "feat(ai): proposeReminders Server Action with mocked Claude integration"
```

---

## Task 10: Server Action — proposeChecklist (3 modes)

**Files:**
- Modify: `lib/ai/suggest/actions.ts`
- Create: `tests/integration/ai/propose-checklist.test.ts`

Discriminated-union input: `seasonal | freeform | append`. Same call/log pattern as Task 9.

- [ ] **Step 1: Write failing test**

```ts
// tests/integration/ai/propose-checklist.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getLastParseCall,
  mockMessagesParse,
  resetAnthropicMock,
} from '@/tests/setup/anthropic-mock';
import fixture from '@/tests/fixtures/suggest/checklist-spring.json';
import { setupIntegration, signInAs, type IntegrationContext } from '../helpers';

describe('proposeChecklist', () => {
  let ctx: IntegrationContext;
  let proposeChecklist: typeof import('@/lib/ai/suggest/actions').proposeChecklist;

  beforeAll(async () => {
    ctx = await setupIntegration();
    ({ proposeChecklist } = await import('@/lib/ai/suggest/actions'));
  }, 60_000);
  afterAll(async () => ctx.teardown());
  beforeEach(resetAnthropicMock);

  it('seasonal mode produces a checklist', async () => {
    const u = await ctx.prisma.user.create({ data: { email: 'cs@x', name: 'C' } });
    await signInAs(u.id);
    mockMessagesParse(fixture as never);
    const r = await proposeChecklist({ mode: 'seasonal', season: 'spring' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.data.name).toBe('Spring 2026 Maintenance');
    expect(r.data.items.length).toBeGreaterThan(0);
    const args = getLastParseCall()?.args[0] as { messages: { content: string }[] };
    expect(args.messages[0].content).toContain('spring');
  });

  it('freeform mode passes the user prompt through', async () => {
    const u = await ctx.prisma.user.create({ data: { email: 'cf@x', name: 'C' } });
    await signInAs(u.id);
    mockMessagesParse(fixture as never);
    await proposeChecklist({
      mode: 'freeform',
      freeFormPrompt: 'Pre-vacation checklist',
    });
    const args = getLastParseCall()?.args[0] as { messages: { content: string }[] };
    expect(args.messages[0].content).toContain('Pre-vacation checklist');
  });

  it('append mode references the existing checklist by name', async () => {
    const u = await ctx.prisma.user.create({ data: { email: 'ca@x', name: 'C' } });
    await signInAs(u.id);
    const existing = await ctx.prisma.checklist.create({
      data: { name: 'Quarterly HVAC' },
    });
    mockMessagesParse(fixture as never);
    await proposeChecklist({ mode: 'append', forChecklistId: existing.id });
    const args = getLastParseCall()?.args[0] as { messages: { content: string }[] };
    expect(args.messages[0].content).toContain('Quarterly HVAC');
  });

  it('append mode rejects unknown checklist id', async () => {
    const u = await ctx.prisma.user.create({ data: { email: 'cau@x', name: 'C' } });
    await signInAs(u.id);
    const r = await proposeChecklist({ mode: 'append', forChecklistId: 'cuid-nope' });
    expect(r.ok).toBe(false);
  });

  it('rejects malformed input via Zod', async () => {
    const u = await ctx.prisma.user.create({ data: { email: 'ci@x', name: 'C' } });
    await signInAs(u.id);
    // @ts-expect-error testing runtime shape
    const r = await proposeChecklist({ mode: 'seasonal' }); // missing `season`
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run — should fail**

```bash
pnpm test:integration tests/integration/ai/propose-checklist.test.ts
```

- [ ] **Step 3: Implement**

Append to `lib/ai/suggest/actions.ts`:

```ts
import { z } from 'zod';
import { prisma } from '@/lib/db';
import {
  type ProposedChecklistItem,
  proposeChecklistResponseSchema,
} from '../schemas';

const proposeChecklistInputSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('seasonal'), season: z.enum(['spring', 'summer', 'fall', 'winter']) }),
  z.object({ mode: z.literal('freeform'), freeFormPrompt: z.string().min(3).max(2000) }),
  z.object({ mode: z.literal('append'), forChecklistId: z.string().min(1) }),
]);
export type ProposeChecklistInput = z.infer<typeof proposeChecklistInputSchema>;

export type ProposeChecklistData = {
  logId: string;
  name: string;
  description?: string;
  items: ProposedChecklistItem[];
};

function buildChecklistUserMessage(input: ProposeChecklistInput, appendingTo?: string): string {
  if (input.mode === 'seasonal') {
    return `Generate a ${input.season} maintenance checklist (5–15 items) tailored to the inventory and house profile. Pick a name like "${capitalize(input.season)} ${new Date().getUTCFullYear()} Maintenance".`;
  }
  if (input.mode === 'freeform') {
    return `${input.freeFormPrompt}\n\nReturn a checklist with a clear name and 1–15 items. Include rationale per item.`;
  }
  return `Suggest 3–10 additional items for the existing checklist "${appendingTo ?? input.forChecklistId}". Keep the existing name in your response — only suggest new items.`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function proposeChecklist(
  rawInput: unknown,
): Promise<ActionResult<ProposeChecklistData>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };
  const userId = session.user.id;

  const parsed = proposeChecklistInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]> };
  }
  const input = parsed.data;

  let appendingTo: { id: string; name: string } | null = null;
  if (input.mode === 'append') {
    const found = await prisma.checklist.findUnique({
      where: { id: input.forChecklistId },
      select: { id: true, name: true },
    });
    if (!found) return { ok: false, formError: 'Checklist not found.' };
    appendingTo = found;
  }

  const rl = await checkRateLimit(userId);
  if (!rl.allowed) {
    await createSuggestionLog({
      userId,
      kind: 'checklist',
      userPrompt: input.mode === 'freeform' ? input.freeFormPrompt : null,
      inventorySnapshotIds: [],
      response: null,
      errorReason: 'user_rate_limit',
      model: ANTHROPIC_MODEL,
    });
    return { ok: false, formError: `Hourly limit reached (${rl.used}/10).` };
  }

  const ctx = await buildSuggestContext({ today: new Date() });

  const start = Date.now();
  let result;
  try {
    result = await getAnthropic().messages.parse({
      model: ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: buildSystemBlocks({
        profile: ctx.profile,
        today: new Date(),
        inventory: ctx.inventory,
      }),
      messages: [
        { role: 'user', content: buildChecklistUserMessage(input, appendingTo?.name) },
      ],
      output_config: { format: zodOutputFormat(proposeChecklistResponseSchema) },
    } as never);
  } catch (e) {
    const errorReason = classifyAnthropicError(e);
    await createSuggestionLog({
      userId,
      kind: 'checklist',
      userPrompt: input.mode === 'freeform' ? input.freeFormPrompt : null,
      inventorySnapshotIds: ctx.inventorySnapshotIds,
      response: null,
      errorReason,
      model: ANTHROPIC_MODEL,
      latencyMs: Date.now() - start,
    });
    return { ok: false, formError: userFacingMessage(errorReason) };
  }

  const parsedResp = (result as { parsed_output: { name: string; description?: string; items: ProposedChecklistItem[] } }).parsed_output;
  const usage = (result as { usage?: Record<string, number> }).usage ?? {};

  const log = await createSuggestionLog({
    userId,
    kind: 'checklist',
    userPrompt: input.mode === 'freeform' ? input.freeFormPrompt : null,
    inventorySnapshotIds: ctx.inventorySnapshotIds,
    response: parsedResp,
    model: ANTHROPIC_MODEL,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
    latencyMs: Date.now() - start,
  });

  return {
    ok: true,
    data: {
      logId: log.id,
      name: parsedResp.name,
      description: parsedResp.description,
      items: parsedResp.items,
    },
  };
}
```

- [ ] **Step 4: Run — should pass**

```bash
pnpm test:integration tests/integration/ai/propose-checklist.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add lib/ai/suggest/actions.ts tests/integration/ai/propose-checklist.test.ts
git commit -m "feat(ai): proposeChecklist with seasonal|freeform|append discriminated union"
```

---

**Apply the same structured-log pattern in `proposeChecklist`** (Task 10): one success-line, one failure-line, one rate-limit-block line. Three `console.log({event:'ai.suggest', kind:'checklist', ...})` calls. Mirror the shape from Task 9.

---

## Task 11: Server Action — saveAcceptedReminders

**Files:**
- Modify: `lib/ai/suggest/actions.ts`
- Create: `tests/integration/ai/save-accepted.test.ts` (begin — reminders only)

Inserts accepted reminders in a single Prisma transaction, then updates `acceptedItemIds` on the log row.

- [ ] **Step 1: Write failing test**

```ts
// tests/integration/ai/save-accepted.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupIntegration, signInAs, type IntegrationContext } from '../helpers';

describe('saveAcceptedReminders', () => {
  let ctx: IntegrationContext;
  let saveAcceptedReminders: typeof import('@/lib/ai/suggest/actions').saveAcceptedReminders;
  let userId: string;
  let logId: string;

  beforeAll(async () => {
    ctx = await setupIntegration();
    ({ saveAcceptedReminders } = await import('@/lib/ai/suggest/actions'));
    const u = await ctx.prisma.user.create({ data: { email: 'sr@x', name: 'S' } });
    userId = u.id;
    const log = await ctx.prisma.aISuggestionLog.create({
      data: {
        userId,
        kind: 'reminders',
        systemPromptVersion: 'v1',
        model: 'm',
        inventorySnapshotIds: [],
      },
    });
    logId = log.id;
    await signInAs(userId);
  }, 60_000);
  afterAll(async () => ctx.teardown());

  it('inserts reminders + updates acceptedItemIds in one transaction', async () => {
    const result = await saveAcceptedReminders({
      logId,
      accepted: [
        {
          title: 'Replace filter',
          description: 'q90d',
          recurrence: { kind: 'interval', days: 90 },
          leadTimeDays: 7,
          rationale: 'spec',
        },
        {
          title: 'Annual inspection',
          recurrence: { kind: 'yearly', month: 10, day: 15 },
          leadTimeDays: 14,
          rationale: 'preseason',
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.data.savedIds).toHaveLength(2);

    const reminders = await ctx.prisma.reminder.findMany({
      where: { id: { in: result.data.savedIds } },
    });
    expect(reminders).toHaveLength(2);

    const log = await ctx.prisma.aISuggestionLog.findUniqueOrThrow({ where: { id: logId } });
    expect(log.acceptedItemIds).toEqual(result.data.savedIds);
  });

  it('attaches itemId when provided', async () => {
    const cat = await ctx.prisma.category.findFirstOrThrow();
    const item = await ctx.prisma.item.create({ data: { name: 'X', categoryId: cat.id } });

    const result = await saveAcceptedReminders({
      logId,
      itemId: item.id,
      accepted: [
        {
          title: 'Pinned',
          recurrence: { kind: 'interval', days: 30 },
          leadTimeDays: 3,
          rationale: 'r',
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    const r = await ctx.prisma.reminder.findUniqueOrThrow({ where: { id: result.data.savedIds[0] } });
    expect(r.itemId).toBe(item.id);
  });

  it('rejects empty accepted list', async () => {
    const result = await saveAcceptedReminders({ logId, accepted: [] });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run — should fail**

```bash
pnpm test:integration tests/integration/ai/save-accepted.test.ts
```

- [ ] **Step 3: Implement**

Append to `lib/ai/suggest/actions.ts`:

```ts
import { revalidatePath } from 'next/cache';
import { markAccepted } from '../log';

export async function saveAcceptedReminders(input: {
  logId: string;
  accepted: ProposedReminder[];
  itemId?: string;
}): Promise<ActionResult<{ savedIds: string[] }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  if (!input.accepted || input.accepted.length === 0) {
    return { ok: false, formError: 'No reminders selected.' };
  }

  // Validate every row through the schema again (defence in depth — the user
  // may have edited title/recurrence inline).
  const validated: ProposedReminder[] = [];
  for (const row of input.accepted) {
    const parsed = (await import('../schemas')).proposedReminderSchema.safeParse(row);
    if (!parsed.success) {
      return { ok: false, formError: 'Invalid reminder data.' };
    }
    validated.push(parsed.data);
  }

  // Compute nextDueOn from recurrence (anchor today).
  const today = new Date();

  const savedIds = await prisma.$transaction(async (tx) => {
    const ids: string[] = [];
    for (const r of validated) {
      const created = await tx.reminder.create({
        data: {
          title: r.title,
          description: r.description,
          itemId: input.itemId ?? null,
          recurrence: r.recurrence,
          leadTimeDays: r.leadTimeDays,
          nextDueOn: computeNextDueOn(r.recurrence, today),
          notifyUserIds: [],
          autoCreateServiceRecord: false,
          active: true,
        },
      });
      ids.push(created.id);
    }
    return ids;
  });

  await markAccepted(input.logId, savedIds);
  revalidatePath('/reminders');
  if (input.itemId) revalidatePath(`/items/${input.itemId}`);
  return { ok: true, data: { savedIds } };
}

import type { ProposedRecurrence } from '../schemas';

function computeNextDueOn(rec: ProposedRecurrence, anchor: Date): Date {
  if (rec.kind === 'interval') {
    return new Date(anchor.getTime() + rec.days * 24 * 60 * 60 * 1000);
  }
  if (rec.kind === 'monthly') {
    const next = new Date(anchor);
    next.setUTCDate(rec.dayOfMonth);
    if (next <= anchor) next.setUTCMonth(next.getUTCMonth() + 1);
    return next;
  }
  // yearly
  const year = anchor.getUTCFullYear();
  const candidate = new Date(Date.UTC(year, rec.month - 1, rec.day));
  if (candidate <= anchor) candidate.setUTCFullYear(year + 1);
  return candidate;
}
```

**Strongly prefer reuse over the inline `computeNextDueOn`**: `grep -rn "nextDueOn" lib/reminders/` first. Plan 3 almost certainly shipped a recurrence-aware due-date calculator. If found, import and delete the local function. The inline copy above is a fallback only.

Move the `import type { ProposedRecurrence }` to the top of the file with the other imports — Biome 2's `noFloatingImports` rule will fail otherwise.

- [ ] **Step 4: Run — should pass**

```bash
pnpm test:integration tests/integration/ai/save-accepted.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add lib/ai/suggest/actions.ts tests/integration/ai/save-accepted.test.ts
git commit -m "feat(ai): saveAcceptedReminders writes Reminders + updates log atomically"
```

---

## Task 12: Server Action — saveAcceptedChecklist

**Files:**
- Modify: `lib/ai/suggest/actions.ts`
- Modify: `tests/integration/ai/save-accepted.test.ts` (extend)

Two paths inside one action: create a new Checklist + items, or append items to an existing Checklist. Both update `acceptedItemIds`.

- [ ] **Step 1: Extend test file with checklist cases**

Append to `tests/integration/ai/save-accepted.test.ts`:

```ts
describe('saveAcceptedChecklist', () => {
  // ... beforeAll/afterAll/signInAs same as above; new logId for kind='checklist'

  it('creates a new checklist when appendToChecklistId is null', async () => {
    const r = await saveAcceptedChecklist({
      logId,
      name: 'Spring 2026',
      description: 'd',
      items: [
        { title: 'A', itemId: null, rationale: 'r' },
        { title: 'B', itemId: null, rationale: 'r' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    const cl = await ctx.prisma.checklist.findUniqueOrThrow({
      where: { id: r.data.checklistId },
      include: { items: true },
    });
    expect(cl.name).toBe('Spring 2026');
    expect(cl.items).toHaveLength(2);
    expect(cl.items.map((i) => i.position).sort()).toEqual([0, 1]);
  });

  it('appends to an existing checklist when appendToChecklistId is set', async () => {
    const existing = await ctx.prisma.checklist.create({
      data: { name: 'Quarterly', items: { create: [{ position: 0, title: 'Existing 1' }] } },
    });
    const r = await saveAcceptedChecklist({
      logId,
      name: 'ignored when appending',
      items: [{ title: 'New 1', itemId: null, rationale: 'r' }],
      appendToChecklistId: existing.id,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.data.checklistId).toBe(existing.id);
    const items = await ctx.prisma.checklistItem.findMany({
      where: { checklistId: existing.id },
      orderBy: { position: 'asc' },
    });
    expect(items.map((i) => i.title)).toEqual(['Existing 1', 'New 1']);
    expect(items[1].position).toBe(1);
  });

  it('updates Meilisearch index for the affected checklist', async () => {
    // verify boss.send was called with kind='checklist' once per save
    // (use a spy on enqueueSearchIndex or query the queue table)
  });
});
```

- [ ] **Step 2: Run — should fail**

```bash
pnpm test:integration tests/integration/ai/save-accepted.test.ts
```

- [ ] **Step 3: Implement**

Append to `lib/ai/suggest/actions.ts`:

```ts
import { enqueueSearchIndex } from '@/lib/search/client';

export async function saveAcceptedChecklist(input: {
  logId: string;
  name: string;
  description?: string;
  items: ProposedChecklistItem[];
  appendToChecklistId?: string;
}): Promise<ActionResult<{ checklistId: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  if (!input.items || input.items.length === 0) {
    return { ok: false, formError: 'No items selected.' };
  }
  // `name` is required for the create path, ignored for the append path.
  // Validate accordingly so an append call doesn't fail on an empty `name`.
  if (!input.appendToChecklistId && (!input.name || input.name.trim().length === 0)) {
    return { ok: false, formError: 'Checklist name is required.' };
  }

  const checklistId = await prisma.$transaction(async (tx) => {
    let target: { id: string; nextPosition: number };

    if (input.appendToChecklistId) {
      const existing = await tx.checklist.findUnique({
        where: { id: input.appendToChecklistId },
        include: { items: { orderBy: { position: 'desc' }, take: 1 } },
      });
      if (!existing) throw new Error('Checklist not found');
      target = {
        id: existing.id,
        nextPosition: (existing.items[0]?.position ?? -1) + 1,
      };
    } else {
      const created = await tx.checklist.create({
        data: { name: input.name, description: input.description },
      });
      target = { id: created.id, nextPosition: 0 };
    }

    for (let i = 0; i < input.items.length; i++) {
      const row = input.items[i];
      await tx.checklistItem.create({
        data: {
          checklistId: target.id,
          position: target.nextPosition + i,
          title: row.title,
          itemId: row.itemId,
        },
      });
    }

    return target.id;
  });

  // Search-index sync — fire-and-forget per Plan 4a pattern.
  await enqueueSearchIndex('checklist' as never, checklistId, 'upsert');

  await markAccepted(input.logId, [checklistId]);
  revalidatePath('/checklists');
  revalidatePath(`/checklists/${checklistId}`);
  return { ok: true, data: { checklistId } };
}
```

(Note: `'checklist' as never` is a stop-gap until Task 14 widens `SearchKind` to include `'checklist'`. Replace with a plain string literal once Task 14 lands.)

- [ ] **Step 4: Run — should pass**

```bash
pnpm test:integration tests/integration/ai/save-accepted.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add lib/ai/suggest/actions.ts tests/integration/ai/save-accepted.test.ts
git commit -m "feat(ai): saveAcceptedChecklist creates or appends + enqueues index sync"
```

---

## Task 13: Error path coverage

**Files:**
- Create: `tests/integration/ai/error-paths.test.ts`

Locks in the error matrix from the spec.

- [ ] **Step 1: Write tests covering each error reason**

```ts
// tests/integration/ai/error-paths.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mockMessagesParseError, resetAnthropicMock } from '@/tests/setup/anthropic-mock';
import { setupIntegration, signInAs, type IntegrationContext } from '../helpers';

describe('proposeReminders error paths', () => {
  let ctx: IntegrationContext;
  let proposeReminders: typeof import('@/lib/ai/suggest/actions').proposeReminders;
  let userId: string;

  beforeAll(async () => {
    ctx = await setupIntegration();
    ({ proposeReminders } = await import('@/lib/ai/suggest/actions'));
    const u = await ctx.prisma.user.create({ data: { email: 'err@x', name: 'E' } });
    userId = u.id;
    await signInAs(userId);
  }, 60_000);
  afterAll(async () => ctx.teardown());
  beforeEach(async () => {
    resetAnthropicMock();
    await ctx.prisma.aISuggestionLog.deleteMany({ where: { userId } });
  });

  function classifiedError(status: number, msg = 'x') {
    const e = new Error(msg) as Error & { status?: number };
    e.status = status;
    return e;
  }

  it('429 → rate_limited', async () => {
    mockMessagesParseError(classifiedError(429));
    const r = await proposeReminders({});
    expect(r.ok).toBe(false);
    const log = await ctx.prisma.aISuggestionLog.findFirstOrThrow({ where: { userId } });
    expect(log.errorReason).toBe('rate_limited');
  });

  it('503 → upstream_5xx', async () => {
    mockMessagesParseError(classifiedError(503));
    await proposeReminders({});
    const log = await ctx.prisma.aISuggestionLog.findFirstOrThrow({ where: { userId } });
    expect(log.errorReason).toBe('upstream_5xx');
  });

  it('timeout', async () => {
    mockMessagesParseError(new Error('Request timed out'));
    await proposeReminders({});
    const log = await ctx.prisma.aISuggestionLog.findFirstOrThrow({ where: { userId } });
    expect(log.errorReason).toBe('timeout');
  });

  it('schema violation', async () => {
    mockMessagesParseError(new Error('ZodError: invalid input'));
    await proposeReminders({});
    const log = await ctx.prisma.aISuggestionLog.findFirstOrThrow({ where: { userId } });
    expect(log.errorReason).toBe('schema_violation');
  });

  it('per-user rate cap blocks call entirely', async () => {
    // Seed 10 successful logs in the last hour
    for (let i = 0; i < 10; i++) {
      await ctx.prisma.aISuggestionLog.create({
        data: {
          userId,
          kind: 'reminders',
          systemPromptVersion: 'v1',
          model: 'm',
          inventorySnapshotIds: [],
        },
      });
    }
    // No mockMessagesParse — if the action calls Anthropic, it would throw.
    const r = await proposeReminders({});
    expect(r.ok).toBe(false);
    const logs = await ctx.prisma.aISuggestionLog.findMany({ where: { userId } });
    const blocked = logs.find((l) => l.errorReason === 'user_rate_limit');
    expect(blocked).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run — should pass (relies on Task 9's classifyAnthropicError)**

```bash
pnpm test:integration tests/integration/ai/error-paths.test.ts
```

If anything fails, fix `classifyAnthropicError` until all five reasons resolve correctly.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/ai/error-paths.test.ts lib/ai/suggest/actions.ts
git commit -m "test(ai): cover all five error reasons end-to-end"
```

---

## Task 14: Search index — add 'checklist' kind

**Files:**
- Modify: `lib/search/schema.ts`
- Modify: `lib/search/document.ts`
- Modify: `worker/jobs/search-index.ts`
- Create: `tests/integration/checklist-index.test.ts`

Plan 4a's index needs to learn about checklists. Single new entry in `SEARCH_KINDS`, single new case in `buildDocument`, single new dispatch case in the worker.

- [ ] **Step 1: Add 'checklist' to SEARCH_KINDS**

`lib/search/schema.ts`:

```ts
export const SEARCH_KINDS = [
  'item',
  'vendor',
  'note',
  'service',
  'reminder',
  'attachment',
  'checklist',
] as const;
```

- [ ] **Step 2: Add `ChecklistRow` and `buildDocument` case**

**Read `lib/search/document.ts` first** — the existing `RowFor<K>` conditional type, the `buildDocument` switch, and the per-kind row types are all extended in lockstep. Mirror the existing `'reminder'` case for shape and select clauses; do not improvise.

In `lib/search/document.ts`, add to the row-type union:

```ts
export type ChecklistRow = {
  id: string;
  name: string;
  description: string | null;
  items: { title: string }[];
  updatedAt: Date;
};
```

Extend the `RowFor<K>` conditional. Add to `ICON`:

```ts
checklist: '✅',
```

In the `buildDocument` switch (locate it via `grep -n "case 'reminder':" lib/search/document.ts`):

```ts
case 'checklist': {
  const r = row as ChecklistRow;
  return {
    id: `checklist-${r.id}`,
    kind: 'checklist',
    recordId: r.id,
    title: r.name,
    body: [r.description ?? '', ...r.items.map((i) => i.title)].join('\n'),
    tags: [],
    itemName: '',
    itemId: null,
    categorySlug: null,
    href: `/checklists/${r.id}`,
    iconHint: ICON.checklist,
    updatedAt: r.updatedAt.getTime(),
  };
}
```

If `lib/search/document.ts` also has a `loadRowFor<K>(id)` helper that selects from Prisma, add a checklist case using `prisma.checklist.findUnique({ where: { id }, include: { items: { select: { title: true } } } })`.

- [ ] **Step 3: Add worker dispatch case**

In `worker/jobs/search-index.ts`, the handler iterates kinds. Verify the new `'checklist'` is picked up automatically (it should be — the loop is over `SEARCH_KINDS`). If there's a switch over kinds, add the case. (Run `grep -n "case '" worker/jobs/search-index.ts` to find.)

- [ ] **Step 4: Write integration test**

```ts
// tests/integration/checklist-index.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupIntegration, type IntegrationContext } from './helpers';

describe('checklist search indexing', () => {
  let ctx: IntegrationContext;
  beforeAll(async () => { ctx = await setupIntegration(); }, 60_000);
  afterAll(async () => ctx.teardown());

  it('upserts a checklist into the unified index', async () => {
    const { saveAcceptedChecklist } = await import('@/lib/ai/suggest/actions');
    const user = await ctx.prisma.user.create({ data: { email: 'idx@x', name: 'I' } });
    const { signInAs } = await import('./helpers');
    await signInAs(user.id);
    const log = await ctx.prisma.aISuggestionLog.create({
      data: { userId: user.id, kind: 'checklist', systemPromptVersion: 'v1', model: 'm', inventorySnapshotIds: [] },
    });
    const r = await saveAcceptedChecklist({
      logId: log.id,
      name: 'Indexable Spring',
      items: [{ title: 'Test pump', itemId: null, rationale: 'r' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();

    // Wait for the worker to pick it up. `waitForIndexed` should be in
    // `tests/integration/helpers.ts` from Plan 4a — confirm during Task 0.
    // If it isn't, look for the equivalent under a different name (e.g.,
    // `waitForSearchDoc`) or add a small polling helper.
    const { waitForIndexed } = await import('./helpers');
    const doc = await waitForIndexed(`checklist-${r.data.checklistId}`, 5000);
    expect(doc.title).toBe('Indexable Spring');
    expect(doc.body).toContain('Test pump');
  });
});
```

- [ ] **Step 5: Run**

```bash
pnpm test:integration tests/integration/checklist-index.test.ts
```

- [ ] **Step 6: Replace the `as never` in Task 12**

Open `lib/ai/suggest/actions.ts` and remove `as never` from `enqueueSearchIndex('checklist' as never, ...)` — `'checklist'` is now a real `SearchKind`.

- [ ] **Step 7: Commit**

```bash
git add lib/search/schema.ts lib/search/document.ts worker/jobs/search-index.ts \
        tests/integration/checklist-index.test.ts lib/ai/suggest/actions.ts
git commit -m "feat(search): add 'checklist' kind to unified index + worker dispatch"
```

---

## Task 15: Checklist domain layer (CRUD)

**Files:**
- Create: `lib/checklists/schema.ts`
- Create: `lib/checklists/schema.test.ts`
- Create: `lib/checklists/queries.ts`
- Create: `lib/checklists/actions.ts`
- Create: `tests/integration/checklists.test.ts`

Mirrors `lib/items/{schema,queries,actions}.ts` shape. Server Actions: create, update, delete, reorder items, addItem, deleteItem.

- [ ] **Step 1: Schema (Zod for inputs)**

```ts
// lib/checklists/schema.ts
import { z } from 'zod';

export const createChecklistSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(2000).optional(),
});

export const updateChecklistSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(2000).nullable().optional(),
  active: z.boolean().optional(),
});

export const checklistItemInputSchema = z.object({
  title: z.string().min(1).max(120),
  itemId: z.string().min(1).nullable().optional(),
});

export const addChecklistItemSchema = z.object({
  checklistId: z.string().min(1),
  ...checklistItemInputSchema.shape,
});

export const reorderChecklistItemsSchema = z.object({
  checklistId: z.string().min(1),
  orderedItemIds: z.array(z.string().min(1)).min(1),
});
```

Companion `schema.test.ts` covering basic accept/reject paths (mirror `lib/items/schema.test.ts`).

- [ ] **Step 2: Queries (read paths)**

```ts
// lib/checklists/queries.ts
import { prisma } from '@/lib/db';

export async function listChecklists() {
  return prisma.checklist.findMany({
    where: { active: true },
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { items: true } } },
  });
}

export async function getChecklist(id: string) {
  return prisma.checklist.findUnique({
    where: { id },
    include: {
      items: {
        orderBy: { position: 'asc' },
        include: { item: { select: { id: true, name: true } } },
      },
    },
  });
}
```

- [ ] **Step 3: Actions (create/update/delete/items)**

```ts
// lib/checklists/actions.ts
'use server';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import type { ActionResult } from '@/lib/result';
import { enqueueSearchIndex } from '@/lib/search/client';
import {
  addChecklistItemSchema,
  createChecklistSchema,
  reorderChecklistItemsSchema,
  updateChecklistSchema,
} from './schema';

async function requireUser() {
  const s = await auth();
  if (!s?.user) return null;
  return s.user;
}

export async function createChecklist(input: unknown): Promise<ActionResult<{ id: string }>> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  const parsed = createChecklistSchema.safeParse(input);
  if (!parsed.success) return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors };
  const created = await prisma.checklist.create({ data: parsed.data });
  await enqueueSearchIndex('checklist', created.id, 'upsert');
  revalidatePath('/checklists');
  return { ok: true, data: { id: created.id } };
}

export async function updateChecklist(input: unknown): Promise<ActionResult<{ id: string }>> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  const parsed = updateChecklistSchema.safeParse(input);
  if (!parsed.success) return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors };
  const { id, ...data } = parsed.data;
  await prisma.checklist.update({ where: { id }, data });
  await enqueueSearchIndex('checklist', id, 'upsert');
  revalidatePath('/checklists');
  revalidatePath(`/checklists/${id}`);
  return { ok: true, data: { id } };
}

export async function deleteChecklist(id: string): Promise<ActionResult> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  await prisma.checklist.delete({ where: { id } });
  await enqueueSearchIndex('checklist', id, 'delete');
  revalidatePath('/checklists');
  return { ok: true, data: undefined };
}

export async function addChecklistItem(input: unknown): Promise<ActionResult<{ id: string }>> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  const parsed = addChecklistItemSchema.safeParse(input);
  if (!parsed.success) return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors };
  const { checklistId, title, itemId } = parsed.data;

  const last = await prisma.checklistItem.findFirst({
    where: { checklistId },
    orderBy: { position: 'desc' },
    select: { position: true },
  });
  const created = await prisma.checklistItem.create({
    data: { checklistId, title, itemId, position: (last?.position ?? -1) + 1 },
  });
  await enqueueSearchIndex('checklist', checklistId, 'upsert');
  revalidatePath(`/checklists/${checklistId}`);
  return { ok: true, data: { id: created.id } };
}

export async function deleteChecklistItem(input: { id: string }): Promise<ActionResult> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  const row = await prisma.checklistItem.delete({ where: { id: input.id }, select: { checklistId: true } });
  await enqueueSearchIndex('checklist', row.checklistId, 'upsert');
  revalidatePath(`/checklists/${row.checklistId}`);
  return { ok: true, data: undefined };
}

export async function reorderChecklistItems(input: unknown): Promise<ActionResult> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  const parsed = reorderChecklistItemsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors };
  const { checklistId, orderedItemIds } = parsed.data;
  await prisma.$transaction(
    orderedItemIds.map((id, position) =>
      prisma.checklistItem.update({ where: { id }, data: { position } }),
    ),
  );
  await enqueueSearchIndex('checklist', checklistId, 'upsert');
  revalidatePath(`/checklists/${checklistId}`);
  return { ok: true, data: undefined };
}
```

- [ ] **Step 4: Integration test**

`tests/integration/checklists.test.ts` — test the create/update/delete/add-item/delete-item/reorder flow end-to-end. Pattern after `tests/integration/items.test.ts`.

- [ ] **Step 5: Verify + commit**

```bash
pnpm test:integration tests/integration/checklists.test.ts
git add lib/checklists tests/integration/checklists.test.ts
git commit -m "feat(checklists): CRUD actions + queries + Zod schemas"
```

---

## Task 16: /checklists index page

**Files:**
- Create: `app/(app)/checklists/page.tsx`

Server Component listing active checklists with item counts and a "New checklist" button.

- [ ] **Step 1: Implement**

```tsx
// app/(app)/checklists/page.tsx
import Link from 'next/link';
import { listChecklists } from '@/lib/checklists/queries';
import { EmptyState } from '@/components/EmptyState';

export default async function ChecklistsPage() {
  const checklists = await listChecklists();
  return (
    <main className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Checklists</h1>
        <Link href="/checklists/new" className="btn-primary">
          New checklist
        </Link>
      </div>
      {checklists.length === 0 ? (
        <EmptyState
          title="No checklists yet"
          description="Create one manually, or generate one from the dashboard."
        />
      ) : (
        <ul className="divide-y rounded-md border">
          {checklists.map((c) => (
            <li key={c.id}>
              <Link href={`/checklists/${c.id}`} className="block p-4 hover:bg-muted">
                <div className="font-medium">{c.name}</div>
                <div className="text-sm text-muted-foreground">{c._count.items} items</div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
```

(Reuse the exact `EmptyState` import path used elsewhere — `grep -rn "EmptyState" app/`.)

- [ ] **Step 2: Run dev server, eyeball at /checklists**

```bash
pnpm dev
# Open http://localhost:3000/checklists. Empty state should show.
```

- [ ] **Step 3: Commit**

```bash
git add app/\(app\)/checklists/page.tsx
git commit -m "feat(checklists): index page listing active templates"
```

---

## Task 17: /checklists/[id] editor + /new

**Files:**
- Create: `app/(app)/checklists/new/page.tsx`
- Create: `app/(app)/checklists/[id]/page.tsx`
- Create: `components/checklists/ChecklistEditor.tsx`

Editor: name + description + drag-to-reorder item list + "add item" inline form. Uses RHF for the meta fields, a separate section for the items list calling `addChecklistItem` / `deleteChecklistItem` / `reorderChecklistItems` actions.

- [ ] **Step 1: New page (form for create)**

`app/(app)/checklists/new/page.tsx` — single-form RHF page calling `createChecklist`. After success, `router.push(/checklists/${id})`.

- [ ] **Step 2: Editor component**

`components/checklists/ChecklistEditor.tsx` — accepts a `checklist` prop (from `getChecklist(id)`), renders meta-form + items list with reorder + add-item input.

- [ ] **Step 3: Detail page**

`app/(app)/checklists/[id]/page.tsx` — Server Component fetching via `getChecklist(id)`, rendering the editor. 404 if not found.

- [ ] **Step 4: Component test or smoke via dev server**

E2E in Task 27 covers the user flow; manual eyeball here is enough.

- [ ] **Step 5: Commit**

```bash
git add app/\(app\)/checklists/new app/\(app\)/checklists/\[id\] components/checklists
git commit -m "feat(checklists): editor with reorder + add-item + meta form"
```

---

## Task 18: SuggestionPreview shared component

**Files:**
- Create: `app/(app)/_components/SuggestionPreview.tsx`
- Create: `components/ai/SuggestionRow.tsx`

Polymorphic on `kind: "reminders" | "checklist"`. RHF `useFieldArray`. Inline edit of title + recurrence (reminders only — checklist rows have title only). Checkbox per row. "Save selected" calls the corresponding save action.

- [ ] **Step 1: SuggestionRow (presentational)**

```tsx
// components/ai/SuggestionRow.tsx
'use client';
import { type Control, useController } from 'react-hook-form';
import type { ProposedReminder } from '@/lib/ai/schemas';

type Props = {
  index: number;
  control: Control<{ proposals: (ProposedReminder & { _selected: boolean; _editing: boolean })[] }>;
  kind: 'reminders' | 'checklist';
};

export function SuggestionRow({ index, control, kind }: Props) {
  const { field } = useController({ control, name: `proposals.${index}` });
  const row = field.value;
  const onToggle = () => field.onChange({ ...row, _selected: !row._selected });
  const onEdit = () => field.onChange({ ...row, _editing: !row._editing });

  return (
    <li className="flex gap-2 p-3 border-b">
      <input type="checkbox" checked={row._selected} onChange={onToggle} />
      <div className="flex-1">
        {row._editing ? (
          <input
            value={row.title}
            onChange={(e) => field.onChange({ ...row, title: e.target.value })}
            className="w-full rounded border px-2 py-1"
          />
        ) : (
          <div className="font-medium">{row.title}</div>
        )}
        {kind === 'reminders' && (
          <RecurrenceLine
            recurrence={(row as ProposedReminder).recurrence}
            editing={row._editing}
            onChange={(rec) => field.onChange({ ...row, recurrence: rec })}
          />
        )}
        {(row as ProposedReminder).rationale && (
          <p className="mt-1 text-sm text-muted-foreground">{(row as ProposedReminder).rationale}</p>
        )}
      </div>
      <button type="button" onClick={onEdit} aria-label="Edit row">
        ✎
      </button>
    </li>
  );
}

function RecurrenceLine(_props: { recurrence: ProposedReminder['recurrence']; editing: boolean; onChange: (r: ProposedReminder['recurrence']) => void }) {
  // Implementation: read-mode renders "every 90 days" / "monthly on the 15th" / "yearly Oct 15".
  // Edit mode renders a small select for kind + an input for the numeric param.
  // Keep this short — this is preview UI; the main editor on the saved Reminder is richer.
  return null;
}
```

(Fill in `RecurrenceLine`. Don't over-engineer — text input + select is fine.)

- [ ] **Step 2: SuggestionPreview (orchestrator)**

```tsx
// app/(app)/_components/SuggestionPreview.tsx
'use client';
import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import {
  saveAcceptedChecklist,
  saveAcceptedReminders,
} from '@/lib/ai/suggest/actions';
import type { ProposedChecklistItem, ProposedReminder } from '@/lib/ai/schemas';
import { SuggestionRow } from '@/components/ai/SuggestionRow';

type RemindersPayload = { kind: 'reminders'; logId: string; itemId?: string; proposals: ProposedReminder[] };
type ChecklistPayload = {
  kind: 'checklist';
  logId: string;
  name: string;
  description?: string;
  appendToChecklistId?: string;
  items: ProposedChecklistItem[];
};

export function SuggestionPreview(props: RemindersPayload | ChecklistPayload) {
  const initialProposals =
    props.kind === 'reminders'
      ? props.proposals.map((p) => ({ ...p, _selected: true, _editing: false }))
      : props.items.map((p) => ({ ...p, _selected: true, _editing: false }));

  const form = useForm({ defaultValues: { proposals: initialProposals } });
  const { fields } = useFieldArray({ control: form.control, name: 'proposals' });
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState<number | null>(null);

  const onSave = form.handleSubmit(async (data) => {
    setSaving(true);
    const selected = data.proposals.filter((r) => r._selected);
    if (props.kind === 'reminders') {
      const r = await saveAcceptedReminders({
        logId: props.logId,
        itemId: props.itemId,
        accepted: selected.map(({ _selected: _s, _editing: _e, ...rest }) => rest as ProposedReminder),
      });
      if (r.ok) setSavedCount(r.data.savedIds.length);
    } else {
      const r = await saveAcceptedChecklist({
        logId: props.logId,
        name: props.name,
        description: props.description,
        appendToChecklistId: props.appendToChecklistId,
        items: selected.map(({ _selected: _s, _editing: _e, ...rest }) => rest as ProposedChecklistItem),
      });
      if (r.ok) setSavedCount(selected.length);
    }
    setSaving(false);
  });

  if (savedCount !== null) {
    return <div className="rounded-md border bg-green-50 p-4">Saved {savedCount}.</div>;
  }
  if (fields.length === 0) {
    return <div className="rounded-md border p-4 text-muted-foreground">No suggestions for this context.</div>;
  }

  return (
    <form onSubmit={onSave}>
      <ul className="rounded-md border">
        {fields.map((f, i) => (
          <SuggestionRow key={f.id} index={i} control={form.control} kind={props.kind} />
        ))}
      </ul>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={() => setSavedCount(0)} className="btn-ghost">
          Discard all
        </button>
        <button type="submit" disabled={saving} className="btn-primary">
          {saving ? 'Saving…' : `Save ${form.watch('proposals').filter((r) => r._selected).length} selected`}
        </button>
      </div>
    </form>
  );
}
```

(Style classes shown are placeholders — match the project's existing class system. Look at how `components/items/*.tsx` styles work.)

- [ ] **Step 3: Visual eyeball**

Mount via a temporary route or storybook-equivalent. Verify checkbox toggle, edit pencil, "Save N selected" button updates count.

- [ ] **Step 4: Commit**

```bash
git add app/\(app\)/_components/SuggestionPreview.tsx components/ai/SuggestionRow.tsx
git commit -m "feat(ai): SuggestionPreview component with checkbox+inline-edit RHF rows"
```

---

## Task 19: Entry point — item-detail "Generate reminders"

**Files:**
- Modify: `app/(app)/items/[id]/page.tsx` (or whichever file renders the item-detail header)
- Create: `components/ai/GenerateRemindersButton.tsx`

Inline expandable section under existing tabs. Click → call `proposeReminders({itemId})` → render `<SuggestionPreview kind="reminders">`.

- [ ] **Step 1: Implement the button**

```tsx
// components/ai/GenerateRemindersButton.tsx
'use client';
import { useState } from 'react';
import { proposeReminders } from '@/lib/ai/suggest/actions';
import { SuggestionPreview } from '@/app/(app)/_components/SuggestionPreview';
import type { ProposedReminder } from '@/lib/ai/schemas';

export function GenerateRemindersButton({ itemId }: { itemId: string }) {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'preview'; logId: string; proposals: ProposedReminder[] }
  >({ kind: 'idle' });

  async function generate() {
    setState({ kind: 'loading' });
    const r = await proposeReminders({ itemId });
    if (!r.ok) {
      setState({ kind: 'error', message: r.formError ?? 'Failed' });
      return;
    }
    setState({ kind: 'preview', logId: r.data.logId, proposals: r.data.proposals });
  }

  if (state.kind === 'preview') {
    return (
      <SuggestionPreview kind="reminders" logId={state.logId} itemId={itemId} proposals={state.proposals} />
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
        {state.message}
        <button type="button" onClick={generate} className="ml-2 underline">Retry</button>
      </div>
    );
  }

  return (
    <button type="button" onClick={generate} disabled={state.kind === 'loading'} className="btn-primary">
      {state.kind === 'loading' ? 'Thinking…' : '✨ Generate reminders'}
    </button>
  );
}
```

- [ ] **Step 2: Mount on item detail**

In `app/(app)/items/[id]/page.tsx` (or whichever component owns the item-detail header — `grep -rln "params.id" app/\(app\)/items/`), add:

```tsx
<GenerateRemindersButton itemId={item.id} />
```

placed below the existing tabs but above the body.

- [ ] **Step 3: Eyeball**

`pnpm dev`, navigate to an item, click the button, verify a toast or preview renders.

- [ ] **Step 4: Commit**

```bash
git add components/ai/GenerateRemindersButton.tsx app/\(app\)/items
git commit -m "feat(ai): wire 'Generate reminders' button on item detail"
```

---

## Task 20: Entry point — dashboard SeasonalChecklistCard

**Files:**
- Create: `app/(app)/dashboard/SeasonalChecklistCard.tsx`
- Modify: `app/(app)/dashboard/page.tsx`

Card with a "Generate {currentSeason} checklist" button. On click: call `proposeChecklist({mode:'seasonal',season})` → open dialog with `<SuggestionPreview kind="checklist">`.

- [ ] **Step 1: Implement**

```tsx
// app/(app)/dashboard/SeasonalChecklistCard.tsx
'use client';
import { useState } from 'react';
import { proposeChecklist } from '@/lib/ai/suggest/actions';
import { seasonForDate } from '@/lib/ai/prompts';
import { SuggestionPreview } from '@/app/(app)/_components/SuggestionPreview';

export function SeasonalChecklistCard() {
  const season = seasonForDate(new Date());
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ logId: string; name: string; items: { title: string; itemId: string | null; rationale: string }[] } | null>(null);
  const [loading, setLoading] = useState(false);

  async function go() {
    setLoading(true);
    setOpen(true);
    const r = await proposeChecklist({ mode: 'seasonal', season });
    setLoading(false);
    if (r.ok) setData({ logId: r.data.logId, name: r.data.name, items: r.data.items });
  }

  return (
    <div className="rounded-md border p-4">
      <h3 className="text-lg font-semibold">Seasonal checklist</h3>
      <p className="text-sm text-muted-foreground">Generate a {season} maintenance checklist tailored to your inventory.</p>
      <button type="button" onClick={go} className="mt-3 btn-primary">Generate {season} checklist</button>

      {open && (loading ? <p className="mt-4">Thinking…</p> : data && (
        <div className="mt-4">
          <h4 className="font-medium">{data.name}</h4>
          <SuggestionPreview kind="checklist" logId={data.logId} name={data.name} items={data.items} />
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Mount on dashboard**

`grep -n "Card\|<section" app/\(app\)/dashboard/page.tsx` — drop `<SeasonalChecklistCard />` in the dashboard layout.

- [ ] **Step 3: Commit**

```bash
git add app/\(app\)/dashboard
git commit -m "feat(ai): wire seasonal checklist card on dashboard"
```

---

## Task 21: Entry point — post-create interstitial

**Files:**
- Create: `app/(app)/items/[id]/suggest-after-create/page.tsx`
- Modify: `lib/items/actions.ts` (createItem returns `{ id }`; redirect target needs to change)

After `createItem` succeeds, redirect to `/items/[id]/suggest-after-create?ref=new`. The page shows: "Item saved ✓ — Want maintenance reminders for this {Furnace}? [Generate suggestions] [Skip]".

- [ ] **Step 1: Adjust the create-item redirect**

The redirect could live in the **client** (`app/(app)/items/new/page.tsx` calling `router.push`) or in the **Server Action** (`lib/items/actions.ts` calling `redirect()` from `next/navigation`). Grep first:

```bash
grep -n "router.push\|redirect" app/\(app\)/items/new/page.tsx lib/items/actions.ts
```

Whichever location currently sends the user to `/items/${id}` after create, change the target to `/items/${id}/suggest-after-create`. The interstitial offers a Skip button that goes to `/items/${id}`.

- [ ] **Step 2: Implement the interstitial page**

```tsx
// app/(app)/items/[id]/suggest-after-create/page.tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { GenerateRemindersButton } from '@/components/ai/GenerateRemindersButton';

export default async function SuggestAfterCreate({
  params,
}: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = await prisma.item.findUnique({
    where: { id },
    select: { id: true, name: true },
  });
  if (!item) notFound();

  return (
    <main className="mx-auto max-w-xl p-6">
      <div className="rounded-md border bg-green-50 p-4 mb-4">
        Item saved ✓
      </div>
      <h1 className="text-xl font-semibold mb-2">Want maintenance reminders for {item.name}?</h1>
      <p className="text-muted-foreground mb-4">
        Claude will suggest a few based on what {item.name} is and where it's installed.
      </p>
      <div className="flex gap-3">
        <GenerateRemindersButton itemId={item.id} />
        <Link href={`/items/${item.id}`} className="btn-ghost">Skip</Link>
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add app/\(app\)/items lib/items/actions.ts
git commit -m "feat(ai): post-create interstitial offers reminder suggestions"
```

---

## Task 22: Entry point — checklist editor "Suggest items"

**Files:**
- Create: `components/ai/SuggestChecklistItemsButton.tsx`
- Modify: `components/checklists/ChecklistEditor.tsx`

A button on the editor that calls `proposeChecklist({mode:'append', forChecklistId})` → preview → save (mode: `appendToChecklistId`).

- [ ] **Step 1: Button**

`components/ai/SuggestChecklistItemsButton.tsx` — same shape as `GenerateRemindersButton`, but calls `proposeChecklist` with `{mode: 'append', forChecklistId}`. Renders `<SuggestionPreview kind="checklist" appendToChecklistId={id}>`.

- [ ] **Step 2: Mount in editor**

Add the button near the "Add item" inline form in `ChecklistEditor.tsx`.

- [ ] **Step 3: Commit**

```bash
git add components/ai/SuggestChecklistItemsButton.tsx components/checklists
git commit -m "feat(ai): 'Suggest items to add' button on checklist editor"
```

---

## Task 23: Entry point — /suggest standalone page

**Files:**
- Create: `app/(app)/suggest/page.tsx`

Top: kind selector (reminders / checklist), free-form textarea (max 2000 chars per Zod), optional item picker for the reminders kind. Bottom: `<SuggestionPreview>` after submit.

- [ ] **Step 1: Implement**

Server Component shell with a Client Component form. The form collects `{kind, freeFormPrompt, itemId?}` and dispatches:
- `kind=reminders` + `itemId` → `proposeReminders({itemId})` (free-form prompt is ignored — reminders aren't free-form in v1; the form should hide the textarea when reminders+item is chosen).
- `kind=reminders` without item → re-use `proposeReminders({})` and prepend the prompt as a system note... actually no — the cleanest scope is: `/suggest` is for **free-form checklists only**. Reminders flow through item-detail. Confirm in the page copy.

For simplicity and YAGNI: **`/suggest` is a freeform-checklist page**. Drop the kind selector. Just a textarea + submit → `proposeChecklist({mode:'freeform', freeFormPrompt})` → preview.

- [ ] **Step 2: Implement (revised, YAGNI)**

```tsx
// app/(app)/suggest/page.tsx
'use client';
import { useState } from 'react';
import { proposeChecklist } from '@/lib/ai/suggest/actions';
import { SuggestionPreview } from '@/app/(app)/_components/SuggestionPreview';

export default function SuggestPage() {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{ logId: string; name: string; items: never[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const r = await proposeChecklist({ mode: 'freeform', freeFormPrompt: prompt });
    setLoading(false);
    if (r.ok) setData({ logId: r.data.logId, name: r.data.name, items: r.data.items as never });
    else setError(r.formError ?? 'Failed');
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold mb-2">Suggest a checklist</h1>
      <p className="text-muted-foreground mb-4">
        Describe what you want a checklist for — pre-vacation, snowstorm prep, end-of-month
        rentals — and Claude will draft items based on your inventory.
      </p>
      <form onSubmit={go} className="space-y-3">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. Pre-vacation checklist for a 2-week trip"
          maxLength={2000}
          rows={4}
          className="w-full rounded-md border p-3"
          required
        />
        <button type="submit" disabled={loading || prompt.length < 3} className="btn-primary">
          {loading ? 'Thinking…' : 'Generate'}
        </button>
      </form>
      {error && <p className="mt-4 text-red-600">{error}</p>}
      {data && (
        <section className="mt-6">
          <h2 className="font-medium">{data.name}</h2>
          <SuggestionPreview kind="checklist" logId={data.logId} name={data.name} items={data.items} />
        </section>
      )}
    </main>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add app/\(app\)/suggest
git commit -m "feat(ai): standalone /suggest page (freeform checklist)"
```

---

## Task 24: Settings — per-item includeInSuggestions toggle

**Files:**
- Create: `components/items/IncludeInSuggestionsToggle.tsx`
- Modify: `app/(app)/items/[id]/page.tsx` (overflow menu)
- Modify: `lib/items/actions.ts` (add `setIncludeInSuggestions(itemId, value)`)

Per spec: not in the main edit form; placed in the item-detail overflow menu (kebab).

- [ ] **Step 1: Action**

Append to `lib/items/actions.ts`:

```ts
export async function setIncludeInSuggestions(input: {
  itemId: string;
  value: boolean;
}): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };
  await prisma.item.update({
    where: { id: input.itemId },
    data: { includeInSuggestions: input.value },
  });
  revalidatePath(`/items/${input.itemId}`);
  return { ok: true, data: undefined };
}
```

- [ ] **Step 2: Toggle component**

```tsx
// components/items/IncludeInSuggestionsToggle.tsx
'use client';
import { useState, useTransition } from 'react';
import { setIncludeInSuggestions } from '@/lib/items/actions';

export function IncludeInSuggestionsToggle({ itemId, initial }: { itemId: string; initial: boolean }) {
  const [value, setValue] = useState(initial);
  const [pending, start] = useTransition();
  function flip() {
    const next = !value;
    setValue(next); // optimistic
    start(async () => {
      const r = await setIncludeInSuggestions({ itemId, value: next });
      if (!r.ok) setValue(!next); // revert
    });
  }
  return (
    <label className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-muted">
      <input type="checkbox" checked={value} onChange={flip} disabled={pending} />
      <span className="text-sm">Include in AI suggestions</span>
    </label>
  );
}
```

- [ ] **Step 3: Mount in item-detail overflow menu**

Find the overflow menu (`grep -rn "DropdownMenu\|<Menu\|kebab\|ellipsis" app/\(app\)/items/`) and add the toggle as a menu item. If no menu exists yet, add one with this toggle as the first entry.

- [ ] **Step 4: Eyeball + commit**

```bash
git add components/items lib/items/actions.ts app/\(app\)/items
git commit -m "feat(ai): per-item includeInSuggestions toggle in overflow menu"
```

---

## Task 25: Admin /admin/ai stats page

**Files:**
- Create: `app/(app)/admin/ai/page.tsx`
- Possibly create: `app/(app)/admin/layout.tsx` (admin role gate, if not present)

Reads `AISuggestionLog` directly. Stats: total today, failure rate, accept rate, avg latency, total tokens. Admin-only via `session.user.role === 'ADMIN'`.

- [ ] **Step 1: Verify admin gate**

`grep -rn "role.*ADMIN" app/ lib/auth.ts auth.config.ts` — find the existing pattern. If no `/admin` exists yet, create `app/(app)/admin/layout.tsx`:

```tsx
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (session?.user?.role !== 'ADMIN') redirect('/');
  return <>{children}</>;
}
```

- [ ] **Step 2: Stats page**

```tsx
// app/(app)/admin/ai/page.tsx
import { prisma } from '@/lib/db';

export default async function AdminAIPage() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await prisma.aISuggestionLog.findMany({
    where: { createdAt: { gte: since } },
    select: {
      errorReason: true,
      latencyMs: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      acceptedItemIds: true,
      response: true,
    },
  });
  const total = rows.length;
  const failed = rows.filter((r) => r.errorReason).length;
  const succeeded = total - failed;
  const accepted = rows.filter((r) => Array.isArray(r.acceptedItemIds) && (r.acceptedItemIds as unknown[]).length > 0).length;
  const acceptRate = succeeded ? Math.round((accepted / succeeded) * 100) : 0;
  const avgLatency = succeeded
    ? Math.round(rows.filter((r) => !r.errorReason && r.latencyMs).reduce((s, r) => s + (r.latencyMs ?? 0), 0) / succeeded)
    : 0;
  const totalIn = rows.reduce((s, r) => s + (r.inputTokens ?? 0), 0);
  const totalOut = rows.reduce((s, r) => s + (r.outputTokens ?? 0), 0);
  const totalCache = rows.reduce((s, r) => s + (r.cacheReadTokens ?? 0), 0);

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-4">AI suggestions — last 24 hours</h1>
      <dl className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <Stat label="Total calls" value={total} />
        <Stat label="Failures" value={`${failed} (${total ? Math.round((failed / total) * 100) : 0}%)`} />
        <Stat label="Accept rate" value={`${acceptRate}%`} />
        <Stat label="Avg latency" value={`${avgLatency} ms`} />
        <Stat label="Input tokens" value={totalIn} />
        <Stat label="Output tokens" value={totalOut} />
        <Stat label="Cache reads" value={totalCache} />
      </dl>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border p-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold">{value}</dd>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add app/\(app\)/admin
git commit -m "feat(ai): /admin/ai stats page (last 24h)"
```

---

## Task 26: Smoke test + nightly GitHub Actions workflow

**Files:**
- Modify: `package.json` (new `test:smoke` script)
- Create: `tests/smoke/ai-suggest.smoke.test.ts`
- Create: `.github/workflows/nightly-smoke.yml`

The smoke test calls the **real** Anthropic API once per Suggest variant. Mock harness is bypassed for these. Skipped automatically when `ANTHROPIC_API_KEY` is missing or has the test placeholder prefix.

- [ ] **Step 1: Add the script**

In `package.json` `scripts`:

```jsonc
"test:smoke": "vitest run --config vitest.smoke.config.ts"
```

Create `vitest.smoke.config.ts` that excludes `tests/setup/anthropic-mock.ts` from `setupFiles`. Otherwise the harness intercepts the real SDK.

```ts
// vitest.smoke.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/smoke/**/*.test.ts'],
    setupFiles: [], // explicitly empty — no anthropic mock
    testTimeout: 60_000,
  },
});
```

- [ ] **Step 1.5: Verify call shape matches Task 4's resolution**

If Task 4 confirmed `output_config: { format: zodOutputFormat(...) }` works on Haiku 4.5, the smoke-test code below is correct as written. If Task 4 fell back to the `betaZodTool` path, **rewrite the smoke test to use the same call shape** as the production action — otherwise the smoke test passes against an API surface the app doesn't actually use.

- [ ] **Step 2: Smoke test**

```ts
// tests/smoke/ai-suggest.smoke.test.ts
import { describe, expect, it } from 'vitest';

const apiKey = process.env.ANTHROPIC_API_KEY;
const skip = !apiKey || apiKey.includes('placeholder');

describe.skipIf(skip)('Anthropic SDK live smoke', () => {
  it('messages.parse responds with the expected shape on Haiku 4.5', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');
    const { proposeRemindersResponseSchema } = await import('@/lib/ai/schemas');

    const client = new Anthropic({ apiKey });
    const result = await client.messages.parse({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'Suggest 2 generic household maintenance reminders. Return JSON matching the schema.' },
      ],
      output_config: { format: zodOutputFormat(proposeRemindersResponseSchema) },
    } as never);

    const parsed = (result as { parsed_output: { proposals: unknown[] } }).parsed_output;
    expect(parsed.proposals.length).toBeGreaterThanOrEqual(0);
  });
});
```

(Add a second variant for the checklist schema once the first is green.)

- [ ] **Step 3: GitHub Actions workflow**

```yaml
# .github/workflows/nightly-smoke.yml
name: nightly-smoke
on:
  schedule:
    - cron: '0 7 * * *'  # 07:00 UTC daily
  workflow_dispatch: {}

jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: package.json
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:smoke
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - name: Open issue on failure
        if: failure()
        uses: peter-evans/create-issue-from-file@v5
        with:
          title: 'Nightly Anthropic smoke failed'
          content-filepath: '.github/issue-templates/smoke-failure.md'
          labels: 'smoke-failure,ai'
```

Create `.github/issue-templates/smoke-failure.md` with a brief template ("Run failed: <link>; please investigate within 24h").

- [ ] **Step 4: Manual run + commit**

```bash
ANTHROPIC_API_KEY=<real key> pnpm test:smoke
# Expected: 1 test passed.
```

```bash
git add package.json vitest.smoke.config.ts tests/smoke .github/workflows .github/issue-templates
git commit -m "test(ai): nightly smoke test against live Anthropic API"
```

---

## Task 27: E2E coverage (Playwright)

**Files:**
- Create: `tests/e2e/suggest-from-item.spec.ts`
- Create: `tests/e2e/suggest-seasonal.spec.ts`
- Create: `tests/e2e/suggest-after-create.spec.ts`

E2E uses the same anthropic-mock from Task 8, set up via Playwright's `route` interception. Look at how Plan 4a's `/search` E2E mocks Meilisearch (`tests/e2e/search.spec.ts` if it exists).

- [ ] **Step 1: Determine the E2E mock pattern**

`grep -rn "page.route\|fixture" tests/e2e/` — adopt the existing pattern. If E2E tests in this repo go through real HTTP and don't mock external APIs, the cleanest path here is:
- Run the dev server with `ANTHROPIC_API_KEY=test-fake-key`.
- Point the Anthropic SDK base URL at a local mock server started by Playwright `globalSetup` that serves the JSON fixtures from `tests/fixtures/suggest/`.

Document whichever path you choose at the top of the first spec file.

- [ ] **Step 2: Implement spec 1 — suggest-from-item**

```ts
// tests/e2e/suggest-from-item.spec.ts
import { expect, test } from '@playwright/test';

test('item detail → generate reminders → save selected', async ({ page }) => {
  await page.goto('/items/<seeded-item-id>'); // use whatever seed pattern existing E2E tests use
  await page.click('text=Generate reminders');
  await expect(page.locator('text=Replace furnace air filter')).toBeVisible();
  await page.uncheck('input[type=checkbox]:nth-of-type(2)'); // deselect 2nd row
  await page.click('text=Save 1 selected');
  await expect(page.locator('text=Saved 1')).toBeVisible();
});
```

- [ ] **Step 3: Spec 2 — seasonal dashboard**

```ts
test('dashboard → generate seasonal checklist → save all', async ({ page }) => {
  await page.goto('/dashboard');
  await page.click('text=Generate spring checklist');
  await expect(page.locator('text=Spring 2026 Maintenance')).toBeVisible();
  await page.click('text=Save 3 selected');
  await page.goto('/checklists');
  await expect(page.locator('text=Spring 2026 Maintenance')).toBeVisible();
});
```

- [ ] **Step 4: Spec 3 — post-create interstitial**

```ts
test('create item → interstitial offers reminders → skip', async ({ page }) => {
  await page.goto('/items/new');
  // ... fill form, submit
  await expect(page).toHaveURL(/suggest-after-create$/);
  await page.click('text=Skip');
  await expect(page).toHaveURL(/items\/[^/]+$/);
});
```

- [ ] **Step 5: Run + commit**

```bash
pnpm test:e2e
git add tests/e2e/suggest-from-item.spec.ts tests/e2e/suggest-seasonal.spec.ts tests/e2e/suggest-after-create.spec.ts
git commit -m "test(e2e): cover suggest-from-item, seasonal, post-create flows"
```

---

## Task 28: Final verify pass + branch handoff

- [ ] **Step 1: Full verify**

```bash
pnpm verify
# Expected: lint ✓ typecheck ✓ test:unit ✓
```

- [ ] **Step 2: Integration tests**

```bash
pnpm test:integration
# Expected: every new test green.
```

- [ ] **Step 3: E2E**

```bash
pnpm test:e2e
# Expected: every new spec green.
```

- [ ] **Step 4: Smoke (manual, with real key)**

```bash
ANTHROPIC_API_KEY=<real> pnpm test:smoke
```

- [ ] **Step 5: Pre-commit dry run**

```bash
git status
# Expected: clean tree.
git log --oneline main..HEAD | wc -l
# Expected: 25–30 commits across the plan's tasks.
```

- [ ] **Step 6: Hand off to finishing-a-development-branch skill**

Use the `superpowers:finishing-a-development-branch` skill to choose between merge / PR / further iteration.

---

## Reference: skills to invoke during implementation

- `@superpowers:test-driven-development` — every task starts with a failing test.
- `@superpowers:systematic-debugging` — when something doesn't work, don't guess. Hypothesize → test → verify.
- `@superpowers:verification-before-completion` — run the test you wrote and **see** it pass before claiming the task done.
- `@superpowers:requesting-code-review` — at end of each major group of tasks (e.g. after Task 13, after Task 18, after Task 25), request a review pass.
- `@superpowers:finishing-a-development-branch` — Task 28's handoff.

---

## Open implementation questions (to resolve at start of Task 4)

1. Confirm `messages.parse({ output_config: { format: zodOutputFormat(...) } })` is GA on `claude-haiku-4-5` in the SDK version installed by Task 2. Fallback: `betaZodTool` with the same Zod schemas.
2. Confirm `lib/reminders/` already exposes a `nextDueOn` calculator that handles the three recurrence shapes — if so, import it in Task 11 instead of duplicating.
3. Confirm the project's existing `<EmptyState>` import path and styling conventions during Task 16.
4. Confirm whether `app/(app)/admin` already exists (Task 25) — if so, append the AI section; if not, add the admin layout gate.

---

## Amendment after Plan 4ab (UI redesign — shipped 2026-05-03 as `eab30ff`)

After Plan 4ab merged, this plan rebases onto post-4ab main. The schema commit (Task 1, `00e95a7`) is conflict-free. UI tasks below now use shadcn primitives instead of inline-styled placeholders.

**Plan 4ab installed primitives note (applies to ALL UI tasks below):** `<Button>`, `<DropdownMenu*>`, `<Tabs>`, `<Sidebar*>`, and several other shadcn primitives use Base UI's `render={...}` prop pattern (NOT `asChild`) because the `base-nova` preset wraps `@base-ui/react`. When porting any pattern from external shadcn docs that uses `asChild`, swap to `render={<Element />}`. `<Button>` auto-defaults `nativeButton={false}` when `render` is passed (via `components/ui/button.tsx` modification), so `<Button render={<Link href="...">}>` works at all sites without per-call `nativeButton` props.

**Task 16 (`/checklists` index)** — replace raw `<main>` shell with `<ListPageShell>`. Replace inline-styled `<Link href="/checklists/new">New checklist</Link>` with `<Button render={<Link href="/checklists/new" />}>`. Cards use shadcn `<Card>` + `<CardHeader>` / `<CardTitle>` / `<CardContent>`. Add `loading.tsx` mirroring the card grid.

**Task 17 (`/checklists/[id]` editor)** — replace raw form composition with shadcn `<Form>` + `<FormField>` per the canonical pattern from `components/items/ItemForm.tsx`. Wrap in `<FormPageShell>`. Note: `components/ui/form.tsx` exists in this repo (manually ported during 4ab Task 3 because `base-nova` registry omits it). Use `applyActionFieldErrors` from `@/lib/forms/helpers` for server-side validation errors.

**Task 18 (SuggestionPreview)** — replace placeholder `btn-primary` className strings with `<Button variant="default">`. Replace `btn-ghost` strings with `<Button variant="ghost">`. The dashboard entry point's modal uses shadcn `<Dialog>` from `@/components/ui/dialog`. The dashboard surface that triggers it: `app/(app)/dashboard/SeasonalChecklistCard.tsx` — currently a placeholder Card from 4ab; replace its body with the "Generate {season} checklist" `<Button>` + `<Dialog>` trigger.

**Task 21 (post-create interstitial)** — `<main className="mx-auto max-w-xl p-6">` becomes `<FormPageShell maxWidth="xl" header={<PageHeader title="Suggestion saved" />}>`. Buttons become shadcn (`<Button>` for primary, `<Button variant="outline">` for secondary).

**Task 23 (`/suggest` standalone)** — `<textarea>` → shadcn `<Textarea>` from `@/components/ui/textarea`. Submit button → shadcn `<Button type="submit">`. Wrap the page in `<FormPageShell maxWidth="2xl" header={<PageHeader title="Generate suggestion" />}>`.

**Task 24 (per-item `IncludeInSuggestionsToggle`)** — wire it into `<ItemOverflowMenu>` (exists from 4ab Task 13 at `components/items/ItemOverflowMenu.tsx`). Use shadcn `<DropdownMenuCheckboxItem>` rather than a raw `<input type="checkbox">`. The toggle calls the existing `setIncludeInSuggestions` server action; on success show a `toast.success(...)` from `sonner` (already wired in `app/(app)/layout.tsx`).

**Task 25 (admin `/admin/ai`)** — stat strip uses shadcn `<Card>` per stat (similar shape to the dashboard's `DueSoonLane` strip in `app/(app)/dashboard/DueSoonLane.tsx`). Page wraps in `<FormPageShell>` if it's read-only stats with no controls, or `<ListPageShell>` if it has a recent-suggestions table. Designer's call.

**`<EmptyState>` API note (resolves Open Question #3 above):** as of 4ab Task 22, the API is `{icon?, title, description?, action?, className?}` — title is the headline, description is the subtext. Pass `<EmptyState title="No checklists yet" description="..." action={<Button .../>} />`. The old `message=` API was removed.

**`/admin` route note (resolves Open Question #4 above):** as of 4ab, no `/admin` route group exists — Task 25 creates `app/(app)/admin/ai/page.tsx` as a new route. The auth gate in `app/(app)/layout.tsx` only checks for any signed-in user; the role check `session.user.role === 'ADMIN'` belongs in the admin page itself or in a new `app/(app)/admin/layout.tsx`. The `<AppSidebar>` already conditionally renders an "Admin" link when `user.role === 'ADMIN'` (from 4ab Task 4); just add `/admin/ai` to that link's destination or to a sub-nav inside the admin route group.

Server Action contracts and tests don't change. The amendment is mechanical — same logic, different JSX nouns.
