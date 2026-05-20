# Item-Restored Dashboard Event Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface an `item-restored` event in the dashboard activity feed, derived from a new durable `Item.restoredAt` timestamp.

**Architecture:** Add `Item.restoredAt`; make `archiveItem`/`restoreItem` mutually clear each other's timestamp (exactly one is ever set, reflecting the last lifecycle transition); the dashboard `recentActivity` query derives `item-restored` from `restoredAt` exactly as it derives `item-archived` from `archivedAt`.

**Tech Stack:** Prisma 7 + Postgres, TypeScript strict, Vitest 4 + Testcontainers, Biome 2. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-20-item-restored-event-design.md`

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `prisma/schema.prisma` | modify | add `Item.restoredAt DateTime?` + `@@index([restoredAt])` |
| `prisma/migrations/<ts>_item_restored_at/migration.sql` | create | generated: ADD COLUMN + CREATE INDEX |
| `lib/items/actions.ts` | modify | `archiveItem`/`restoreItem` mutual clear/set |
| `tests/integration/item-archive-restore.test.ts` | create | action-level test of the mutual-clear behavior |
| `lib/dashboard/queries.ts` | modify | add `item-restored` kind + query + mapping; delete stale NOTE |
| `tests/integration/dashboard-activity.test.ts` | create | `recentActivity` returns the restored event correctly |

---

## Task 1: Schema — add `restoredAt` + index

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_item_restored_at/migration.sql` (generated)

- [ ] **Step 1: Add the column + index to `model Item`**

In `prisma/schema.prisma`, in `model Item`, add `restoredAt` directly after the existing `archivedAt DateTime?` line:
```prisma
  archivedAt      DateTime?
  restoredAt      DateTime?
```
And add an index next to the existing `@@index([archivedAt])`:
```prisma
  @@index([archivedAt])
  @@index([restoredAt])
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:migrate` and name it `item_restored_at` when prompted (or `--name item_restored_at`).
Expected: `prisma/migrations/<timestamp>_item_restored_at/migration.sql` with `ALTER TABLE "items" ADD COLUMN "restoredAt"` and `CREATE INDEX "items_restoredAt_idx"`.

- [ ] **Step 3: EYEBALL the generated migration (load-bearing)**

Open the generated `migration.sql`. If it contains `DROP INDEX "embeddings_embedding_cosine_idx"` (Prisma 7 auto-diff drift — that's the hand-written pgvector ivfflat index from Plan 4c, which Prisma can't model), **DELETE that DROP line** and add a one-line comment explaining why (see the precedent in `prisma/migrations/20260520013044_digest_logs/migration.sql`). The migration must contain ONLY the `restoredAt` column + index changes.

- [ ] **Step 4: Verify schema + migration apply cleanly**

Run: `pnpm verify`
Expected: lint + typecheck + unit green.
Run: `pnpm vitest run tests/integration/items.test.ts`
Expected: green (Testcontainers applies the new migration fresh; confirms it's valid).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(items): add restoredAt column + index"
```

---

## Task 2: Actions — mutual clear/set (TDD)

**Files:**
- Create: `tests/integration/item-archive-restore.test.ts`
- Modify: `lib/items/actions.ts`

The `archiveItem`/`restoreItem` actions call `auth()`, `revalidatePath()`, `enqueueSearchIndex()`, `enqueueEmbed()` — all mocked in the test (pattern from `tests/integration/incoming-email-actions.test.ts`). The behavior under test is the timestamp mutation against a real Postgres.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/item-archive-restore.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'u1', name: 'Test' } })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/search/client', () => ({ enqueueSearchIndex: vi.fn(async () => {}) }));
vi.mock('@/lib/embedding/enqueue', () => ({ enqueueEmbed: vi.fn(async () => {}) }));

let ctx: IntegrationContext;
let categoryId: string;
let actions: typeof import('@/lib/items/actions');

beforeAll(async () => {
  ctx = await setupIntegration();
  actions = await import('@/lib/items/actions');
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'archive-restore-cat' },
    create: { slug: 'archive-restore-cat', name: 'ARCat', sortOrder: 999 },
    update: {},
  });
  categoryId = cat.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.item.deleteMany();
});

describe('archiveItem / restoreItem timestamp mutation', () => {
  it('archiveItem sets archivedAt and clears restoredAt', async () => {
    const item = await ctx.prisma.item.create({
      data: { name: 'X', categoryId, restoredAt: new Date() },
    });
    const r = await actions.archiveItem(item.id);
    expect(r.ok).toBe(true);
    const read = await ctx.prisma.item.findUnique({ where: { id: item.id } });
    expect(read?.archivedAt).toBeInstanceOf(Date);
    expect(read?.restoredAt).toBeNull();
  });

  it('restoreItem sets restoredAt and clears archivedAt', async () => {
    const item = await ctx.prisma.item.create({
      data: { name: 'Y', categoryId, archivedAt: new Date() },
    });
    const r = await actions.restoreItem(item.id);
    expect(r.ok).toBe(true);
    const read = await ctx.prisma.item.findUnique({ where: { id: item.id } });
    expect(read?.restoredAt).toBeInstanceOf(Date);
    expect(read?.archivedAt).toBeNull();
  });

  it('re-archiving after restore flips back (restoredAt cleared)', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'Z', categoryId } });
    await actions.restoreItem(item.id);
    await actions.archiveItem(item.id);
    const read = await ctx.prisma.item.findUnique({ where: { id: item.id } });
    expect(read?.archivedAt).toBeInstanceOf(Date);
    expect(read?.restoredAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run → confirm failure**

Run: `pnpm vitest run tests/integration/item-archive-restore.test.ts`
Expected: FAIL — `archiveItem` doesn't clear `restoredAt` (case 1 fails: restoredAt still set), `restoreItem` doesn't set `restoredAt` (case 2 fails: restoredAt null).

- [ ] **Step 3: Update the two actions in `lib/items/actions.ts`**

In `archiveItem`, change the update to:
```ts
  await prisma.item.update({ where: { id }, data: { archivedAt: new Date(), restoredAt: null } });
```
In `restoreItem`, change the update to:
```ts
  await prisma.item.update({ where: { id }, data: { archivedAt: null, restoredAt: new Date() } });
```
Leave everything else (auth check, enqueues, revalidatePath, return) unchanged.

- [ ] **Step 4: Run → confirm pass**

Run: `pnpm vitest run tests/integration/item-archive-restore.test.ts`
Expected: 3/3 PASS.

- [ ] **Step 5: Confirm no regression**

Run: `pnpm vitest run tests/integration/items.test.ts`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add lib/items/actions.ts tests/integration/item-archive-restore.test.ts
git commit -m "feat(items): archive/restore mutually clear archivedAt/restoredAt"
```

---

## Task 3: Dashboard query — `item-restored` event (TDD)

**Files:**
- Create: `tests/integration/dashboard-activity.test.ts`
- Modify: `lib/dashboard/queries.ts`

`recentActivity` is a plain query (no auth). It imports `@/lib/db` at module scope → the test must dynamic-import it in `beforeAll` (DATABASE_URL trap).

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/dashboard-activity.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;
let categoryId: string;
let recentActivity: (limit?: number) => Promise<Array<{ kind: string; label: string; href: string; occurredAt: Date }>>;

beforeAll(async () => {
  ctx = await setupIntegration();
  recentActivity = (await import('@/lib/dashboard/queries')).recentActivity;
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'dash-activity-cat' },
    create: { slug: 'dash-activity-cat', name: 'DACat', sortOrder: 999 },
    update: {},
  });
  categoryId = cat.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.item.deleteMany();
});

describe('recentActivity — item-restored', () => {
  it('emits an item-restored event for an item with restoredAt set', async () => {
    const item = await ctx.prisma.item.create({
      data: { name: 'Furnace', categoryId, restoredAt: new Date('2026-05-20T10:00:00Z') },
    });
    const events = await recentActivity(20);
    const restored = events.find((e) => e.kind === 'item-restored');
    expect(restored).toBeDefined();
    expect(restored?.label).toBe('Restored Furnace');
    expect(restored?.href).toBe(`/items/${item.id}`);
    expect(restored?.occurredAt.toISOString()).toBe('2026-05-20T10:00:00.000Z');
  });

  it('does not emit item-restored for a never-archived item', async () => {
    await ctx.prisma.item.create({ data: { name: 'Fresh', categoryId } });
    const events = await recentActivity(20);
    expect(events.some((e) => e.kind === 'item-restored')).toBe(false);
  });

  it('an archived item shows item-archived, not item-restored', async () => {
    await ctx.prisma.item.create({
      data: { name: 'Old', categoryId, archivedAt: new Date('2026-05-20T09:00:00Z'), restoredAt: null },
    });
    const events = await recentActivity(20);
    expect(events.some((e) => e.kind === 'item-archived')).toBe(true);
    expect(events.some((e) => e.kind === 'item-restored')).toBe(false);
  });
});
```

- [ ] **Step 2: Run → confirm failure**

Run: `pnpm vitest run tests/integration/dashboard-activity.test.ts`
Expected: FAIL — no `item-restored` events produced (the query/kind don't exist yet). (TypeScript may also flag the kind; that's fine — the runtime assertion failing is the red.)

- [ ] **Step 3: Modify `lib/dashboard/queries.ts`**

(a) Delete the stale comment at the top (lines 4-5):
```ts
// NOTE: "item-restored" events are deferred until an event log table exists.
// Plan 3 reminders/notifications work may introduce one; add the 5th event type then.
```

(b) Add `'item-restored'` to the `ActivityEvent['kind']` union:
```ts
  kind:
    | 'item-created'
    | 'service-logged'
    | 'note-added'
    | 'item-archived'
    | 'item-restored'
    | 'attachment-added'
    | 'reminder-completed';
```

(c) Add a 7th query to the `Promise.all([...])` destructuring. Add `restored` to the destructured array and the matching `findMany` (place it right after the `archived` query for readability):
```ts
  const [items, services, notes, archived, restored, attachments, completions] = await Promise.all([
    // ... items, services, notes, archived (unchanged) ...
    prisma.item.findMany({
      where: { restoredAt: { not: null } },
      orderBy: { restoredAt: 'desc' },
      take: limit,
      select: { id: true, name: true, restoredAt: true },
    }),
    // ... attachments, completions (unchanged) ...
  ]);
```
IMPORTANT: the destructuring order must match the `Promise.all` array order. Insert the new `findMany` in the SAME position as `restored` appears in the destructure (after `archived`, before `attachments`).

(d) Add the mapping to the `events` array, right after the `...archived.flatMap(...)` block:
```ts
    ...restored.flatMap((i) =>
      i.restoredAt
        ? [
            {
              kind: 'item-restored' as const,
              occurredAt: i.restoredAt,
              label: `Restored ${i.name}`,
              href: `/items/${i.id}`,
              icon: '📤',
            },
          ]
        : [],
    ),
```

- [ ] **Step 4: Run → confirm pass**

Run: `pnpm vitest run tests/integration/dashboard-activity.test.ts`
Expected: 3/3 PASS.

- [ ] **Step 5: `pnpm verify`**

Expected: lint + typecheck + unit green.

- [ ] **Step 6: Commit**

```bash
git add lib/dashboard/queries.ts tests/integration/dashboard-activity.test.ts
git commit -m "feat(dashboard): item-restored activity event"
```

---

## Task 4: Final verify + finishing

- [ ] **Step 1: Full verify**

Run: `pnpm verify`
Expected: green.

- [ ] **Step 2: Integration suite**

Run: `pnpm test:integration`
Expected: all green incl. the two new test files.

- [ ] **Step 3: E2E + build**

Run: `pnpm test:e2e` and `pnpm build`
Expected: green, or deferred to CI if the local stack/env isn't available (same convention as prior PRs — note it).

- [ ] **Step 4: Hand off to `superpowers:finishing-a-development-branch`**

Push + PR. PR body should note: the `restoredAt` column + mutual-clear, the dashboard event, no backfill of pre-existing restores, and any deferred CI checks.

---

## Cadence reminders

- One combined-reviewer Haiku review per task before marking complete (per `feedback_execution_cadence`).
- Don't push during execution; push via `finishing-a-development-branch`.
- All commits signed (1Password auto). Stage explicit paths. Never `--no-verify`.
- **Migration drift**: Task 1 Step 3 is load-bearing — strip any auto-emitted `DROP INDEX embeddings_embedding_cosine_idx` (per `feedback_prisma_migration_drift`).
