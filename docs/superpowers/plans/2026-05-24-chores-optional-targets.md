# Chores: Optional Item/System Targets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let chores be saved with 0 item/system links; reminders still require ≥1. Internally every chore still has exactly one `ReminderTarget` row to hold its schedule — when no links are picked, the row is a "standalone" target (both `itemId` and `systemId` NULL).

**Architecture:** Discriminated-union zod schema in `lib/reminders/schema.ts` chooses `min(0)` vs `min(1)` array validation by `kind`. The DB-level XOR CHECK on `reminder_targets` is relaxed to "at most one of itemId/systemId set." Server actions (`createReminder` / `updateReminder`) reconcile the standalone row in a single transaction. The shared `lib/targets/schema.ts` is untouched — service records / warranties / inbox link picking keep their strict rules.

**Tech Stack:** Prisma 7 + Postgres 18 (pgvector pg18 image), Zod, Next.js 15 server actions, RHF + zod resolver, Vitest 4, Playwright. See [project_overview](memory:project_overview) for the broader stack.

**Spec:** `docs/superpowers/specs/2026-05-24-chores-optional-targets-design.md`

---

## File Map

**Modify:**
- `lib/reminders/schema.ts` — add `remindersTargetsSchema` / `choresTargetsSchema`; rewrite `createReminderSchema` / `updateReminderSchema` as a discriminated union on `kind`.
- `lib/reminders/schema.test.ts` — add chore-with-0-targets cases; keep existing reminder cases.
- `lib/reminders/actions.ts` — reconcile standalone row in `createReminder` (~line 77) and `updateReminder` (~line 156); `validateTargets` (line 40) must allow both-NULL rows only when called from a chore code path.
- `components/reminders/ReminderForm.tsx` — drop the `targets.length === 0` gate (line 100) and the picker label/error copy when `isChore`.
- `prisma/migrations/<timestamp>_chore_targets_allow_unlinked/migration.sql` — new hand-written migration that swaps the CHECK.

**Create:**
- `tests/integration/reminders-chores-optional-targets.test.ts` — integration coverage for the create/update reconciliation.
- `tests/e2e/chores-no-link.spec.ts` — `@critical` e2e: create + complete a linkless chore.

**Verify only (no changes expected):**
- `lib/reminders/queries.ts`, `components/calendar/MonthGrid.tsx`, ICS feed (search for the chore output path), `worker/jobs/reminders-tick.ts`.

---

## Task 1: Reminder-local target validators (TDD)

**Files:**
- Modify: `lib/reminders/schema.ts`
- Test: `lib/reminders/schema.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `lib/reminders/schema.test.ts` inside `describe('createReminderSchema', …)`:

```ts
it('accepts a chore with zero targets', () => {
  const r = createReminderSchema.safeParse({
    title: 'Take out the trash',
    targets: [],
    recurrence: { kind: 'weekly', weekdays: [1], interval: 1 },
    nextDueOn: new Date(),
    kind: 'CHORE',
  });
  expect(r.success).toBe(true);
});

it('accepts a chore with one item target', () => {
  const r = createReminderSchema.safeParse({
    title: 'Run dishwasher cleaner',
    targets: [{ itemId: 'cuid-1' }],
    recurrence: { kind: 'interval', every: 30, unit: 'day' },
    nextDueOn: new Date(),
    kind: 'CHORE',
  });
  expect(r.success).toBe(true);
});

it('rejects a reminder with zero targets (existing rule preserved)', () => {
  const r = createReminderSchema.safeParse({
    title: 'HVAC filter',
    targets: [],
    recurrence: { kind: 'interval', every: 60, unit: 'day' },
    nextDueOn: new Date(),
    kind: 'REMINDER',
  });
  expect(r.success).toBe(false);
});

it('rejects a reminder with zero targets when kind is omitted (defaults to REMINDER)', () => {
  const r = createReminderSchema.safeParse({
    title: 'HVAC filter',
    targets: [],
    recurrence: { kind: 'interval', every: 60, unit: 'day' },
    nextDueOn: new Date(),
  });
  expect(r.success).toBe(false);
});
```

Also add to `describe('updateReminderSchema', …)` (create the describe block if it doesn't exist):

```ts
describe('updateReminderSchema', () => {
  it('accepts a chore update with empty targets', () => {
    const r = updateReminderSchema.safeParse({
      id: 'cuid-r',
      targets: [],
      kind: 'CHORE',
    });
    expect(r.success).toBe(true);
  });

  it('rejects a reminder update that supplies empty targets', () => {
    const r = updateReminderSchema.safeParse({
      id: 'cuid-r',
      targets: [],
      kind: 'REMINDER',
    });
    expect(r.success).toBe(false);
  });

  it('still allows an update that omits targets entirely (no targets change)', () => {
    const r = updateReminderSchema.safeParse({
      id: 'cuid-r',
      title: 'Renamed',
    });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the failing tests**

```bash
pnpm vitest run lib/reminders/schema.test.ts
```

Expected: the new chore-with-zero-targets cases **FAIL** (existing `targetsArraySchema = z.array(...).min(1)` rejects them); the "rejects empty targets" cases pass already.

- [ ] **Step 3: Implement the split + discriminated union**

In `lib/reminders/schema.ts`:

1. Remove the top-level import of `targetsArraySchema`; instead import `targetSchema`:
   ```ts
   import { targetSchema } from '@/lib/targets/schema';
   ```
2. Below the existing imports (above `recurrenceSchema`), define the two reminder-local array schemas:
   ```ts
   // Reminder-specific cardinality. Reminders require ≥1 item/system link
   // (they're asset-centric and notify the user). Chores may have 0..N links
   // (task-centric; a linkless chore gets a "standalone" ReminderTarget row
   // created server-side — see lib/reminders/actions.ts reconciliation).
   const remindersTargetsSchema = z.array(targetSchema).min(1);
   const choresTargetsSchema = z.array(targetSchema);
   ```
3. Replace the existing `createReminderSchema` / `updateReminderSchema` exports with a discriminated union, keeping every other field unchanged:
   ```ts
   const baseReminderShape = {
     title: z.string().min(1).max(200),
     description: z.string().max(20_000).optional().or(z.literal('')),
     recurrence: recurrenceSchema,
     nextDueOn: z.coerce.date(),
     leadTimeDays: z.number().int().min(0).max(365).default(3),
     autoCreateServiceRecord: z.boolean().default(false),
     notifyUserIds: z.array(z.string().min(1)).optional(),
   } as const;

   export const createReminderSchema = z.discriminatedUnion('kind', [
     z.object({
       ...baseReminderShape,
       kind: z.literal('REMINDER'),
       targets: remindersTargetsSchema,
     }),
     z.object({
       ...baseReminderShape,
       kind: z.literal('CHORE'),
       targets: choresTargetsSchema,
     }),
   ]);

   // `kind` MUST be supplied so the union can resolve. The form already passes
   // it on every submit; the old `.default('REMINDER')` is intentionally dropped
   // because a discriminator can't default — callers that omit `kind` (legacy
   // tests) must now pass it explicitly.
   export type CreateReminderInput = z.infer<typeof createReminderSchema>;
   ```

   For updates we keep the "kind optional, but if `targets` is supplied it must obey the kind's rule" contract. Easiest shape:
   ```ts
   export const updateReminderSchema = z.discriminatedUnion('kind', [
     z.object({
       id: z.string().min(1),
       kind: z.literal('REMINDER'),
       targets: remindersTargetsSchema.optional(),
       active: z.boolean().optional(),
       ...partialOf(baseReminderShape),
     }),
     z.object({
       id: z.string().min(1),
       kind: z.literal('CHORE'),
       targets: choresTargetsSchema.optional(),
       active: z.boolean().optional(),
       ...partialOf(baseReminderShape),
     }),
     // Updates that don't touch kind or targets keep working without re-stating
     // them. We model that as a third variant with `kind: undefined`.
     z.object({
       id: z.string().min(1),
       kind: z.undefined().optional(),
       targets: z.undefined().optional(),
       active: z.boolean().optional(),
       ...partialOf(baseReminderShape),
     }),
   ]);
   ```

   Add a tiny helper at the top of the file (above the schemas):
   ```ts
   // .partial() on an object schema; here we map each ZodType to `.optional()`
   // so we can spread the partial shape into other objects without losing the
   // discriminator field.
   function partialOf<T extends Record<string, z.ZodTypeAny>>(shape: T) {
     return Object.fromEntries(
       Object.entries(shape).map(([k, v]) => [k, v.optional()]),
     ) as { [K in keyof T]: z.ZodOptional<T[K]> };
   }
   ```

   > **Why a 3-variant union for updates:** zod's discriminated union requires the discriminator to be present on every variant. Real callers either supply `kind` (form submit) or don't (e.g. `setReminderActive` partial). The third `kind: z.undefined()` variant lets the no-kind path keep working without forcing every caller to thread `kind` through.

   > **Field-default drop:** the previous `createReminderSchema` had `kind: …default('REMINDER')`. We can't do that inside a discriminator. If grep finds any remaining call sites that omit `kind`, fix them in this task by passing `kind: 'REMINDER'` explicitly — don't reintroduce the default.

4. Update `lib/reminders/schema.test.ts` legacy cases that omit `kind` to pass `kind: 'REMINDER'` explicitly. The existing "rejects missing title" / valid-reminder cases should be updated, not removed.

- [ ] **Step 4: Run the tests, confirm green**

```bash
pnpm vitest run lib/reminders/schema.test.ts
```

Expected: all tests **PASS** (new and pre-existing).

- [ ] **Step 5: Typecheck the whole repo (catches downstream `kind` consumers)**

```bash
pnpm typecheck
```

Expected: PASS. If `lib/reminders/actions.ts` errors out because it destructured `parsed.data.targets` unconditionally, leave it — Task 3 rewrites it. If errors point elsewhere (e.g. inbox auto-stub, suggest), fix the call site to supply `kind: 'REMINDER'`.

- [ ] **Step 6: Commit**

```bash
git add lib/reminders/schema.ts lib/reminders/schema.test.ts
git commit -m "feat(reminders): discriminated-union schema — chores allow 0 targets"
```

---

## Task 2: Postgres migration — relax XOR CHECK

**Files:**
- Create: `prisma/migrations/<timestamp>_chore_targets_allow_unlinked/migration.sql`

The current constraint at `prisma/migrations/000000000000_squashed_migrations/migration.sql:755-756` is:

```sql
ALTER TABLE "reminder_targets"
  ADD CONSTRAINT "reminder_targets_parent_xor"
  CHECK (("itemId" IS NULL) <> ("systemId" IS NULL));
```

Replace it with an "at most one set" constraint. See [feedback_prisma_migration_drift](memory:feedback_prisma_migration_drift) — hand-write this migration so `prisma migrate dev` doesn't try to autogenerate it and drop the surrounding pgvector indexes.

- [ ] **Step 1: Create the migration directory and file**

Use the current UTC timestamp in YYYYMMDDHHMMSS form. The directory name MUST be `<timestamp>_chore_targets_allow_unlinked` and the file MUST be `migration.sql`.

```bash
TS=$(date -u +%Y%m%d%H%M%S)
mkdir -p "prisma/migrations/${TS}_chore_targets_allow_unlinked"
touch "prisma/migrations/${TS}_chore_targets_allow_unlinked/migration.sql"
```

Write into that `migration.sql`:

```sql
-- Chores may have zero item/system links. The previous XOR constraint
-- enforced "exactly one set"; relax to "at most one set" so a chore can
-- own a single standalone ReminderTarget (both itemId and systemId NULL)
-- to carry its schedule + completion history.
--
-- The NULLS NOT DISTINCT unique on (reminderId, itemId, systemId) already
-- caps standalone rows at one per reminder.
--
-- "Only CHORE parents may own a both-NULL row" is enforced in the server
-- (lib/reminders/actions.ts reconciliation + lib/reminders/schema.ts
-- discriminated union), not via a cross-table trigger.

ALTER TABLE "reminder_targets" DROP CONSTRAINT "reminder_targets_parent_xor";

ALTER TABLE "reminder_targets"
  ADD CONSTRAINT "reminder_targets_parent_at_most_one"
  CHECK (NOT ("itemId" IS NOT NULL AND "systemId" IS NOT NULL));
```

- [ ] **Step 2: Apply the migration to the dev DB**

```bash
pnpm prisma migrate dev
```

Expected: applies cleanly; no schema drift warnings; no other migrations queued. If anything blocks, see [feedback_dev_db_disposable](memory:feedback_dev_db_disposable) — reset + reseed rather than doing checksum surgery.

- [ ] **Step 3: Smoke-test the new constraint at the DB level**

```bash
pnpm prisma studio &  # optional, for eyes-on
```

Or via `psql` / a short script — verify by hand:

```sql
-- Should SUCCEED (both NULL, a standalone)
INSERT INTO "reminder_targets" (id, "reminderId", "nextDueOn") VALUES ('test-standalone', '<some-existing-reminder-id>', NOW());

-- Should FAIL with check violation
INSERT INTO "reminder_targets" (id, "reminderId", "itemId", "systemId", "nextDueOn") VALUES ('test-both', '<reminder-id>', '<item-id>', '<system-id>', NOW());

-- Clean up
DELETE FROM "reminder_targets" WHERE id IN ('test-standalone','test-both');
```

(Integration tests in Task 3 also cover this; this step is a sanity check before wiring code.)

- [ ] **Step 4: Commit**

```bash
git add prisma/migrations/
git commit -m "feat(db): relax reminder_targets XOR to at-most-one (chore standalone rows)"
```

---

## Task 3: Server-side reconciliation in `createReminder` / `updateReminder` (TDD)

**Files:**
- Modify: `lib/reminders/actions.ts` (lines ~40, ~61, ~105)
- Create: `tests/integration/reminders-chores-optional-targets.test.ts`

The reconciliation rules from the spec (see "Server-side reconciliation" + the link↔standalone transitions). Recap:

- `kind=CHORE`, submitted targets has ≥1 link → no standalone; delete any pre-existing standalone.
- `kind=CHORE`, submitted targets is `[]` → ensure exactly one standalone exists; if links existed before, inherit schedule from the most-recently-completed link (or earliest-due link if none completed) before deleting them.
- Standalone → links: standalone's `lastCompletedOn` / `nextDueOn` seed every new link row, then standalone is deleted.
- `kind=REMINDER`: unchanged.

- [ ] **Step 1: Write failing integration tests**

Create `tests/integration/reminders-chores-optional-targets.test.ts`. Match the project's existing integration-test style (see `tests/integration/reminders-auth.test.ts` for the auth/session mocking conventions). Cases:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
// ... project's standard test bootstrap (db reset / session mock)

describe('chore reconciliation', () => {
  it('creates exactly one standalone ReminderTarget when chore has no links', async () => {
    const r = await createReminder({
      title: 'Trash day',
      kind: 'CHORE',
      targets: [],
      recurrence: { kind: 'weekly', weekdays: [1], interval: 1 },
      nextDueOn: new Date('2026-06-01'),
    });
    expect(r.ok).toBe(true);
    const targets = await prisma.reminderTarget.findMany({ where: { reminderId: r.data!.id } });
    expect(targets).toHaveLength(1);
    expect(targets[0].itemId).toBeNull();
    expect(targets[0].systemId).toBeNull();
  });

  it('creates only link rows (no standalone) when chore has ≥1 link', async () => {
    const item = await seedItem();
    const r = await createReminder({
      title: 'Wipe down dishwasher',
      kind: 'CHORE',
      targets: [{ itemId: item.id }],
      recurrence: { kind: 'interval', every: 30, unit: 'day' },
      nextDueOn: new Date('2026-06-01'),
    });
    const targets = await prisma.reminderTarget.findMany({ where: { reminderId: r.data!.id } });
    expect(targets).toHaveLength(1);
    expect(targets[0].itemId).toBe(item.id);
  });

  it('transitions chore from links → standalone, inheriting schedule from most-recently-completed link', async () => {
    const item = await seedItem();
    const r = await createReminder({
      title: 'Y',
      kind: 'CHORE',
      targets: [{ itemId: item.id }],
      recurrence: { kind: 'interval', every: 30, unit: 'day' },
      nextDueOn: new Date('2026-06-01'),
    });
    // Simulate a completion so lastCompletedOn is non-null on the link row.
    await completeReminder({ id: r.data!.id });

    await updateReminder({ id: r.data!.id, kind: 'CHORE', targets: [] });

    const targets = await prisma.reminderTarget.findMany({ where: { reminderId: r.data!.id } });
    expect(targets).toHaveLength(1);
    expect(targets[0].itemId).toBeNull();
    expect(targets[0].systemId).toBeNull();
    expect(targets[0].lastCompletedOn).not.toBeNull();
  });

  it('transitions chore from standalone → links, seeding link rows with standalone schedule', async () => {
    const r = await createReminder({
      title: 'Z',
      kind: 'CHORE',
      targets: [],
      recurrence: { kind: 'interval', every: 30, unit: 'day' },
      nextDueOn: new Date('2026-06-01'),
    });
    const item = await seedItem();
    await updateReminder({ id: r.data!.id, kind: 'CHORE', targets: [{ itemId: item.id }] });

    const targets = await prisma.reminderTarget.findMany({ where: { reminderId: r.data!.id } });
    expect(targets).toHaveLength(1);
    expect(targets[0].itemId).toBe(item.id);
    expect(targets[0].nextDueOn).toEqual(new Date('2026-06-01'));
  });

  it('rejects a REMINDER create with empty targets (existing rule preserved)', async () => {
    const r = await createReminder({
      title: 'A',
      kind: 'REMINDER',
      targets: [],
      recurrence: { kind: 'interval', every: 60, unit: 'day' },
      nextDueOn: new Date(),
    });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the failing tests**

```bash
pnpm vitest run tests/integration/reminders-chores-optional-targets.test.ts
```

Expected: chore-with-zero-targets cases **FAIL** (server still requires ≥1).

- [ ] **Step 3: Update `validateTargets`**

In `lib/reminders/actions.ts`, change the signature so callers pass `kind`:

```ts
async function validateTargets(
  targets: TargetInput[],
  kind: 'REMINDER' | 'CHORE',
): Promise<string | null> {
  if (kind === 'REMINDER' && targets.length === 0) {
    return 'Select at least one item or system';
  }
  // existing ownership-check logic continues below, but skip the "must have ≥1"
  // assumption it implicitly relies on — empty targets is now valid for chores.
  // ...
}
```

Update both call sites in the file (lines ~74 and ~132) to pass `parsed.data.kind ?? 'REMINDER'`.

- [ ] **Step 4: Implement create reconciliation**

In `createReminder` (around line 77), replace the `targets: { create: targets.map(...) }` block with:

```ts
const reconciledTargets =
  parsed.data.kind === 'CHORE' && targets.length === 0
    ? [{ itemId: null, systemId: null }] // standalone
    : targets;

const reminder = await prisma.reminder.create({
  data: {
    ...rest,
    recurrence: withWeeklyAnchor(recurrence, nextDueOn),
    description: description || null,
    notifyUserIds: notifyUserIds && notifyUserIds.length > 0 ? notifyUserIds : [session.user.id],
    targets: {
      create: reconciledTargets.map((t) => ({
        itemId: t.itemId ?? null,
        systemId: t.systemId ?? null,
        nextDueOn,
      })),
    },
  },
  select: { id: true, targets: { select: { itemId: true, systemId: true } } },
});
```

- [ ] **Step 5: Expand the `findFirst` select**

Before writing the transition logic, expand the existing `findFirst` at `lib/reminders/actions.ts:122-128` so the reconciliation code can read `kind` off the parent and `lastCompletedOn` / `nextDueOn` off each target:

```ts
const existing = await prisma.reminder.findFirst({
  where: ownedReminderWhere(id, session.user.id),
  select: {
    id: true,
    kind: true, // NEW — used to detect chore-vs-reminder when input omits kind
    targets: {
      select: {
        id: true,
        itemId: true,
        systemId: true,
        lastCompletedOn: true, // NEW — needed for links→standalone seed inheritance
        nextDueOn: true,        // NEW — same
      },
    },
  },
});
```

The targets array is small (a handful of rows per reminder); fetching two extra timestamp columns is fine.

- [ ] **Step 6: Implement update reconciliation**

In `updateReminder` (transaction starting line 156), the existing `toAdd`/`toDelete` diff stays for the simple "links → links" case. Add transition handling **before** the diff. Inside the `if (targets !== undefined)` branch within the transaction:

```ts
const isChore = (parsed.data.kind ?? existingKind) === 'CHORE';
//                                  ^^^^^^^^^^^^^
// fetch `existing.kind` in the earlier findFirst (add `kind: true` to the select)

const submittedLinks = targets; // user-submitted; guaranteed link-only by zod (no both-NULL rows from form)
const existingLinks = existing.targets.filter((t) => t.itemId !== null || t.systemId !== null);
const existingStandalone = existing.targets.find((t) => t.itemId === null && t.systemId === null);

if (isChore && submittedLinks.length === 0) {
  // → standalone shape
  if (!existingStandalone) {
    // inherit schedule from the most-recently-completed link (else earliest-due)
    const seed = existingLinks
      .slice()
      .sort((a, b) => {
        const ac = a.lastCompletedOn?.getTime() ?? -Infinity;
        const bc = b.lastCompletedOn?.getTime() ?? -Infinity;
        if (ac !== bc) return bc - ac; // most recent first
        return a.nextDueOn.getTime() - b.nextDueOn.getTime(); // else earliest due
      })[0];
    await tx.reminderTarget.create({
      data: {
        reminderId: id,
        itemId: null,
        systemId: null,
        lastCompletedOn: seed?.lastCompletedOn ?? null,
        nextDueOn: seed?.nextDueOn ?? nextDueOn ?? new Date(),
      },
    });
  }
  if (existingLinks.length > 0) {
    await tx.reminderTarget.deleteMany({
      where: { id: { in: existingLinks.map((l) => l.id) } },
    });
  }
} else {
  // → linked shape (REMINDER always lands here; CHORE with ≥1 link too)
  if (existingStandalone) {
    // seed every newly inserted link with the standalone's schedule, then drop standalone
    const seedNext = existingStandalone.nextDueOn;
    const seedLast = existingStandalone.lastCompletedOn;
    const haveKey = new Set(existingLinks.map((t) => `${t.itemId ?? ''}|${t.systemId ?? ''}`));
    const toAdd = submittedLinks.filter(
      (t) => !haveKey.has(`${t.itemId ?? ''}|${t.systemId ?? ''}`),
    );
    if (toAdd.length > 0) {
      await tx.reminderTarget.createMany({
        data: toAdd.map((t) => ({
          reminderId: id,
          itemId: t.itemId ?? null,
          systemId: t.systemId ?? null,
          nextDueOn: seedNext,
          lastCompletedOn: seedLast,
        })),
      });
    }
    await tx.reminderTarget.delete({ where: { id: existingStandalone.id } });
  } else {
    // Links → links (no standalone in play). This branch IS the only path
    // that runs the existing add/remove diff — the standalone-present case
    // is fully handled above. Inline (don't call out to) the existing diff
    // logic here, using `submittedLinks` in place of the old `targets`:
    const key = (t: { itemId?: string | null; systemId?: string | null }) =>
      `${t.itemId ?? ''}|${t.systemId ?? ''}`;
    const wantSet = new Set(submittedLinks.map(key));
    const haveSet = new Set(existingLinks.map(key));

    const toDelete = existingLinks.filter((e) => !wantSet.has(key(e))).map((e) => e.id);
    const toAdd = submittedLinks.filter((t) => !haveSet.has(key(t)));

    if (toDelete.length > 0) {
      await tx.reminderTarget.deleteMany({ where: { id: { in: toDelete } } });
    }
    if (toAdd.length > 0) {
      let seedNextDueOn = nextDueOn;
      if (!seedNextDueOn) {
        const anyExisting = await tx.reminderTarget.findFirst({
          where: { reminderId: id },
          orderBy: { nextDueOn: 'asc' },
          select: { nextDueOn: true },
        });
        seedNextDueOn = anyExisting?.nextDueOn ?? new Date();
      }
      await tx.reminderTarget.createMany({
        data: toAdd.map((t) => ({
          reminderId: id,
          itemId: t.itemId ?? null,
          systemId: t.systemId ?? null,
          nextDueOn: seedNextDueOn,
        })),
      });
    }
  }
}
```

> **Important:** delete the original lines ~159-191 diff block when adding this. The new structure has TWO exclusive paths:
> 1. Standalone exists → standalone→links logic (above) runs the only insert/delete
> 2. No standalone exists → the inlined "links → links" diff (above) runs
>
> The original block must not survive — leaving it would double-run on either path. The transaction boundary stays as-is.

Also bind `const existingKind = existing.kind` near the top of the function for use in the `isChore` derivation.

- [ ] **Step 7: Run integration tests, confirm green**

```bash
pnpm vitest run tests/integration/reminders-chores-optional-targets.test.ts
pnpm vitest run lib/reminders/schema.test.ts
```

Expected: PASS for both.

- [ ] **Step 8: Run full unit + integration suite to catch regressions**

```bash
pnpm test:local
```

Expected: PASS. Pay attention to any test that previously relied on `kind` defaulting — fix the call site to pass it explicitly (see [project_testing_strategy_status](memory:project_testing_strategy_status) for tag conventions; tag any new `@critical` cases).

- [ ] **Step 9: Commit**

```bash
git add lib/reminders/actions.ts tests/integration/reminders-chores-optional-targets.test.ts
git commit -m "feat(reminders): server reconciles standalone target row for linkless chores"
```

---

## Task 4: Form — drop the chore targets gate

**Files:**
- Modify: `components/reminders/ReminderForm.tsx` (lines 100, 168, 175)

- [ ] **Step 1: Make the empty-targets gate kind-aware**

In `components/reminders/ReminderForm.tsx`, around line 99:

```ts
const onSubmit = handleSubmit((data) => {
  if (!isChore && targets.length === 0) {
    setTargetsError('Select at least one item or system');
    return;
  }
  setTargetsError(null);
  // ... rest unchanged
});
```

- [ ] **Step 2: Swap the picker label for chores**

Line 168 — replace the static `<FormLabel>Targets</FormLabel>` with:

```tsx
<FormLabel>{isChore ? 'Linked items / systems (optional)' : 'Targets'}</FormLabel>
```

No other form copy needs changing. The `handleTargetsChange` clearing logic (line 127) is fine — for chores it just never sees a non-empty `targetsError` in the first place.

- [ ] **Step 3: Manual smoke test in the dev server**

Per the project's UI-changes rule (run the dev server before reporting done):

```bash
pnpm dev
```

- Open `/chores/new`, fill title + recurrence, leave targets empty → submit. Should succeed and route to `/reminders/<id>`.
- Open the same chore's edit page, add an item link, save → should succeed; verify in Studio the standalone row is gone and the link row exists.
- Remove the link, save again → standalone row reappears; `nextDueOn` is preserved.
- Open `/reminders/new`, leave targets empty → submit. Should show the existing "Select at least one…" inline error (regression guard).

- [ ] **Step 4: Commit**

```bash
git add components/reminders/ReminderForm.tsx
git commit -m "feat(ui): chores allow empty targets in ReminderForm"
```

---

## Task 5: Verify read paths render linkless chores cleanly

**Files:**
- Verify only: `lib/reminders/queries.ts`, `components/calendar/MonthGrid.tsx`, ICS feed handler, `worker/jobs/reminders-tick.ts`.

For each, the question is: does it crash, omit, or weirdly render a chore target with both `itemId` and `systemId` NULL?

- [ ] **Step 1: Reminders listing (`/chores`, `/reminders`)**

```bash
grep -n "ReminderTarget\|target\.item\|target\.system" lib/reminders/queries.ts
```

For every place that resolves an item or system name off a target, confirm the fallback path (just show the reminder title) works. If a JOIN/`include` would NPE on the chore page because it dereferences `.item.name` or `.system.name` without a `??`, fix that specific access — but do NOT add a "null target" filter that would hide standalone rows.

- [ ] **Step 2: Calendar (`components/calendar/MonthGrid.tsx`)**

Open `/reminders/calendar`. Chores with no link should appear with just their title and no item/system badge.

- [ ] **Step 3: ICS export feed**

The handler is `app/api/calendar/[token]/route.ts` (completion-aware behavior was added in [project_ics_completion_feed_status](memory:project_ics_completion_feed_status)). Open the export URL from `/settings` (logged in) and confirm a linkless chore appears as a `VEVENT` with `SUMMARY` = chore title and no "for <Item>" tail in the description / summary.

- [ ] **Step 4: Worker (sanity only)**

```bash
grep -n "kind\|CHORE" worker/jobs/reminders-tick.ts
```

Confirm the existing `kind !== 'CHORE'` filter is still in place. No code change expected.

- [ ] **Step 5: Commit any small fixes found**

Only commit if you actually changed something. If everything renders cleanly, this task ends with no commit and a note in the PR description that these paths were verified.

```bash
# Only if a small fix was needed:
git add <changed-files>
git commit -m "fix(<area>): handle null itemId+systemId on chore standalone target"
```

---

## Task 6: E2E happy path for a linkless chore

**Files:**
- Create: `tests/e2e/chores-no-link.spec.ts`

Tag this `@critical` per [project_testing_strategy_status](memory:project_testing_strategy_status).

- [ ] **Step 1: Write the e2e spec**

```ts
import { test, expect } from '@playwright/test';
import { loginAs } from './_helpers/login'; // existing helper, mirror sibling specs

test.describe('chores @critical', () => {
  test('create a linkless chore and complete it once', async ({ page }) => {
    await loginAs(page);

    await page.goto('/chores/new');
    await page.getByLabel('Title').fill('Sharpen the kitchen knife');
    // pick a simple weekly recurrence; the form's defaults should already
    // populate `nextDueOn` to today/tomorrow — adjust to whatever the form
    // requires per existing chore-creation specs in tests/e2e/.
    await page.getByRole('button', { name: /save|create/i }).click();

    // Lands on the detail page
    await expect(page).toHaveURL(/\/reminders\/[a-z0-9]+$/);
    await expect(page.getByRole('heading', { name: 'Sharpen the kitchen knife' })).toBeVisible();

    // Complete it
    await page.getByRole('button', { name: /mark.*complete|complete/i }).click();

    // The chore should remain on the page with an advanced nextDueOn (recurrence: weekly)
    await expect(page.getByText(/next due|next:/i)).toBeVisible();
  });
});
```

> Mirror an existing `tests/e2e/*.spec.ts` for exact selectors and `loginAs` import path. Check `tests/e2e/_routes.ts` for any helper around the chores route.

- [ ] **Step 2: Run the e2e spec**

```bash
pnpm playwright test tests/e2e/chores-no-link.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Run the @critical e2e subset to confirm no regressions**

```bash
pnpm playwright test --grep @critical
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/chores-no-link.spec.ts
git commit -m "test(e2e): linkless chore create + complete @critical"
```

---

## Task 7: Final checks + open PR

- [ ] **Step 1: Full pre-push gate**

```bash
pnpm lint && pnpm typecheck && pnpm test:local
```

Expected: PASS. Per [feedback_knip_pre_push](memory:feedback_knip_pre_push), `knip` runs on push — make sure no exports were left unused. Per [feedback_no_verify](memory:feedback_no_verify), do NOT pass `--no-verify` to git.

- [ ] **Step 2: Push branch and open PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(chores): optional item/system links" --body "$(cat <<'EOF'
## Summary
- Chores can be saved with zero item/system links (reminders still require ≥1).
- Linkless chores still get exactly one `ReminderTarget` row (both `itemId` and `systemId` NULL) so the existing worker/completion/calendar/ICS paths are unchanged.
- DB-level XOR CHECK relaxed to "at most one of itemId/systemId set"; cross-table "only chores may be both-NULL" rule lives in the zod discriminated union + server reconciliation.

Spec: `docs/superpowers/specs/2026-05-24-chores-optional-targets-design.md`

## Test plan
- [ ] `pnpm vitest run lib/reminders/schema.test.ts`
- [ ] `pnpm vitest run tests/integration/reminders-chores-optional-targets.test.ts`
- [ ] `pnpm playwright test --grep @critical`
- [ ] Manually: create a linkless chore via `/chores/new`, complete it, verify recurrence advances
- [ ] Manually: edit the chore to add an item link, save, then remove the link — schedule continuity preserved
- [ ] Manually: `/reminders/new` with no targets still shows the inline "Select at least one…" error
EOF
)"
```

---

## Risks & non-goals

- **Cross-table integrity not DB-enforced.** A direct SQL `INSERT` outside the app can create a both-NULL target on a `REMINDER`. Accepted per spec; mitigation is the zod discriminated union on every write path.
- **Backfill not performed.** Existing chores keep their links per the design call. Users wanting to "unlink" a chore must edit + save it manually.
- **Search reindex.** `enqueueSearchIndex('reminder', …)` is already called on every write path; no change. Meilisearch can index a chore with no link — verify the Meili document doesn't omit the chore because of a missing target field. See [feedback_patterns_gotchas](memory:feedback_patterns_gotchas) and `lib/search/` for the indexer shape if anything looks off.
