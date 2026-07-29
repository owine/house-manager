# Parts PR 1a — Schema and Target Widening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `Part` and `PartLink` tables and make `Part` a valid target of reminders and service records, without shipping any user-visible surface.

**Architecture:** `Part` is a re-buy specification (bulbs, filters, batteries) linked many-to-many to `Item`s and `System`s through `PartLink`. Cadence is delegated to the existing `Reminder` machinery and replacement history to `ServiceRecord`, so `reminder_targets` and `service_record_targets` each gain a third nullable parent column, `partId`. **That third column is the entire risk of this PR**: it silently redefines every predicate in the codebase written as "both parent columns are null", and several of those predicates delete rows.

**Tech Stack:** Prisma 7 / Postgres 18, Zod, Vitest (unit + Testcontainers integration), Next.js 16 server actions.

**Spec:** `docs/superpowers/specs/2026-07-29-parts-design.md`

---

## Read this before starting

Three facts that will otherwise cost you hours:

1. **`pnpm test:unit` and `pnpm test:integration` pass directory arguments**, so appending a path *widens* the run instead of narrowing it. To run one file, invoke vitest directly: `pnpm exec vitest run tests/integration/parts-constraints.test.ts`.
2. **`git commit` can fail silently behind the Biome pre-commit hook.** After every commit, verify HEAD actually moved with `git log --oneline -1`. Never use `--no-verify`.
3. **The dev database is disposable.** If a migration blocks, reset and reseed (`pnpm db:migrate reset`) rather than doing checksum surgery.

`prisma migrate diff` cannot regenerate any of the hand-written SQL in Task 2. Eyeball the generated migration for dropped CHECK constraints and dropped `NULLS NOT DISTINCT` indexes every time you regenerate.

## File structure

**Create:**

| Path | Responsibility |
|---|---|
| `tests/integration/parts-constraints.test.ts` | The CHECK constraints and `NULLS NOT DISTINCT` uniques. Cannot be tested with mocks. |
| `tests/integration/parts-target-reconciliation.test.ts` | That a part target survives a save, a completion, and a second save. |

**Modify:**

| Path | Change |
|---|---|
| `prisma/schema.prisma` | `PartKind` enum, `Part` + `PartLink` models, `partId` on 3 models, `@@unique` + `map:` on 2 |
| `prisma/migrations/<new>/migration.sql` | Hand-appended CHECK constraints and index rebuilds |
| `lib/targets/schema.ts` | New `partTargetSchema` / `PartTargetInput`; widen `toTargetInputs` |
| `lib/targets/expand.ts` | `p:` dedupe key prefix |
| `lib/reminders/schema.ts` | Consume `partTargetSchema` |
| `lib/service-records/schema.ts` | Consume `partTargetSchema` |
| `lib/reminders/actions.ts` | Sentinel predicate, 3 diff keys, 3 selects, create paths, `validateTargets`, `completeReminder`, `revalidateReminderPaths` |
| `lib/service-records/actions.ts` | `targetsToCreateData`, 1 diff key, 1 select, `validateTargets`, `revalidateForTargets` |
| `app/(app)/service/[id]/edit/page.tsx` | Route through `toTargetInputs` instead of duplicating it |
| `components/targets/TargetsChips.tsx` | Part branch in `resolve()` |
| `app/(app)/dashboard/UpcomingRemindersCard.tsx` | Part label + `kind` |
| `app/(app)/reminders/[id]/page.tsx` | Part label + `kind` |
| `components/reminders/MarkCompleteDialog.tsx` | Widen `kind` union |
| `lib/email/templates/reminder.tsx` | Part branch in `resolveTargets` |
| `worker/jobs/notify.ts` | Select `part` on targets |
| `lib/digests/queries.ts`, `lib/digests/group.ts` | Part in `DigestTarget` |
| `lib/search/document.ts` | Part in the service aggregation loop + its select |
| `lib/embedding/canonicalize.ts` | Part in `canonicalizeServiceRecord` |

**Deliberately NOT in this PR:** `lib/parts/*`, any route under `app/(app)/parts/`, the nav entry, the Parts tabs, the picker UI, `deleteSystemWithParts`, the `freeform.ts` extraction, seeds. Those are PR 1b.

---

### Task 1: Schema models

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add the `PartKind` enum**

Place it next to the other enums, after `ReminderKind`:

```prisma
enum PartKind {
  BULB
  AIR_FILTER
  WATER_FILTER
  BATTERY
  BELT
  FUSE
  CHEMICAL      // softener salt, pool chlorine, descaler
  OTHER
}
```

- [ ] **Step 2: Add the `Part` and `PartLink` models**

Copy verbatim from the spec's "Data model" section. Two things not to "clean up":

- **`Part` has no date columns.** That is deliberate — it is why `lib/prisma-extensions.ts` and `CALENDAR_DATE_FIELDS` in `lib/calendar-date-guard.ts` need no changes in this PR. Do not add `lastReplacedOn` or similar.
- **`PartLink.itemId` and `systemId` are both nullable**, and a part with *zero* links is legal (that is the "standalone/generic" case). The XOR is per-link-row, not per-part.

- [ ] **Step 3: Add `partId` to the three consuming models**

On `ReminderTarget`, `ServiceRecordTarget`, and `Attachment`, add:

```prisma
  partId          String?
  part            Part?     @relation(fields: [partId], references: [id], onDelete: Cascade)
```

plus `@@index([partId])` on each. **Do not add `partId` to `WarrantyTarget` or `IncomingEmailTarget`** — parts carry no warranties and inbound email has no reason to link to one. Those two keep their two-way XOR.

- [ ] **Step 4: Update the two `@@unique`s with explicit names**

```prisma
// on ReminderTarget
@@unique([reminderId, itemId, systemId, partId], map: "reminder_targets_reminder_item_system_part_key")

// on ServiceRecordTarget
@@unique([serviceRecordId, itemId, systemId, partId], map: "sr_targets_record_item_system_part_key")
```

The `map:` is **required, not cosmetic**. Prisma's default name for the service-record one would be `service_record_targets_serviceRecordId_itemId_systemId_partId_key` — 65 characters, over Postgres's 63-byte identifier limit. Postgres truncates silently and Prisma truncates by its own rule, so the two would disagree and the `migrate-check` CI job would report permanent drift. Both are mapped so the tables stay symmetric.

- [ ] **Step 5: Verify the schema parses**

Run: `pnpm exec prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(parts): add Part and PartLink models, partId target columns"
git log --oneline -1   # confirm HEAD moved
```

---

### Task 2: Migration with hand-written SQL

**Files:**
- Create: `prisma/migrations/<timestamp>_parts/migration.sql` (generated, then edited)

- [ ] **Step 1: Generate the migration**

```bash
docker compose up -d db meilisearch
pnpm db:migrate --name parts
```

- [ ] **Step 2: Read the generated SQL and check for damage**

Open the generated `migration.sql`. Prisma emits the new tables and columns, and it will also emit `DROP INDEX` / `CREATE UNIQUE INDEX` for the two uniques it is changing — **without `NULLS NOT DISTINCT`**. That default-Postgres semantics would stop deduping rows where a target column is NULL, which is the entire reason the custom indexes exist.

Confirm it has NOT dropped, and re-append by hand if it has:
- the IVFFlat pgvector index on `embeddings`
- `Attachment_storage_xor_link` / `Attachment_file_metadata_required`
- the XOR CHECKs on `warranty_targets` / `incoming_email_targets` / vendor links

- [ ] **Step 3: Append the custom SQL**

Append verbatim to the end of the generated migration:

```sql
-- ── Custom SQL: prisma migrate diff cannot regenerate any of this ──────────

ALTER TABLE "part_links" ADD CONSTRAINT "part_links_parent_xor"
  CHECK (("itemId" IS NULL) <> ("systemId" IS NULL));

-- Prisma emits a plain unique; replace it with the NULLS NOT DISTINCT form so
-- (part, item, NULL) duplicates are rejected.
DROP INDEX IF EXISTS "part_links_partId_itemId_systemId_key";
CREATE UNIQUE INDEX "part_links_partId_itemId_systemId_key"
  ON "part_links"("partId", "itemId", "systemId") NULLS NOT DISTINCT;

-- reminder_targets: replace the PAIRWISE form with the general one. Still
-- "at most one" — the standalone-chore relaxation must survive.
ALTER TABLE "reminder_targets" DROP CONSTRAINT "reminder_targets_parent_at_most_one";
ALTER TABLE "reminder_targets" ADD CONSTRAINT "reminder_targets_parent_at_most_one"
  CHECK (num_nonnulls("itemId", "systemId", "partId") <= 1);

-- service_record_targets: still exactly one.
ALTER TABLE "service_record_targets" DROP CONSTRAINT "service_record_targets_parent_xor";
ALTER TABLE "service_record_targets" ADD CONSTRAINT "service_record_targets_parent_xor"
  CHECK (num_nonnulls("itemId", "systemId", "partId") = 1);

DROP INDEX IF EXISTS "reminder_targets_reminderId_itemId_systemId_key";
DROP INDEX IF EXISTS "reminder_targets_reminder_item_system_part_key";
CREATE UNIQUE INDEX "reminder_targets_reminder_item_system_part_key"
  ON "reminder_targets"("reminderId","itemId","systemId","partId") NULLS NOT DISTINCT;

DROP INDEX IF EXISTS "service_record_targets_serviceRecordId_itemId_systemId_key";
DROP INDEX IF EXISTS "sr_targets_record_item_system_part_key";
CREATE UNIQUE INDEX "sr_targets_record_item_system_part_key"
  ON "service_record_targets"("serviceRecordId","itemId","systemId","partId") NULLS NOT DISTINCT;
```

`num_nonnulls(...)` replaces the existing pairwise `NOT (a AND b)` deliberately: that shape needs three clauses for three columns and more as columns are added.

- [ ] **Step 4: Apply and confirm no drift**

```bash
pnpm db:migrate reset --force   # dev DB is disposable
pnpm exec prisma migrate diff --from-schema-datamodel prisma/schema.prisma \
  --to-schema-datasource prisma/schema.prisma --exit-code
```

Expected: exit code 0 (no drift). A non-zero exit means the schema and the migration disagree — almost always a `map:` name mismatch from Task 1 Step 4.

- [ ] **Step 5: Commit**

```bash
git add prisma/
git commit -m "feat(parts): migration for parts, part_links, and 3-way target CHECKs"
git log --oneline -1
```

---

### Task 3: Constraint integration tests

These assert database behaviour that **cannot be tested with mocks**. They are the highest-value tests in this PR.

**Files:**
- Create: `tests/integration/parts-constraints.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration, todayCal } from './helpers';

let ctx: IntegrationContext;
let itemId: string;
let systemId: string;
let partId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  await ctx.prisma.category.upsert({
    where: { slug: 'hvac' },
    create: { slug: 'hvac', name: 'HVAC', sortOrder: 20 },
    update: {},
  });
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.partLink.deleteMany();
  await ctx.prisma.reminderTarget.deleteMany();
  await ctx.prisma.serviceRecordTarget.deleteMany();
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.part.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.system.deleteMany();

  const cat = await ctx.prisma.category.findUniqueOrThrow({ where: { slug: 'hvac' } });
  const item = await ctx.prisma.item.create({
    data: { name: 'Air handler', categoryId: cat.id },
  });
  itemId = item.id;
  const system = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
  systemId = system.id;
  const part = await ctx.prisma.part.create({
    data: { name: '20x25x1 MERV 11', kind: 'AIR_FILTER' },
  });
  partId = part.id;
});

describe('part_links constraints', () => {
  it('accepts a link to an item', async () => {
    const link = await ctx.prisma.partLink.create({ data: { partId, itemId } });
    expect(link.itemId).toBe(itemId);
  });

  it('rejects a link with both an item and a system', async () => {
    await expect(
      ctx.prisma.partLink.create({ data: { partId, itemId, systemId } }),
    ).rejects.toThrow(/part_links_parent_xor/);
  });

  it('rejects a link with neither an item nor a system', async () => {
    await expect(ctx.prisma.partLink.create({ data: { partId } })).rejects.toThrow(
      /part_links_parent_xor/,
    );
  });

  it('rejects a duplicate (part, item) link via NULLS NOT DISTINCT', async () => {
    await ctx.prisma.partLink.create({ data: { partId, itemId } });
    await expect(ctx.prisma.partLink.create({ data: { partId, itemId } })).rejects.toThrow();
  });

  it('allows a part with zero links — the standalone case', async () => {
    const orphan = await ctx.prisma.part.create({ data: { name: 'Generic BR30', kind: 'BULB' } });
    const links = await ctx.prisma.partLink.count({ where: { partId: orphan.id } });
    expect(links).toBe(0);
  });
});

describe('reminder_targets 3-way at-most-one', () => {
  async function makeReminder(kind: 'REMINDER' | 'CHORE') {
    return ctx.prisma.reminder.create({
      data: { title: 't', kind, recurrence: { freq: 'MONTHLY', interval: 1 }, notifyUserIds: [] },
    });
  }

  it('accepts a part-only target', async () => {
    const r = await makeReminder('REMINDER');
    const t = await ctx.prisma.reminderTarget.create({
      data: { reminderId: r.id, partId, nextDueOn: todayCal() },
    });
    expect(t.partId).toBe(partId);
  });

  it('rejects a target with both a part and an item', async () => {
    const r = await makeReminder('REMINDER');
    await expect(
      ctx.prisma.reminderTarget.create({
        data: { reminderId: r.id, partId, itemId, nextDueOn: todayCal() },
      }),
    ).rejects.toThrow(/reminder_targets_parent_at_most_one/);
  });

  it('still allows the standalone chore target with all three NULL', async () => {
    const r = await makeReminder('CHORE');
    const t = await ctx.prisma.reminderTarget.create({
      data: { reminderId: r.id, nextDueOn: todayCal() },
    });
    expect(t.itemId).toBeNull();
    expect(t.partId).toBeNull();
  });

  it('still rejects a duplicate (reminder, item) target after the unique rebuild', async () => {
    const r = await makeReminder('REMINDER');
    await ctx.prisma.reminderTarget.create({
      data: { reminderId: r.id, itemId, nextDueOn: todayCal() },
    });
    await expect(
      ctx.prisma.reminderTarget.create({
        data: { reminderId: r.id, itemId, nextDueOn: todayCal() },
      }),
    ).rejects.toThrow();
  });
});

describe('service_record_targets 3-way exactly-one', () => {
  async function makeRecord() {
    return ctx.prisma.serviceRecord.create({
      data: { summary: 'Filter change', performedOn: todayCal(), selfPerformed: true },
    });
  }

  it('accepts a part-only target', async () => {
    const sr = await makeRecord();
    const t = await ctx.prisma.serviceRecordTarget.create({
      data: { serviceRecordId: sr.id, partId },
    });
    expect(t.partId).toBe(partId);
  });

  it('rejects a target with all three NULL — unlike reminder_targets', async () => {
    const sr = await makeRecord();
    await expect(
      ctx.prisma.serviceRecordTarget.create({ data: { serviceRecordId: sr.id } }),
    ).rejects.toThrow(/service_record_targets_parent_xor/);
  });
});
```

- [ ] **Step 2: Run and confirm they pass**

Run: `pnpm exec vitest run tests/integration/parts-constraints.test.ts`
Expected: PASS. These test the migration written in Task 2, so they should be green immediately — if a rejection test *passes without an error message matching the constraint name*, the CHECK did not get created. Read the failure text, don't just check the exit code.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/parts-constraints.test.ts
git commit -m "test(parts): cover the 3-way CHECKs and NULLS NOT DISTINCT uniques"
git log --oneline -1
```

---

### Task 4: Split the target validation schemas

**Do not widen `targetSchema`.** It is imported by `lib/warranties/schema.ts:5` (via `targetsArraySchema`) and `lib/incoming-email/actions.ts:35`, whose tables keep their **two-way** XOR. Widening its refine would let a `{ partId }` payload pass Zod for a warranty, whose mapper then writes an all-NULL row that `warranty_targets_parent_xor` rejects at the database.

**Files:**
- Modify: `lib/targets/schema.ts`
- Test: `lib/targets/schema.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/targets/schema.test.ts`:

```ts
describe('partTargetSchema', () => {
  it('accepts a part-only target', () => {
    expect(partTargetSchema.safeParse({ partId: 'p1' }).success).toBe(true);
  });

  it('rejects two parents', () => {
    expect(partTargetSchema.safeParse({ partId: 'p1', itemId: 'i1' }).success).toBe(false);
  });

  it('rejects zero parents', () => {
    expect(partTargetSchema.safeParse({}).success).toBe(false);
  });
});

describe('targetSchema still rejects parts', () => {
  // Warranties and incoming email import this one and keep a two-way XOR.
  it('does not accept a partId payload', () => {
    expect(targetSchema.safeParse({ partId: 'p1' }).success).toBe(false);
  });
});

describe('toTargetInputs with part rows', () => {
  it('keeps a part-only row', () => {
    expect(toTargetInputs([{ itemId: null, systemId: null, partId: 'p1' }])).toEqual([
      { partId: 'p1' },
    ]);
  });

  it('still drops the standalone chore row where all three are null', () => {
    expect(toTargetInputs([{ itemId: null, systemId: null, partId: null }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run lib/targets/schema.test.ts`
Expected: FAIL — `partTargetSchema is not defined`.

- [ ] **Step 3: Implement**

Replace the body of `lib/targets/schema.ts`:

```ts
import { z } from 'zod';

/**
 * Item-XOR-System target. Consumed by warranties (`lib/warranties/schema.ts`)
 * and incoming email (`lib/incoming-email/actions.ts`), whose tables keep a
 * two-way XOR CHECK.
 *
 * Do NOT widen this to accept `partId`. A `{ partId }` payload would pass Zod
 * for a warranty, and its mapper would then write an all-NULL row that
 * `warranty_targets_parent_xor` rejects at the database. Reminders and service
 * records use `partTargetSchema` below instead.
 */
export const targetSchema = z
  .object({
    itemId: z.string().min(1).optional().nullable(),
    systemId: z.string().min(1).optional().nullable(),
  })
  .refine((t) => Boolean(t.itemId) !== Boolean(t.systemId), {
    message: 'exactly one of itemId / systemId must be set',
  });

export const targetsArraySchema = z.array(targetSchema).min(1);

export type TargetInput = z.infer<typeof targetSchema>;

/**
 * Item-XOR-System-XOR-Part target, for reminders and service records — the two
 * tables whose CHECK constraints now count three columns.
 *
 * Cardinality is NOT expressed here: a CHORE may submit an empty targets array
 * (`lib/reminders/schema.ts` uses `z.array(partTargetSchema)` with no `.min`),
 * and the standalone both-NULL row is minted by reconciliation, never submitted.
 */
export const partTargetSchema = z
  .object({
    itemId: z.string().min(1).optional().nullable(),
    systemId: z.string().min(1).optional().nullable(),
    partId: z.string().min(1).optional().nullable(),
  })
  .refine(
    (t) => [t.itemId, t.systemId, t.partId].filter(Boolean).length === 1,
    { message: 'exactly one of itemId / systemId / partId must be set' },
  );

export const partTargetsArraySchema = z.array(partTargetSchema).min(1);

export type PartTargetInput = z.infer<typeof partTargetSchema>;

/**
 * Convert persisted target rows into form inputs for editing.
 *
 * A standalone chore target carries NONE of the three parent columns. Such rows
 * must be dropped here (not mapped to `{ systemId: null }`) so the edit form
 * submits an empty targets list — `updateReminder` then reconciles a CHORE with
 * no links back to the standalone shape. Emitting an all-null row instead would
 * fail `partTargetSchema`'s refine and block every save of a standalone chore.
 *
 * The filter must test all THREE columns. Testing only itemId/systemId would
 * drop part rows from the edit form; the form would then submit without them
 * and `updateReminder`'s diff would delete them.
 */
export function toTargetInputs(
  rows: { itemId: string | null; systemId: string | null; partId: string | null }[],
): PartTargetInput[] {
  return rows
    .filter((t) => t.itemId !== null || t.systemId !== null || t.partId !== null)
    .map((t) => {
      if (t.itemId !== null) return { itemId: t.itemId };
      if (t.systemId !== null) return { systemId: t.systemId };
      return { partId: t.partId as string };
    });
}
```

- [ ] **Step 4: Point the two consumers at the new schema**

- `lib/reminders/schema.ts:151-152` — `remindersTargetsSchema` and `choresTargetsSchema` use `partTargetSchema`. Keep `.min(1)` on reminders only.
- `lib/service-records/schema.ts:10` — `serviceRecordTargetsSchema` uses `partTargetSchema`.

Leave `lib/warranties/schema.ts` and `lib/incoming-email/actions.ts` untouched.

- [ ] **Step 5: Run tests and typecheck**

```bash
pnpm exec vitest run lib/targets/schema.test.ts
pnpm typecheck
```

Expected: tests PASS. `typecheck` will surface every call site whose types no longer line up — that is the point; fix them in the following tasks.

- [ ] **Step 6: Commit**

```bash
git add lib/targets/schema.ts lib/targets/schema.test.ts lib/reminders/schema.ts lib/service-records/schema.ts
git commit -m "feat(parts): add partTargetSchema; keep targetSchema narrow for warranties"
git log --oneline -1
```

---

### Task 5: `expand.ts` dedupe keys

**Files:**
- Modify: `lib/targets/expand.ts`
- Test: `lib/targets/expand.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('does not collide a part target with a standalone key', () => {
  const seed = [{ partId: 'p1' }];
  const out = expandSystemSelection(seed, { id: 's1', items: [{ id: 'i1', archivedAt: null }] });
  expect(out).toContainEqual({ partId: 'p1' });
  expect(out).toContainEqual({ systemId: 's1' });
  expect(out).toContainEqual({ itemId: 'i1' });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run lib/targets/expand.test.ts`
Expected: FAIL — the seed key builder returns `s:undefined` for a part row, colliding with a real system target.

- [ ] **Step 3: Implement**

Change the key builder to cover all three, and keep the type as `PartTargetInput`:

```ts
const keyOf = (t: PartTargetInput) =>
  t.itemId ? `i:${t.itemId}` : t.systemId ? `s:${t.systemId}` : `p:${t.partId}`;
```

**Do not make a system selection expand to its parts.** Items are *components* of a system; parts are *consumed by* it. "Serviced the furnace" must not silently claim the filter was replaced.

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run lib/targets/expand.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/targets/expand.ts lib/targets/expand.test.ts
git commit -m "feat(parts): distinguish part targets in expand dedupe keys"
git log --oneline -1
```

---

### Task 6: Reminder actions — the data-loss trap

**This is the highest-risk task in the PR.** Read the whole section before editing anything.

`lib/reminders/actions.ts:228-239` currently splits existing rows like this:

```ts
const existingLinks = existing.targets.filter((t) => t.itemId !== null || t.systemId !== null);
const existingStandalone = existing.targets.find((t) => t.itemId === null && t.systemId === null);
```

A part-only row is `itemId === null && systemId === null`. So it is **excluded from `existingLinks` and matched as the standalone-chore sentinel**, then hard-deleted at `:289`. Every part target on a reminder would disappear on the next save, with no error.

**Files:**
- Modify: `lib/reminders/actions.ts`
- Create: `tests/integration/parts-target-reconciliation.test.ts`

- [ ] **Step 1: Write the failing integration tests**

```ts
// Part targets are structurally identical to the standalone-chore sentinel on
// (itemId, systemId). Every one of these tests fails against the unwidened
// reconciliation code, and each fails in a different way — read the messages.
describe('part target survives reconciliation', () => {
  it('survives a save that does not change targets', async () => {
    const created = await createReminder({
      title: 'Change filter',
      kind: 'REMINDER',
      recurrence: { freq: 'MONTHLY', interval: 1 },
      nextDueOn: todayCal(),
      targets: [{ partId }],
    });
    expect(created.ok).toBe(true);

    const id = (created as { data: { id: string } }).data.id;
    const before = await ctx.prisma.reminderTarget.findMany({ where: { reminderId: id } });
    expect(before).toHaveLength(1);
    expect(before[0]?.partId).toBe(partId);

    await updateReminder({
      id,
      title: 'Change filter',
      kind: 'REMINDER',
      recurrence: { freq: 'MONTHLY', interval: 1 },
      targets: [{ partId }],
    });

    const after = await ctx.prisma.reminderTarget.findMany({ where: { reminderId: id } });
    expect(after).toHaveLength(1);
    expect(after[0]?.partId).toBe(partId);
    expect(after[0]?.id).toBe(before[0]?.id);   // preserved, not deleted-and-recreated
  });

  it('keeps two distinct part targets on one reminder', async () => {
    const second = await ctx.prisma.part.create({ data: { name: 'Belt', kind: 'BELT' } });
    const created = await createReminder({
      title: 'Service',
      kind: 'REMINDER',
      recurrence: { freq: 'YEARLY', interval: 1 },
      nextDueOn: todayCal(),
      targets: [{ partId }, { partId: second.id }],
    });
    const id = (created as { data: { id: string } }).data.id;

    const rows = await ctx.prisma.reminderTarget.findMany({ where: { reminderId: id } });
    // Against the unwidened diff keys both collapse to "|" and one is dropped.
    expect(rows).toHaveLength(2);
  });

  it('replaces a chore standalone sentinel when a part target is added', async () => {
    const created = await createReminder({
      title: 'Sweep',
      kind: 'CHORE',
      recurrence: { freq: 'WEEKLY', interval: 1 },
      nextDueOn: todayCal(),
      targets: [],
    });
    const id = (created as { data: { id: string } }).data.id;
    const sentinel = await ctx.prisma.reminderTarget.findFirstOrThrow({
      where: { reminderId: id },
    });
    expect(sentinel.partId).toBeNull();

    await updateReminder({
      id,
      title: 'Sweep',
      kind: 'CHORE',
      recurrence: { freq: 'WEEKLY', interval: 1 },
      targets: [{ partId }],
    });

    const rows = await ctx.prisma.reminderTarget.findMany({ where: { reminderId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.partId).toBe(partId);
    // The sentinel is REPLACED, not preserved — the widened existingLinks makes
    // part rows links, and the standalone→links branch deletes the sentinel by
    // design, seeding the new link with its cadence.
    expect(rows[0]?.nextDueOn).toEqual(sentinel.nextDueOn);
  });
});

describe('completing a part-targeted reminder', () => {
  it('mirrors partId onto the auto-created ServiceRecordTarget', async () => {
    const created = await createReminder({
      title: 'Change filter',
      kind: 'REMINDER',
      recurrence: { freq: 'MONTHLY', interval: 1 },
      nextDueOn: todayCal(),
      autoCreateServiceRecord: true,
      targets: [{ partId }],
    });
    const id = (created as { data: { id: string } }).data.id;
    const target = await ctx.prisma.reminderTarget.findFirstOrThrow({ where: { reminderId: id } });

    // Against the unwidened code this THROWS: the mirrored row is all-NULL and
    // violates service_record_targets_parent_xor.
    const done = await completeReminder({ reminderId: id, targetId: target.id });
    expect(done.ok).toBe(true);

    const srTargets = await ctx.prisma.serviceRecordTarget.findMany();
    expect(srTargets).toHaveLength(1);
    expect(srTargets[0]?.partId).toBe(partId);
  });
});
```

Mock `auth()` the way the other integration suites that call server actions do — copy the pattern from `tests/integration/incoming-email-actions.test.ts`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run tests/integration/parts-target-reconciliation.test.ts`
Expected: all FAIL, in three distinct ways — a deleted target, a dropped duplicate, and a thrown CHECK violation.

- [ ] **Step 3: Widen the sentinel predicate and `existingLinks`**

```ts
const existingLinks = existing.targets.filter(
  (t) => t.itemId !== null || t.systemId !== null || t.partId !== null,
);
const existingStandalone = existing.targets.find(
  (t) => t.itemId === null && t.systemId === null && t.partId === null,
);
```

Update the invariant comment at `:230-236` too — it currently describes the sentinel as the only both-NULL shape, which is no longer what makes it unique.

- [ ] **Step 4: Extend all three diff keys in this file**

At `:274`, `:276`, and `:293`:

```ts
const key = (t: { itemId?: string | null; systemId?: string | null; partId?: string | null }) =>
  `${t.itemId ?? ''}|${t.systemId ?? ''}|${t.partId ?? ''}`;
```

- [ ] **Step 5: Extend the three Prisma selects — the step typecheck cannot enforce**

None of these currently selects `partId`:

- `lib/reminders/actions.ts:151-163` (the `updateReminder` fetch — note it also selects `lastCompletedOn` and `nextDueOn`, so don't diff against a literal `{ id, itemId, systemId }`)
- `:121-123` (the `createReminder` result select, which feeds `revalidateReminderPaths`)
- `:407` (the `completeReminder` fetch)

**`key()`'s parameter is structurally typed with optional fields, so widening the key expression compiles cleanly against rows that never selected `partId`.** Every persisted part row would then key to `"x||"` while its submitted counterpart keys to `"||p1"` — absent from `wantSet`, so it lands in `toDelete`. Green on `pnpm verify`, destroys data at runtime. There is no type error to catch this; the integration tests in Step 1 are the only guard.

- [ ] **Step 6: Pass `partId` through every create path**

- `createReminder`'s `targets.create` at `:113-118` — add `partId: t.partId ?? null`
- both the `createMany` and `create` calls in `updateReminder`'s branches
- `completeReminder`'s mirrored `ServiceRecordTarget` at `:474-477` — add `partId: target.partId ?? null`

A missed one inserts an all-NULL row and throws on the CHECK, so these fail loudly rather than silently.

- [ ] **Step 7: Teach `validateTargets` about parts**

In `lib/reminders/actions.ts:42-70`, add a part-existence check mirroring the item and system ones:

```ts
const partIds = targets.map((t) => t.partId).filter((v): v is string => Boolean(v));
if (partIds.length > 0) {
  const found = await prisma.part.findMany({
    where: { id: { in: partIds } },
    select: { id: true },
  });
  if (found.length !== new Set(partIds).size) return 'Part not found';
}
```

Also update the cardinality message at `:50` from `'Select at least one item or system'` to include parts. Without the existence check a bogus `partId` surfaces as a raw FK exception instead of a form error.

- [ ] **Step 8: Widen `revalidateReminderPaths`**

Its parameter type at `:29-31` is `{ itemId, systemId }[]`. Add `partId: string | null` and a `if (t.partId) revalidatePath(`/parts/${t.partId}`)` branch. The route does not exist until PR 1b; `revalidatePath` on an unknown path is harmless, and adding it now keeps the two PRs independent.

- [ ] **Step 9: Run the tests**

```bash
pnpm exec vitest run tests/integration/parts-target-reconciliation.test.ts
pnpm typecheck
```

Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add lib/reminders/actions.ts tests/integration/parts-target-reconciliation.test.ts
git commit -m "fix(reminders): stop reconciliation deleting part targets as chore sentinels"
git log --oneline -1
```

---

### Task 7: Service-record actions and the duplicated edit-page mapper

**Files:**
- Modify: `lib/service-records/actions.ts`
- Modify: `app/(app)/service/[id]/edit/page.tsx:28-30`

- [ ] **Step 1: Widen `targetsToCreateData`**

At `lib/service-records/actions.ts:43-48`, add `partId: t.partId ?? null`. Used by `createServiceRecord`; without it a part target inserts all-NULL and throws.

- [ ] **Step 2: Widen the diff key and its select**

- `:136-137` — the key gains `|${t.partId ?? ''}`
- `:131-133` — `serviceRecordTarget.findMany`'s select gains `partId: true`

Same typecheck blindness as Task 6 Step 5.

- [ ] **Step 3: Widen `validateTargets` and `revalidateForTargets`**

Mirror Task 6 Steps 7 and 8 in `lib/service-records/actions.ts:17-36`.

- [ ] **Step 4: Route the service edit page through the shared helper**

`app/(app)/service/[id]/edit/page.tsx:28-30` **duplicates `toTargetInputs` inline**:

```ts
const initialTargets: TargetInput[] = record.targets.map((t) =>
  t.itemId ? { itemId: t.itemId } : { systemId: t.systemId as string },
);
```

`toTargetInputs` has exactly one production caller (`app/(app)/reminders/[id]/edit/page.tsx:33`), so widening the helper does **not** fix service records. Left as-is a part row becomes `{ systemId: null }`, fails the refine or submits garbage, and `updateServiceRecord`'s diff deletes the part target — the same data loss, on the flagship furnace-filter path.

Replace it with `toTargetInputs(record.targets)`, and make sure the page's Prisma query selects `partId`. Routing it through the shared helper rather than widening it in place is deliberate: the duplication is what hid the bug.

- [ ] **Step 5: Verify**

```bash
pnpm typecheck
pnpm exec vitest run tests/integration/parts-target-reconciliation.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add lib/service-records/actions.ts "app/(app)/service/[id]/edit/page.tsx"
git commit -m "fix(service-records): support part targets; de-duplicate the edit-page mapper"
git log --oneline -1
```

---

### Task 8: Label rendering — eight sites

`item?.name ?? system?.name` is the second predicate a third column breaks. The pattern to grep is **not just that expression** — it is that expression *plus* every `kind: 'item' | 'system'` union and every `t.item` / `t.system` branch pair.

Each site needs a `part` branch **and** `part: { select: { id: true, name: true } }` added to the Prisma select that feeds it. A select without a render change shows nothing; a render change without a select is a type error.

- [ ] **Step 1: `components/targets/TargetsChips.tsx:36-63` — do this one first**

`resolve()` branches on `t.system` / `t.item` and its comment says a target with neither "renders nothing". It backs `ReminderTable`, `ServiceRecordTable` and `WarrantyTable`, so a part-targeted service record shows **no chip at all** in the main history table. Widen `Resolved.kind` to include `'part'`.

- [ ] **Step 2: The two byte-identical reminder label sites**

`app/(app)/dashboard/UpcomingRemindersCard.tsx:46` and `app/(app)/reminders/[id]/page.tsx:104-105`. Both fall through to `(unnamed target)` and both derive `kind: t.systemId ? 'system' : 'item'`, which mislabels a part as an item. Fix both identically.

- [ ] **Step 3: `components/reminders/MarkCompleteDialog.tsx:22`, `:122`**

Widen the `kind: 'item' | 'system'` union, or a part renders an "Item" badge.

- [ ] **Step 4: The notification email — requirement 3 depends on it**

`lib/email/templates/reminder.tsx:56-79` falls through to `label: '(no target)'` with `href: data.appUrl`. Its data comes from `worker/jobs/notify.ts:30-35`, which selects only `item`/`system` on `targets`. Part reminders are `kind: 'REMINDER'` and therefore **do** notify, so without this the "furnace filter is due in two weeks" email ships unlabelled and links to the app root. Fix the template *and* the worker select.

- [ ] **Step 5: Digests**

`lib/digests/queries.ts:41-47` falls through to `target: null`, indistinguishable from a standalone chore, so the digest names no target. Widen the `DigestTarget` type in `lib/digests/group.ts:8` and the query. Nothing in `lib/email/templates/digest.tsx` matches the grep — the work is in the queries and types.

- [ ] **Step 6: Search**

`lib/search/document.ts` — the service-record aggregation loop in `buildDocument` at `:296-304`, **plus its select at `:284-289`**. Note `:156-174` is the *service* case in `toDocument`, not reminders, and the reminder path's select at `:320-322` reads `item` only (it doesn't include system names today either) — so there is no reminder `targetNames` to fix.

- [ ] **Step 7: Embeddings**

`lib/embedding/canonicalize.ts:137` — `canonicalizeServiceRecord`'s `targetNames`. A part-targeted record's embedding would silently omit the target name, undercutting PR 3's retrieval goal. **`:161` (warranties) needs no change** — warranties never target parts.

- [ ] **Step 8: Two sites that need NO change — do not "fix" them**

- `app/api/calendar/[token]/route.ts` selects only `targets.nextDueOn` and renders no target names.
- `dropSystemCoveredItems` in `lib/reminders/target-coverage.ts` — a part row projects `{ systemId: null, itemSystemId: null }` and the existing `itemSystemId === null` guard already keeps it. It sits directly upstream of three of the sites above, so it will look suspicious.

- [ ] **Step 9: Update the two stale comments**

- `lib/targets/schema.ts:16-24` docblock (done in Task 4, verify)
- `app/(app)/reminders/[id]/edit/page.tsx:31`

Both describe the two-column invariant.

- [ ] **Step 10: Verify and commit**

```bash
pnpm verify
git add -A
git commit -m "feat(parts): render part target labels across all eight sites"
git log --oneline -1
```

---

### Task 9: Full verification

- [ ] **Step 1: Unit + integration + typecheck + lint**

```bash
pnpm verify
pnpm test:integration
```

- [ ] **Step 2: Confirm no migration drift**

```bash
pnpm exec prisma migrate diff --from-schema-datamodel prisma/schema.prisma \
  --to-schema-datasource prisma/schema.prisma --exit-code
```

Expected: exit 0.

- [ ] **Step 3: Confirm knip is clean**

Run: `pnpm lint:knip`

`partTargetsArraySchema` may be flagged as an unused export if nothing consumes it yet. If so, delete it rather than adding a knip ignore — `lib/reminders/schema.ts` composes its own `.min(1)` array, so the pre-built one may genuinely be dead. Speculative exports are exactly what knip exists to catch.

- [ ] **Step 4: Confirm the coverage floor still clears**

```bash
pnpm test:coverage
```

Never lower a threshold in `vitest.config.ts` to make this pass. The floor only ratchets up.

- [ ] **Step 5: Open the PR**

Follow the repo's PR workflow: push, `gh pr create`, watch the Sourcery review check and address its comments, then `gh pr merge --auto --squash`, then watch CI.

---

## What "done" looks like

- `parts` and `part_links` tables exist and are empty.
- A part can be a reminder target and a service-record target at the database level.
- No route, nav entry, form, or page references parts — **nothing user-visible ships.**
- The three CHECK constraints count three columns; both `NULLS NOT DISTINCT` uniques include `partId`.
- A part target survives a save, a second save, and a completion.
- `pnpm verify`, `pnpm test:integration`, `pnpm lint:knip` and `pnpm test:coverage` all pass.
