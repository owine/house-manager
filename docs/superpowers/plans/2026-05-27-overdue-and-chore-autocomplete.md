# Overdue Redefinition & Chore Auto-Complete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redefine "overdue" as "due-date strictly before today in the house tz" and add an opt-in `autoComplete` flag on chores that auto-closes them at end of due day.

**Architecture:** A single `isOverdue(date, now, tz)` helper in `lib/time/tz.ts` becomes the canonical source of truth for the overdue boundary, replacing three divergent call-site implementations. A companion `endOfDayInTz(date, tz)` lets the new `chore-auto-complete-tick` worker stamp `completedOn` at the last instant of the due day. Auto-completes write real `ReminderCompletion` rows attributed to a seeded sentinel user, reusing the same `computeNextDueOn` advance helper as manual completion so behavior stays consistent.

**Tech Stack:** Next.js (server actions), Prisma 7 + Postgres, Zod, pg-boss workers, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-05-27-overdue-and-chore-autocomplete-design.md`

---

## File Structure

**Schema / data:**
- Modify: `prisma/schema.prisma` — add `HouseProfile.timezone`, `Reminder.autoComplete`
- Create: `prisma/migrations/<ts>_overdue_and_autocomplete/migration.sql`
- Modify: `prisma/seed.ts` — upsert sentinel `system-auto-complete` user

**Library:**
- Modify: `lib/time/tz.ts` — add `isOverdue`, `endOfDayInTz`
- Create: `lib/time/tz.test.ts` — unit tests
- Modify: `lib/digests/queries.ts` — switch to `isOverdue` building blocks
- Modify: `lib/reminders/schema.ts` — `autoComplete` field in `baseReminderShape` + update partial
- Modify: `lib/reminders/actions.ts` — coerce `autoComplete` to `false` server-side when `kind !== CHORE`
- Modify: `lib/house-profile/schema.ts` + `lib/house-profile/queries.ts` — surface `timezone` (read-only is fine for v1)

**UI:**
- Modify: `components/reminders/ReminderStatusBadge.tsx` — accept `tz` prop, use `isOverdue`
- Modify: `components/reminders/ReminderTable.tsx` + `app/(app)/reminders/[id]/page.tsx` — thread `tz` to the badge
- Modify: `components/reminders/ReminderForm.tsx` — `autoComplete` checkbox visible only when `kind=CHORE`

**iCal:**
- Modify: `lib/ical/assemble.ts` — use `isOverdue` (signature gains `tz`), update callers

**Workers:**
- Create: `worker/jobs/chore-auto-complete-tick.ts`
- Modify: `lib/queue.ts` — add `ChoreAutoCompleteTick` queue name
- Modify: `worker/index.ts` — schedule + work registration

**Tests:**
- Create: `lib/time/tz.test.ts`
- Create: `worker/jobs/chore-auto-complete-tick.test.ts` (unit, mocked prisma — same pattern as digest-tick unit tests if present, otherwise integration only)
- Create: `tests/integration/chore-auto-complete.test.ts`
- Update: existing badge / iCal / digest tests for new boundary semantics

---

## Conventions

- **Branch already exists**: `feat/overdue-and-chore-autocomplete` (spec already committed there).
- **Commit cadence**: one commit per numbered task below, unless the task explicitly groups.
- **Test runner**: `pnpm test:unit -- <path>` for unit, `pnpm test:integration -- <path>` for integration.
- **Migration creation**: `pnpm prisma migrate dev --name overdue_and_autocomplete --create-only` then inspect the generated SQL (per `feedback_prisma_migration_drift` — eyeball for stray DROPs of manual indexes / XOR constraints).
- **TDD**: write the failing test first for every behavior change. The badge / iCal / worker tasks all follow red → green → commit.
- **No `--no-verify`**: per `feedback_no_verify`. Hooks must pass.

---

## Task 1: Schema migration + sentinel user seed

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<ts>_overdue_and_autocomplete/migration.sql`
- Modify: `prisma/seed.ts`

- [ ] **Step 1.1: Edit schema.prisma**

In `model HouseProfile` (currently lines ~93–101), add:
```prisma
  timezone     String   @default("UTC")
```
between `propertyType` and `updatedAt`.

In `model Reminder` (currently around line 466), add `autoComplete` after `autoCreateServiceRecord`:
```prisma
  autoComplete            Boolean             @default(false)
```

- [ ] **Step 1.2: Generate the migration (create-only)**

```bash
pnpm prisma migrate dev --name overdue_and_autocomplete --create-only
```

Inspect the generated SQL. Expected: two `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT ...` statements only. **Stop and report** if the SQL contains DROP statements on pgvector indexes, the WarrantyTarget XOR CHECK, or anything else unexpected (per `feedback_prisma_migration_drift`).

- [ ] **Step 1.3: Apply the migration to dev DB**

```bash
pnpm prisma migrate dev
```

- [ ] **Step 1.4: Add sentinel user upsert to `prisma/seed.ts`**

Append inside `main()`, after the category loop:
```ts
await prisma.user.upsert({
  where: { id: 'system-auto-complete' },
  update: {},
  create: {
    id: 'system-auto-complete',
    email: 'system+auto-complete@house-manager.local',
    name: 'System (Auto-complete)',
  },
});
console.log('Seeded system-auto-complete user.');
```

- [ ] **Step 1.5: Run the seed against the dev DB**

```bash
pnpm prisma db seed
```

Expected: existing "Seeded N categories." line + new "Seeded system-auto-complete user." line. Re-running should be idempotent (upsert).

- [ ] **Step 1.6: Export the sentinel ID as a constant**

Create `lib/reminders/system-user.ts`:
```ts
/** ID of the seeded user that attributes auto-completed chores.
 *  Single source of truth — DO NOT inline the literal elsewhere. */
export const SYSTEM_AUTO_COMPLETE_USER_ID = 'system-auto-complete';
```

- [ ] **Step 1.7: Commit**

```bash
git add prisma/ lib/reminders/system-user.ts
git commit -m "feat(schema): add HouseProfile.timezone, Reminder.autoComplete, sentinel user"
```

---

## Task 2: `isOverdue` + `endOfDayInTz` helpers (TDD)

**Files:**
- Create: `lib/time/tz.test.ts`
- Modify: `lib/time/tz.ts`

- [ ] **Step 2.1: Write failing tests in `lib/time/tz.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { endOfDayInTz, isOverdue } from './tz';

const NY = 'America/New_York';
const UTC = 'UTC';

describe('isOverdue', () => {
  it('returns false when due date is later today in tz (mid-afternoon)', () => {
    // 2026-05-27 15:00 UTC = 2026-05-27 11:00 EDT; due midnight UTC = 2026-05-27 in UTC, 2026-05-26 in NY.
    const now = new Date('2026-05-27T15:00:00Z');
    const dueToday = new Date('2026-05-27T00:00:00Z'); // wall-clock today in UTC
    expect(isOverdue(dueToday, now, UTC)).toBe(false);
  });

  it('returns true when due date is yesterday in tz', () => {
    const now = new Date('2026-05-27T15:00:00Z');
    const dueYesterday = new Date('2026-05-26T00:00:00Z');
    expect(isOverdue(dueYesterday, now, UTC)).toBe(true);
  });

  it('returns false when due is tomorrow', () => {
    const now = new Date('2026-05-27T15:00:00Z');
    const dueTomorrow = new Date('2026-05-28T00:00:00Z');
    expect(isOverdue(dueTomorrow, now, UTC)).toBe(false);
  });

  it('is not overdue at 23:59 local on the due day', () => {
    // 2026-05-27 23:59 EDT = 2026-05-28 03:59 UTC; due date 2026-05-27 in NY tz.
    const now = new Date('2026-05-28T03:59:00Z');
    const due = new Date('2026-05-27T04:00:00Z'); // 00:00 EDT on the 27th
    expect(isOverdue(due, now, NY)).toBe(false);
  });

  it('is overdue at 00:01 local the day after due', () => {
    // 2026-05-28 00:01 EDT = 2026-05-28 04:01 UTC.
    const now = new Date('2026-05-28T04:01:00Z');
    const due = new Date('2026-05-27T04:00:00Z');
    expect(isOverdue(due, now, NY)).toBe(true);
  });

  it('handles DST spring-forward (2026-03-08 in NY)', () => {
    // Due on the 8th, "now" is later on the 8th — same calendar day, not overdue.
    const due = new Date('2026-03-08T05:00:00Z'); // 00:00 EST
    const now = new Date('2026-03-08T18:00:00Z'); // 14:00 EDT post spring-forward
    expect(isOverdue(due, now, NY)).toBe(false);
  });

  it('handles DST fall-back (2026-11-01 in NY)', () => {
    const due = new Date('2026-11-01T04:00:00Z'); // 00:00 EDT
    const now = new Date('2026-11-01T22:00:00Z'); // 17:00 EST post fall-back
    expect(isOverdue(due, now, NY)).toBe(false);
  });
});

describe('endOfDayInTz', () => {
  it('returns 23:59:59.999 wall-clock of the input date in tz, as UTC instant', () => {
    const d = new Date('2026-05-27T10:00:00Z'); // 06:00 EDT on the 27th
    const eod = endOfDayInTz(d, NY);
    // 23:59:59.999 EDT on 2026-05-27 = 03:59:59.999 UTC on 2026-05-28.
    expect(eod.toISOString()).toBe('2026-05-28T03:59:59.999Z');
  });

  it('UTC returns 23:59:59.999Z of the same UTC date', () => {
    const d = new Date('2026-05-27T15:00:00Z');
    expect(endOfDayInTz(d, UTC).toISOString()).toBe('2026-05-27T23:59:59.999Z');
  });
});
```

- [ ] **Step 2.2: Run test to verify it fails**

```bash
pnpm test:unit -- lib/time/tz.test.ts
```
Expected: FAIL — `isOverdue` / `endOfDayInTz` not exported.

- [ ] **Step 2.3: Implement helpers in `lib/time/tz.ts`**

Append:
```ts
/**
 * True iff `nextDueOn`'s calendar date in `tz` is strictly before `now`'s
 * calendar date in `tz`. Due-today (any wall-clock time) returns false.
 */
export function isOverdue(nextDueOn: Date, now: Date, tz: string): boolean {
  const a = tzParts(nextDueOn, tz);
  const b = tzParts(now, tz);
  // Lex compare (year, month, day).
  if (a.year !== b.year) return a.year < b.year;
  if (a.month !== b.month) return a.month < b.month;
  return a.day < b.day;
}

/**
 * The UTC instant of 23:59:59.999 wall-clock on the calendar day that contains
 * `d` in `tz`. Used to stamp `completedOn` when a chore auto-completes at
 * end-of-due-day.
 */
export function endOfDayInTz(d: Date, tz: string): Date {
  const { year, month, day } = tzParts(d, tz);
  const offsetMinutes = tzOffsetMinutes(d, tz);
  return new Date(
    Date.UTC(year, month - 1, day, 23, 59, 59, 999) - offsetMinutes * 60_000,
  );
}
```

- [ ] **Step 2.4: Run tests to verify they pass**

```bash
pnpm test:unit -- lib/time/tz.test.ts
```
Expected: all PASS.

- [ ] **Step 2.5: Commit**

```bash
git add lib/time/tz.ts lib/time/tz.test.ts
git commit -m "feat(tz): add isOverdue + endOfDayInTz helpers"
```

---

## Task 3: Use `isOverdue` in the badge

**Files:**
- Modify: `components/reminders/ReminderStatusBadge.tsx`
- Modify: existing badge tests if any (`grep -l ReminderStatusBadge tests/ components/`)
- Modify: `components/reminders/ReminderTable.tsx`, `app/(app)/reminders/[id]/page.tsx` — pass `tz` prop

- [ ] **Step 3.1: Write/update failing test for the badge**

Locate or create a test that asserts the badge does NOT render "Overdue" when `nextDueOn` is today in the supplied tz. If `components/reminders/ReminderStatusBadge.test.tsx` doesn't exist, create it:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReminderStatusBadge } from './ReminderStatusBadge';

describe('ReminderStatusBadge', () => {
  it('does not render Overdue when due is today in tz', () => {
    // Freeze now via the badge's `now` prop (added by this task).
    const now = new Date('2026-05-27T15:00:00Z');
    const due = new Date('2026-05-27T00:00:00Z');
    render(<ReminderStatusBadge nextDueOn={due} active={true} tz="UTC" now={now} />);
    expect(screen.getByTestId('reminder-due-badge')).not.toHaveTextContent('Overdue');
  });

  it('renders Overdue when due is yesterday in tz', () => {
    const now = new Date('2026-05-27T15:00:00Z');
    const due = new Date('2026-05-26T00:00:00Z');
    render(<ReminderStatusBadge nextDueOn={due} active={true} tz="UTC" now={now} />);
    expect(screen.getByTestId('reminder-due-badge')).toHaveTextContent('Overdue');
  });
});
```

- [ ] **Step 3.2: Run test to verify it fails**

```bash
pnpm test:unit -- components/reminders/ReminderStatusBadge.test.tsx
```
Expected: FAIL (current code flips to Overdue based on `Date.now()`).

- [ ] **Step 3.3: Update `ReminderStatusBadge.tsx`**

Replace the whole component. Note: keep "Due soon" logic but base it on calendar days in tz, not millisecond math.

```tsx
import { Badge } from '@/components/ui/badge';
import { isOverdue, tzParts } from '@/lib/time/tz';

type Props = {
  nextDueOn: Date;
  active: boolean;
  tz: string;
  /** Override for tests; defaults to `new Date()`. */
  now?: Date;
};

function calendarDaysBetween(later: { year: number; month: number; day: number }, earlier: { year: number; month: number; day: number }): number {
  const a = Date.UTC(later.year, later.month - 1, later.day);
  const b = Date.UTC(earlier.year, earlier.month - 1, earlier.day);
  return Math.round((a - b) / 86_400_000);
}

export function ReminderStatusBadge({ nextDueOn, active, tz, now = new Date() }: Props) {
  if (!active) {
    return (
      <Badge variant="secondary" data-testid="reminder-due-badge">
        Inactive
      </Badge>
    );
  }
  if (isOverdue(nextDueOn, now, tz)) {
    return (
      <Badge variant="destructive" data-testid="reminder-due-badge">
        Overdue
      </Badge>
    );
  }
  const days = calendarDaysBetween(tzParts(nextDueOn, tz), tzParts(now, tz));
  if (days <= 3) {
    return (
      <Badge
        variant="outline"
        className="text-amber-700 dark:text-amber-400"
        data-testid="reminder-due-badge"
      >
        {days === 0 ? 'Due today' : 'Due soon'}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" data-testid="reminder-due-badge">
      In {days}d
    </Badge>
  );
}
```

- [ ] **Step 3.4: Thread `tz` from callers**

In `components/reminders/ReminderTable.tsx` and `app/(app)/reminders/[id]/page.tsx`, locate every `<ReminderStatusBadge ... />` and pass `tz={houseTimezone}`. Read the timezone in the page/server component:
```ts
const profile = await getHouseProfile();
const houseTimezone = profile?.timezone ?? 'UTC';
```
If `ReminderTable` is a client component, thread it through props from its server-side parent. Use `grep -rn "ReminderStatusBadge" app components` to find all call sites and update each.

- [ ] **Step 3.5: Run tests to verify they pass**

```bash
pnpm test:unit -- components/reminders/ReminderStatusBadge.test.tsx
pnpm typecheck
```

- [ ] **Step 3.6: Commit**

```bash
git add components/reminders/ReminderStatusBadge.tsx components/reminders/ReminderStatusBadge.test.tsx components/reminders/ReminderTable.tsx app/\(app\)/reminders/
git commit -m "fix(reminders): badge overdue uses calendar day in house tz"
```

---

## Task 4: Use `isOverdue` in iCal assembly

**Files:**
- Modify: `lib/ical/assemble.ts`
- Modify: `lib/ical/assemble.test.ts`
- Modify: every caller of `assembleReminderEvents` (`grep -rn "assembleReminderEvents" --include='*.ts' --include='*.tsx'`)

- [ ] **Step 4.1: Update tests to assert tz-aware overdue branch**

In `lib/ical/assemble.test.ts`, add a test where `nextDueOn` is today wall-clock in NY and `now` is later the same day in NY. Assert the due event carries `alarmSecondsBefore !== null` (it is NOT overdue, so the lead-time alarm IS attached). The current implementation attaches alarm only when `date.getTime() >= todayUtc`, which fails for due-today entries that crossed UTC midnight earlier today.

Plus one regression: due-yesterday in tz → `alarmSecondsBefore === null`.

- [ ] **Step 4.2: Run tests to verify they fail**

```bash
pnpm test:unit -- lib/ical/assemble.test.ts
```

- [ ] **Step 4.3: Update `assembleReminderEvents` signature**

Add `tz: string` as a parameter. Replace the alarm decision at line ~71:
```ts
alarmSecondsBefore: isOverdue(input.nextDueOn, now, tz) ? null : leadSeconds,
```
Import `isOverdue` at the top of the file.

- [ ] **Step 4.4: Update callers**

`grep -rn "assembleReminderEvents" lib app worker tests --include='*.ts'`. At each call site, source the tz: `(await getHouseProfile())?.timezone ?? 'UTC'` and pass it. Most call sites will be in the ICS feed route — likely under `app/api/ical/` or `app/(api)/`.

- [ ] **Step 4.5: Run tests + typecheck**

```bash
pnpm test:unit -- lib/ical/
pnpm typecheck
```

- [ ] **Step 4.6: Commit**

```bash
git add lib/ical/ app/
git commit -m "fix(ical): overdue branch uses house tz, not UTC midnight"
```

---

## Task 5: Refactor `lib/digests/queries.ts` onto the shared helper

**Files:**
- Modify: `lib/digests/queries.ts`
- Possibly: `lib/digests/queries.test.ts` (assertions should still pass — change is internal)

- [ ] **Step 5.1: Replace `startOfTodayInTz` with the shared building block**

`startOfTodayInTz` in `lib/digests/queries.ts:17` does the same job a `startOfDayInTz` helper would do in `lib/time/tz.ts`. Move it (rename to `startOfDayInTz(d, tz)` taking an arbitrary date, defaulting `d = now` at the call site).

```ts
// in lib/time/tz.ts
export function startOfDayInTz(d: Date, tz: string): Date {
  const { year, month, day } = tzParts(d, tz);
  const offsetMinutes = tzOffsetMinutes(d, tz);
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMinutes * 60_000);
}
```

Add a unit test mirroring the `endOfDayInTz` one. Then in `lib/digests/queries.ts`, delete the local `startOfTodayInTz` and replace its call:
```ts
const start = startOfDayInTz(now, timezone);
return findAndProject(userId, { lt: start }, 'asc', now);
```

- [ ] **Step 5.2: Run tests**

```bash
pnpm test:unit -- lib/time/tz.test.ts lib/digests/
```
Expected: all PASS (existing digest tests unchanged, new tz test passes).

- [ ] **Step 5.3: Commit**

```bash
git add lib/time/tz.ts lib/time/tz.test.ts lib/digests/queries.ts
git commit -m "refactor(digests): share startOfDayInTz with tz lib"
```

---

## Task 6: `autoComplete` Zod field + server-side coercion

**Files:**
- Modify: `lib/reminders/schema.ts`
- Modify: `lib/reminders/actions.ts`
- Modify: `lib/reminders/schema.test.ts`

- [ ] **Step 6.1: Write failing tests in `lib/reminders/schema.test.ts`**

```ts
it('accepts autoComplete on CHORE', () => {
  const parsed = createReminderSchema.parse({
    title: 'Water plants',
    kind: 'CHORE',
    recurrence: { kind: 'interval', every: 1, unit: 'week' },
    nextDueOn: new Date('2026-05-27'),
    targets: [],
    autoComplete: true,
  });
  expect(parsed.autoComplete).toBe(true);
});

it('parses autoComplete=true on REMINDER at schema level (server action enforces coercion)', () => {
  const parsed = createReminderSchema.parse({
    title: 'HVAC service',
    kind: 'REMINDER',
    recurrence: { kind: 'interval', every: 6, unit: 'month' },
    nextDueOn: new Date('2026-05-27'),
    targets: [{ itemId: 'i1' }],
    autoComplete: true,
  });
  // Schema doesn't reject — the server action coerces it. See Task 6.4.
  expect(parsed.autoComplete).toBe(true);
});

it('autoComplete defaults to false when omitted', () => {
  const parsed = createReminderSchema.parse({
    title: 'X',
    kind: 'CHORE',
    recurrence: { kind: 'interval', every: 1, unit: 'day' },
    nextDueOn: new Date('2026-05-27'),
    targets: [],
  });
  expect(parsed.autoComplete).toBe(false);
});
```

- [ ] **Step 6.2: Run tests to verify they fail**

```bash
pnpm test:unit -- lib/reminders/schema.test.ts
```

- [ ] **Step 6.3: Add `autoComplete` to `baseReminderShape`**

In `lib/reminders/schema.ts:154`:
```ts
const baseReminderShape = {
  // ...existing fields
  autoCreateServiceRecord: z.boolean().default(false),
  autoComplete: z.boolean().default(false),
  notifyUserIds: z.array(z.string().min(1)).optional(),
} as const;
```
(No change needed to `partialOf(...)` — it picks up the new field automatically.)

- [ ] **Step 6.4: Add server-side coercion in `lib/reminders/actions.ts`**

In `createReminder` (around line 81) and `updateReminder` (around line 134), after `const parsed = ... .safeParse(input); ... const { ...rest, kind } = parsed.data;`, normalize:
```ts
if (kind !== 'CHORE' && rest.autoComplete) {
  rest.autoComplete = false;
}
```
Then thread `autoComplete: rest.autoComplete` into the Prisma `data` block alongside the other reminder fields.

Add a server-action test in `lib/reminders/actions.test.ts` (or whichever existing test covers `createReminder`) asserting that a REMINDER payload with `autoComplete: true` ends up with `autoComplete: false` in the DB row.

- [ ] **Step 6.5: Run tests + typecheck**

```bash
pnpm test:unit -- lib/reminders/
pnpm typecheck
```

- [ ] **Step 6.6: Commit**

```bash
git add lib/reminders/schema.ts lib/reminders/schema.test.ts lib/reminders/actions.ts lib/reminders/actions.test.ts
git commit -m "feat(reminders): autoComplete field + CHORE-only server coercion"
```

---

## Task 7: `autoComplete` checkbox in the chore form

**Files:**
- Modify: `components/reminders/ReminderForm.tsx`
- Modify: `components/reminders/ReminderForm.test.tsx`

- [ ] **Step 7.1: Failing test**

Add to `ReminderForm.test.tsx`:
```tsx
it('shows the autoComplete checkbox only when kind=CHORE', () => {
  const { rerender } = render(<ReminderForm kind="CHORE" {...defaultProps} />);
  expect(screen.getByLabelText(/auto-complete/i)).toBeInTheDocument();

  rerender(<ReminderForm kind="REMINDER" {...defaultProps} />);
  expect(screen.queryByLabelText(/auto-complete/i)).not.toBeInTheDocument();
});
```

- [ ] **Step 7.2: Run test to verify it fails**

```bash
pnpm test:unit -- components/reminders/ReminderForm.test.tsx
```

- [ ] **Step 7.3: Add the field**

In `ReminderForm.tsx`, near the `autoCreateServiceRecord` checkbox block (around line 258), add a sibling field gated on `isChore`:
```tsx
{isChore && (
  <FormField
    control={form.control}
    name="autoComplete"
    render={({ field }) => (
      <FormItem className="flex items-center gap-3 space-y-0">
        <FormControl>
          <Checkbox
            id="autoComplete"
            checked={field.value}
            onCheckedChange={field.onChange}
          />
        </FormControl>
        <FormLabel htmlFor="autoComplete" className="!mt-0 cursor-pointer">
          Auto-complete at end of due day
        </FormLabel>
      </FormItem>
    )}
  />
)}
```

Also ensure the form's `defaultValues` include `autoComplete: false` (around line 83 alongside `autoCreateServiceRecord: false`).

- [ ] **Step 7.4: Run tests + typecheck**

```bash
pnpm test:unit -- components/reminders/ReminderForm.test.tsx
pnpm typecheck
```

- [ ] **Step 7.5: Commit**

```bash
git add components/reminders/ReminderForm.tsx components/reminders/ReminderForm.test.tsx
git commit -m "feat(chores): autoComplete checkbox in chore form"
```

---

## Task 8: `chore-auto-complete-tick` worker — integration test first

**Files:**
- Create: `tests/integration/chore-auto-complete.test.ts`
- Create: `worker/jobs/chore-auto-complete-tick.ts`
- Modify: `lib/queue.ts`
- Modify: `worker/index.ts`

- [ ] **Step 8.1: Write failing integration test**

Model after `tests/integration/digest-tick.test.ts`. Cover these cases:

1. **Auto-closes overdue chore**: chore (kind=CHORE, autoComplete=true) with `nextDueOn` two days ago in house tz; one target. After `handleChoreAutoCompleteTick()`:
   - One new `ReminderCompletion` exists with `completedById = SYSTEM_AUTO_COMPLETE_USER_ID`, `notes = 'Auto-completed'`, `completedOn` = end-of-due-day in house tz.
   - The target's `nextDueOn` advanced (assert it's > original `nextDueOn`).
   - The target's `lastCompletedOn` set to `completedOn`.

2. **Skips today**: chore due today (calendar day in house tz). After tick: no new completion row.

3. **Skips when autoComplete=false**: overdue chore but `autoComplete=false`. No completion.

4. **Skips REMINDER kind**: overdue reminder (kind=REMINDER) with `autoComplete=true` (bypassing schema by direct DB insert). No completion.

5. **Idempotent on re-run**: run tick twice; only one completion per overdue target.

6. **Skips ServiceRecord even when autoCreateServiceRecord=true**: chore with both flags true. Completion row exists but no ServiceRecord created (and `completion.createdServiceRecordId` is null).

Set `HouseProfile.timezone = 'America/New_York'` in `beforeEach`. Pick fixed `now` instants in test data; pass them via a `now` arg if the handler accepts one (see Step 8.3).

- [ ] **Step 8.2: Run test to verify it fails**

```bash
pnpm test:integration -- tests/integration/chore-auto-complete.test.ts
```
Expected: FAIL — module `@/worker/jobs/chore-auto-complete-tick` not found.

- [ ] **Step 8.3: Implement the worker job**

Create `worker/jobs/chore-auto-complete-tick.ts`:

```ts
import { prisma } from '@/lib/db';
import { getLogger } from '@/lib/logger';
import { computeNextDueOn, parseRecurrence } from '@/lib/reminders/recurrence';
import { SYSTEM_AUTO_COMPLETE_USER_ID } from '@/lib/reminders/system-user';
import { enqueueSearchIndex } from '@/lib/search/queue';
import { endOfDayInTz, startOfDayInTz } from '@/lib/time/tz';

const logger = getLogger('chore-auto-complete-tick');

/**
 * Scan for CHORE-kind reminders with autoComplete=true whose targets have
 * nextDueOn strictly before today (house tz). For each, write a system-
 * attributed ReminderCompletion and advance the target's nextDueOn one cycle.
 *
 * Skipped side-effects (vs. manual completion):
 *  - autoCreateServiceRecord (never fires on auto-complete)
 *  - NotificationLog (chores don't notify regardless)
 */
export async function handleChoreAutoCompleteTick(now: Date = new Date()): Promise<void> {
  const profile = await prisma.houseProfile.findFirst({ select: { timezone: true } });
  const tz = profile?.timezone ?? 'UTC';
  const startToday = startOfDayInTz(now, tz);

  const candidates = await prisma.reminderTarget.findMany({
    where: {
      nextDueOn: { lt: startToday },
      reminder: { kind: 'CHORE', autoComplete: true, active: true },
    },
    include: {
      reminder: { select: { id: true, recurrence: true } },
    },
  });

  if (candidates.length === 0) return;

  const reindexReminderIds = new Set<string>();

  for (const t of candidates) {
    const completedOn = endOfDayInTz(t.nextDueOn, tz);
    const recurrence = parseRecurrence(t.reminder.recurrence);
    const nextDueOn = computeNextDueOn(recurrence, completedOn);

    await prisma.$transaction(async (tx) => {
      await tx.reminderCompletion.create({
        data: {
          reminderId: t.reminderId,
          targetId: t.id,
          completedById: SYSTEM_AUTO_COMPLETE_USER_ID,
          completedOn,
          notes: 'Auto-completed',
        },
      });
      await tx.reminderTarget.update({
        where: { id: t.id },
        data: { lastCompletedOn: completedOn, nextDueOn },
      });
    });

    reindexReminderIds.add(t.reminderId);
  }

  for (const id of reindexReminderIds) {
    await enqueueSearchIndex('reminder', id, 'upsert');
  }

  logger.info({ count: candidates.length }, 'auto-completed chores');
}
```

- [ ] **Step 8.4: Register the queue**

In `lib/queue.ts:14-27`, add:
```ts
ChoreAutoCompleteTick: 'chore-auto-complete.tick',
```

In `worker/index.ts`, after the `RemindersTick` registration block, add:
```ts
await boss.schedule(Queue.ChoreAutoCompleteTick, '0 * * * *'); // hourly
await boss.work(Queue.ChoreAutoCompleteTick, { batchSize: 1 }, async () => {
  await handleChoreAutoCompleteTick();
});
```
Import `handleChoreAutoCompleteTick` at the top.

- [ ] **Step 8.5: Run integration test**

```bash
pnpm test:integration -- tests/integration/chore-auto-complete.test.ts
```
Expected: all six cases PASS.

- [ ] **Step 8.6: Commit**

```bash
git add worker/jobs/chore-auto-complete-tick.ts worker/index.ts lib/queue.ts tests/integration/chore-auto-complete.test.ts
git commit -m "feat(chores): hourly worker auto-completes overdue chores"
```

---

## Task 9: "Auto" badge on system-attributed completion rows

**Files:**
- Modify: the chore detail / completion-history component (likely `app/(app)/chores/[id]/page.tsx` or a sibling — `grep -rn "ReminderCompletion\|completedBy" app components` to locate)
- Modify: matching test if present

- [ ] **Step 9.1: Failing test (snapshot or RTL)**

Add a test asserting that when a completion row's `completedById === 'system-auto-complete'`, a small "Auto" badge renders alongside it.

- [ ] **Step 9.2: Implement**

In the completion-row render, conditionally render:
```tsx
{completion.completedById === SYSTEM_AUTO_COMPLETE_USER_ID && (
  <Badge variant="outline" className="text-xs">Auto</Badge>
)}
```
Import `SYSTEM_AUTO_COMPLETE_USER_ID` from `@/lib/reminders/system-user`.

- [ ] **Step 9.3: Verify + commit**

```bash
pnpm test:unit -- <touched file paths>
pnpm typecheck
git add <touched files>
git commit -m "feat(chores): show 'Auto' badge on system-attributed completions"
```

---

## Task 10: Full sweep + PR

- [ ] **Step 10.1: Run the whole gate locally**

```bash
pnpm lint
pnpm typecheck
pnpm test
```
Expected: green.

- [ ] **Step 10.2: Audit for stray overdue logic**

```bash
rg -n "overdue|Overdue|DAY_MS" lib app components worker --type ts --type tsx
```
For each non-test hit, confirm it either uses `isOverdue` or is intentionally separate (e.g. `daysOverdue` projection in digests is a *count*, not a boundary check, and is fine).

- [ ] **Step 10.3: Push branch + open PR**

Per `feedback_pr_auto_merge_watch`:
```bash
git push -u origin feat/overdue-and-chore-autocomplete
gh pr create --title "feat(chores): redefine overdue + chore auto-complete" --body "$(cat <<'EOF'
## Summary
- Overdue means the due date's calendar day is strictly before today in the house timezone. Centralized in `lib/time/tz.ts::isOverdue`; the badge, iCal feed, and digest queries all share it now.
- New `HouseProfile.timezone` (default `"UTC"`) gives the app a canonical clock; per-user `NotificationPrefs.timezone` continues to drive digest delivery timing.
- Chores gain an opt-in `autoComplete` flag. An hourly worker writes a system-attributed `ReminderCompletion` and rolls the recurrence forward. ServiceRecord side-effects and notifications are skipped on auto-completes.
- Server actions coerce `autoComplete -> false` whenever `kind !== CHORE`; UI hiding alone is not the contract.

## Test plan
- [ ] `pnpm test:unit` (badge + tz + reminders schema + iCal)
- [ ] `pnpm test:integration -- chore-auto-complete` (6 scenarios)
- [ ] Manual: in dev DB, set `HouseProfile.timezone='America/New_York'`, create chore due-yesterday w/ autoComplete=true, run worker once, verify completion row + advanced `nextDueOn`.
EOF
)"
gh pr merge --auto --squash
gh pr checks --watch --fail-fast
```

---

## Risks & known cliffs

- **`computeNextDueOn` import path** — confirm the export from `lib/reminders/recurrence.ts`; if the helper lives behind a different name (e.g. `nextOccurrence`), adjust Task 8.3.
- **`enqueueSearchIndex` signature** — Task 8.3 mirrors `lib/reminders/actions.ts:453`; if that signature has shifted, follow whatever the manual-completion path uses.
- **ReminderForm shape** — `defaultValues` may use a wider type than the discriminated union; if the form already coalesces kind defaults, ensure `autoComplete` is in the union for both arms (Task 6.3 puts it in `baseReminderShape`, which both arms spread).
- **Dev DB seed** — per `feedback_dev_db_disposable`, if the migration blocks for any reason (it shouldn't — additive), `pnpm db:reset && pnpm db:seed` is the right answer, not checksum surgery.
- **HouseProfile read at request time** — surfaces like `ReminderTable` SSR'd per request will now read `HouseProfile.timezone` each render. This is a single-row indexed lookup; if it becomes hot, cache via `unstable_cache` later.
