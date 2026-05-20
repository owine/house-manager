# Recurrence Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend reminder/chore recurrence with day-of-week, unit-based intervals (week/month/year), nth-weekday-of-month, last-day-of-month, and an orthogonal seasonality (active-months) filter.

**Architecture:** Recurrence is an opaque `Json` column validated by a Zod discriminated union (`lib/reminders/schema.ts`) and turned into dates by `computeNextDueOn` (`lib/reminders/recurrence.ts`). All new patterns are additive union variants + switch cases — no Prisma schema migration, only a one-time JSON value rewrite for the legacy `interval {days}` shape. Calendar kinds and unit intervals use the already-present `rrule` dependency; the completion-anchored day-unit interval keeps exact `+N*DAY_MS` arithmetic. A `parseRecurrence()` normalizer at every DB read boundary keeps legacy rows working.

**Tech Stack:** TypeScript, Zod, `rrule`, Prisma 7, Vitest 4, Biome 2, React + shadcn/ui.

---

## Critical gotchas (read before starting)

1. **`rrule` weekday numbering ≠ JS.** `RRule.MO.weekday === 0`, `RRule.SU.weekday === 6`. Our schema uses the **JS convention `0 = Sunday … 6 = Saturday`**. NEVER pass raw JS weekday integers to `byweekday`; always map through the `RRule.SU/MO/TU/WE/TH/FR/SA` `Weekday` objects. A mapping array is defined in Task 2.
2. **rrule treats `dtstart` as a candidate occurrence.** To get "strictly after completion," every rrule-based case uses `dtstart = completedOn + DAY_MS` (mirrors the existing `monthly`/`yearly` cases at `recurrence.ts:19,31`).
3. **Recurrence is cast, not parsed, on read** (`r.recurrence as unknown as Recurrence`). Once the `interval` type becomes `{every,unit}`, a legacy `{days}` row read this way yields `NaN`. Task 4 wraps all 5 read sites in `parseRecurrence()`.
4. **The AI schema is a separate union** (`lib/ai/schemas.ts`). It stays the legacy subset on purpose; only the save boundary (`saveAcceptedReminders`) normalizes. Do NOT edit `SuggestionRow.tsx`.

---

## File structure

- **Modify** `lib/reminders/schema.ts` — new union variants, `activeMonths`, `parseRecurrence()`.
- **Modify** `lib/reminders/recurrence.ts` — new `computeNextDueOn` cases + weekday map + seasonality skip-loop.
- **Modify** `lib/reminders/recurrence.test.ts` — update legacy-shape inputs, add new-kind + seasonality tests.
- **Modify** `lib/reminders/schema.test.ts` — validation + `parseRecurrence` tests.
- **Create** `lib/reminders/describe.ts` + `lib/reminders/describe.test.ts` — `describeRecurrence(rec)` for detail views.
- **Create** `prisma/migrations/<ts>_normalize_interval_recurrence/migration.sql` — legacy JSON rewrite.
- **Modify** read sites: `app/(app)/reminders/[id]/page.tsx:30`, `app/(app)/reminders/[id]/edit/page.tsx:45`, `app/api/calendar/[token]/route.ts:42`, `lib/ai/suggest/reminders.ts:179`, `lib/reminders/actions.ts:270`.
- **Modify** `components/reminders/RecurrencePicker.tsx` — unit dropdown, weekly weekdays, nth-weekday, monthly "last", seasonality picker.

---

## Task 1: Schema — new union, activeMonths, parseRecurrence

**Files:**
- Modify: `lib/reminders/schema.ts`
- Test: `lib/reminders/schema.test.ts`

- [ ] **Step 1: Write failing tests** in `lib/reminders/schema.test.ts` (add to the existing file):

```ts
import { describe, expect, it } from 'vitest';
import { parseRecurrence, recurrenceSchema } from './schema';

describe('recurrenceSchema — new kinds', () => {
  it('accepts interval with unit', () => {
    expect(recurrenceSchema.safeParse({ kind: 'interval', every: 3, unit: 'month' }).success).toBe(true);
  });
  it('accepts weekly with weekdays', () => {
    expect(recurrenceSchema.safeParse({ kind: 'weekly', weekdays: [1, 4] }).success).toBe(true);
  });
  it('rejects weekly with empty weekdays', () => {
    expect(recurrenceSchema.safeParse({ kind: 'weekly', weekdays: [] }).success).toBe(false);
  });
  it('rejects weekly with duplicate weekdays', () => {
    expect(recurrenceSchema.safeParse({ kind: 'weekly', weekdays: [1, 1] }).success).toBe(false);
  });
  it('rejects weekly with out-of-range weekday', () => {
    expect(recurrenceSchema.safeParse({ kind: 'weekly', weekdays: [7] }).success).toBe(false);
  });
  it('accepts monthlyWeekday', () => {
    expect(recurrenceSchema.safeParse({ kind: 'monthlyWeekday', week: -1, weekday: 5 }).success).toBe(true);
  });
  it('rejects monthlyWeekday with bad week', () => {
    expect(recurrenceSchema.safeParse({ kind: 'monthlyWeekday', week: 0, weekday: 5 }).success).toBe(false);
  });
  it("accepts monthly 'last'", () => {
    expect(recurrenceSchema.safeParse({ kind: 'monthly', dayOfMonth: 'last' }).success).toBe(true);
  });
  it('accepts activeMonths on weekly', () => {
    expect(recurrenceSchema.safeParse({ kind: 'weekly', weekdays: [1], activeMonths: [4, 5, 6] }).success).toBe(true);
  });
  it('rejects empty activeMonths', () => {
    expect(recurrenceSchema.safeParse({ kind: 'weekly', weekdays: [1], activeMonths: [] }).success).toBe(false);
  });
  it('rejects duplicate activeMonths', () => {
    expect(recurrenceSchema.safeParse({ kind: 'weekly', weekdays: [1], activeMonths: [4, 4] }).success).toBe(false);
  });
  it('rejects out-of-range activeMonths', () => {
    expect(recurrenceSchema.safeParse({ kind: 'weekly', weekdays: [1], activeMonths: [13] }).success).toBe(false);
  });
});

describe('parseRecurrence', () => {
  it('normalizes legacy interval {days} to {every, unit:day}', () => {
    expect(parseRecurrence({ kind: 'interval', days: 60 })).toEqual({ kind: 'interval', every: 60, unit: 'day' });
  });
  it('passes through new interval shape unchanged', () => {
    expect(parseRecurrence({ kind: 'interval', every: 2, unit: 'week' })).toEqual({ kind: 'interval', every: 2, unit: 'week' });
  });
  it('passes through monthly/yearly/once', () => {
    expect(parseRecurrence({ kind: 'once' })).toEqual({ kind: 'once' });
  });
  it('throws on malformed json', () => {
    expect(() => parseRecurrence({ kind: 'interval' })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run lib/reminders/schema.test.ts`
Expected: FAIL — `parseRecurrence` not exported; new kinds rejected.

- [ ] **Step 3: Rewrite `recurrenceSchema` in `lib/reminders/schema.ts`.** Replace the existing `recurrenceSchema` block (lines 4–22) with:

```ts
const weekdaysSchema = z
  .array(z.number().int().min(0).max(6))
  .min(1)
  .refine((a) => new Set(a).size === a.length, { message: 'weekdays must be unique' });

const activeMonthsSchema = z
  .array(z.number().int().min(1).max(12))
  .min(1)
  .refine((a) => new Set(a).size === a.length, { message: 'activeMonths must be unique' });

// `activeMonths` (optional) restricts a recurrence to a set of calendar months
// (seasonality). Omitted = year-round. Applied uniformly across recurring kinds.
const seasonal = { activeMonths: activeMonthsSchema.optional() };

export const recurrenceSchema = z.discriminatedUnion('kind', [
  // interval — anchored to LAST COMPLETION; unit-based, calendar-aware.
  z.object({
    kind: z.literal('interval'),
    every: z.number().int().min(1).max(3650),
    unit: z.enum(['day', 'week', 'month', 'year']),
    ...seasonal,
  }),
  // weekly — one or more weekdays (0=Sun..6=Sat), calendar-anchored.
  z.object({ kind: z.literal('weekly'), weekdays: weekdaysSchema, ...seasonal }),
  // monthly — fixed day-of-month, or 'last' for the final day of each month.
  z.object({
    kind: z.literal('monthly'),
    dayOfMonth: z.union([z.number().int().min(1).max(28), z.literal('last')]),
    ...seasonal,
  }),
  // monthlyWeekday — nth weekday (week: 1..4 or -1 for last; weekday 0=Sun..6=Sat).
  z.object({
    kind: z.literal('monthlyWeekday'),
    week: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)]),
    weekday: z.number().int().min(0).max(6),
    ...seasonal,
  }),
  z.object({
    kind: z.literal('yearly'),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(28),
    ...seasonal,
  }),
  // `once` fires exactly once on nextDueOn and never again (see worker dedupe).
  z.object({ kind: z.literal('once') }),
]);

export type Recurrence = z.infer<typeof recurrenceSchema>;

/**
 * Normalize a stored recurrence JSON value into the current `Recurrence` shape,
 * then validate. Recurrence is read from the DB as opaque Json and historically
 * cast (not parsed); the legacy `interval {days:N}` shape predates unit-based
 * intervals, so map it to `{every:N, unit:'day'}` before validating. Throws on
 * anything that isn't a known shape.
 */
export function parseRecurrence(json: unknown): Recurrence {
  let candidate = json;
  if (
    json !== null &&
    typeof json === 'object' &&
    (json as { kind?: unknown }).kind === 'interval' &&
    typeof (json as { days?: unknown }).days === 'number' &&
    (json as { every?: unknown }).every === undefined
  ) {
    const { days, ...rest } = json as { days: number; [k: string]: unknown };
    candidate = { ...rest, every: days, unit: 'day' };
  }
  return recurrenceSchema.parse(candidate);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run lib/reminders/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck** (the `Recurrence` type changed; legacy literals elsewhere will surface — they're handled in later tasks, but confirm `schema.ts` itself compiles)

Run: `pnpm exec tsc --noEmit 2>&1 | head -30`
Expected: errors only in `recurrence.ts` / `recurrence.test.ts` / picker (later tasks), NOT in `schema.ts`.

- [ ] **Step 6: Commit**

```bash
git add lib/reminders/schema.ts lib/reminders/schema.test.ts
git commit -m "feat(recurrence): add weekly/monthlyWeekday/unit-interval/last + seasonality to schema"
```

---

## Task 2: Recurrence math — new cases, weekday map, seasonality

**Files:**
- Modify: `lib/reminders/recurrence.ts`
- Test: `lib/reminders/recurrence.test.ts`

- [ ] **Step 1: Update existing tests for the new interval shape + add new cases.** In `lib/reminders/recurrence.test.ts`, change the two legacy `{ kind: 'interval', days: N }` inputs (lines 7 and 45) to the new shape, then append the new tests:

Change line 7: `computeNextDueOn({ kind: 'interval', every: 60, unit: 'day' }, completed)`
Change line 45: `{ kind: 'interval', every: 30, unit: 'day' }`

Append:

```ts
describe('computeNextDueOn — units', () => {
  it('interval week: +N weeks (calendar)', () => {
    const next = computeNextDueOn({ kind: 'interval', every: 2, unit: 'week' }, new Date('2026-04-30T12:00:00Z'));
    expect(next.toISOString().slice(0, 10)).toBe('2026-05-14');
  });
  it('interval month: same day-of-month +N months', () => {
    const next = computeNextDueOn({ kind: 'interval', every: 3, unit: 'month' }, new Date('2026-01-15T00:00:00Z'));
    expect(next.toISOString().slice(0, 10)).toBe('2026-04-15');
  });
  it('interval year: +N years', () => {
    const next = computeNextDueOn({ kind: 'interval', every: 1, unit: 'year' }, new Date('2026-02-10T00:00:00Z'));
    expect(next.toISOString().slice(0, 10)).toBe('2027-02-10');
  });
});

describe('computeNextDueOn — weekly', () => {
  it('single weekday: next Monday after a Tuesday completion', () => {
    // 2026-05-12 is a Tuesday; next Monday is 2026-05-18.
    const next = computeNextDueOn({ kind: 'weekly', weekdays: [1] }, new Date('2026-05-12T00:00:00Z'));
    expect(next.toISOString().slice(0, 10)).toBe('2026-05-18');
  });
  it('multi weekday: Mon & Thu — completing Tue gives Thu', () => {
    // 2026-05-12 Tue -> next Thu 2026-05-14.
    const next = computeNextDueOn({ kind: 'weekly', weekdays: [1, 4] }, new Date('2026-05-12T00:00:00Z'));
    expect(next.toISOString().slice(0, 10)).toBe('2026-05-14');
  });
  it('wraps to next week: completing Fri with Mon-only', () => {
    // 2026-05-15 Fri -> next Mon 2026-05-18.
    const next = computeNextDueOn({ kind: 'weekly', weekdays: [1] }, new Date('2026-05-15T00:00:00Z'));
    expect(next.toISOString().slice(0, 10)).toBe('2026-05-18');
  });
});

describe('computeNextDueOn — monthlyWeekday', () => {
  it('first Monday', () => {
    const next = computeNextDueOn({ kind: 'monthlyWeekday', week: 1, weekday: 1 }, new Date('2026-05-10T00:00:00Z'));
    // June 2026: first Monday is 2026-06-01.
    expect(next.toISOString().slice(0, 10)).toBe('2026-06-01');
  });
  it('last Friday', () => {
    const next = computeNextDueOn({ kind: 'monthlyWeekday', week: -1, weekday: 5 }, new Date('2026-05-01T00:00:00Z'));
    // Last Friday of May 2026 is 2026-05-29.
    expect(next.toISOString().slice(0, 10)).toBe('2026-05-29');
  });
});

describe('computeNextDueOn — monthly last day', () => {
  it("'last' lands on the final day of the month", () => {
    const next = computeNextDueOn({ kind: 'monthly', dayOfMonth: 'last' }, new Date('2026-02-10T00:00:00Z'));
    expect(next.toISOString().slice(0, 10)).toBe('2026-02-28');
  });
});

describe('computeNextDueOn — seasonality', () => {
  it('interval jumps off-season to next in-season month', () => {
    // every 2 weeks, active Apr-Oct (4..10); completing 2026-10-25 -> +2wk is
    // 2026-11-08 (off) -> keep stepping until a date in Apr..Oct of 2027.
    const next = computeNextDueOn(
      { kind: 'interval', every: 2, unit: 'week', activeMonths: [4, 5, 6, 7, 8, 9, 10] },
      new Date('2026-10-25T00:00:00Z'),
    );
    const m = next.getUTCMonth() + 1;
    expect(m).toBeGreaterThanOrEqual(4);
    expect(m).toBeLessThanOrEqual(10);
    expect(next.getUTCFullYear()).toBe(2027);
  });
  it('weekly with bymonth filter only fires in active months', () => {
    // Mondays, active Nov-Feb only (11,12,1,2); complete 2026-05-12 -> next is
    // a Monday in Nov 2026.
    const next = computeNextDueOn(
      { kind: 'weekly', weekdays: [1], activeMonths: [11, 12, 1, 2] },
      new Date('2026-05-12T00:00:00Z'),
    );
    expect(next.getUTCMonth() + 1).toBe(11);
  });
  it('omitted activeMonths is year-round (unchanged)', () => {
    const next = computeNextDueOn({ kind: 'weekly', weekdays: [1] }, new Date('2026-05-12T00:00:00Z'));
    expect(next.toISOString().slice(0, 10)).toBe('2026-05-18');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run lib/reminders/recurrence.test.ts`
Expected: FAIL — new cases unimplemented; interval reads `rec.every` as undefined for some, etc.

- [ ] **Step 3: Rewrite `lib/reminders/recurrence.ts`.** Replace the file contents with:

```ts
import { RRule, type Weekday } from 'rrule';
import type { Recurrence } from './schema';

const DAY_MS = 86_400_000;
const FAR_FUTURE = new Date('9999-12-31T00:00:00.000Z');
const SKIP_CAP = 1000;

// Map JS weekday (0=Sun..6=Sat) -> rrule Weekday objects. rrule's own numbering
// is Mon=0..Sun=6, so NEVER pass a raw JS integer to byweekday; index this map.
const RRULE_WEEKDAY: Weekday[] = [
  RRule.SU, // 0
  RRule.MO, // 1
  RRule.TU, // 2
  RRule.WE, // 3
  RRule.TH, // 4
  RRule.FR, // 5
  RRule.SA, // 6
];

function inSeason(date: Date, activeMonths: number[] | undefined): boolean {
  if (!activeMonths) return true;
  return activeMonths.includes(date.getUTCMonth() + 1);
}

/**
 * First occurrence strictly after `completedOn` for a CALENDAR-anchored kind
 * (weekly/monthly/monthlyWeekday/yearly). These pin to a calendar slot via
 * `byXXX` rules, so seeding `dtstart = completedOn + DAY_MS` and taking the
 * first occurrence is correct.
 */
function firstAfter(opts: Partial<ConstructorParameters<typeof RRule>[0]>, completedOn: Date): Date {
  const after = new Date(completedOn.getTime() + DAY_MS);
  const rule = new RRule({ ...opts, dtstart: after, count: 1 });
  const [next] = rule.all();
  if (!next) throw new Error('rrule returned no occurrence');
  return next;
}

/**
 * `completedOn` advanced by `every` whole units (week/month/year), calendar-
 * aware. IMPORTANT: rrule's `interval` only spaces occurrences APART; it does
 * NOT offset the first one — occurrence #0 is always `dtstart`. So anchor at
 * `from` and take occurrence #1 (= from + interval). Verified: every-2-weeks
 * from 2026-04-30 -> 2026-05-14; every-3-months from 2026-01-15 -> 2026-04-15.
 */
function addUnits(from: Date, every: number, freq: number): Date {
  const rule = new RRule({ freq, interval: every, dtstart: from, count: 2 });
  const occ = rule.all();
  if (occ.length < 2) throw new Error('rrule returned no occurrence');
  return occ[1];
}

export function computeNextDueOn(rec: Recurrence, completedOn: Date): Date {
  switch (rec.kind) {
    case 'once':
      return FAR_FUTURE;
    case 'interval': {
      // day-unit keeps exact arithmetic (DST-free, completion-anchored); other
      // units use rrule for calendar correctness. Seasonality re-applies the
      // same step until the result lands in an active month.
      const step = (from: Date): Date => {
        if (rec.unit === 'day') return new Date(from.getTime() + rec.every * DAY_MS);
        const freq =
          rec.unit === 'week' ? RRule.WEEKLY : rec.unit === 'month' ? RRule.MONTHLY : RRule.YEARLY;
        return addUnits(from, rec.every, freq);
      };
      let next = step(completedOn);
      for (let i = 0; !inSeason(next, rec.activeMonths); i++) {
        if (i >= SKIP_CAP) throw new Error('seasonality skip-loop exceeded cap');
        next = step(next);
      }
      return next;
    }
    case 'weekly':
      return firstAfter(
        {
          freq: RRule.WEEKLY,
          byweekday: rec.weekdays.map((d) => RRULE_WEEKDAY[d]),
          ...(rec.activeMonths ? { bymonth: rec.activeMonths } : {}),
        },
        completedOn,
      );
    case 'monthly':
      return firstAfter(
        {
          freq: RRule.MONTHLY,
          bymonthday: rec.dayOfMonth === 'last' ? [-1] : [rec.dayOfMonth],
          ...(rec.activeMonths ? { bymonth: rec.activeMonths } : {}),
        },
        completedOn,
      );
    case 'monthlyWeekday':
      return firstAfter(
        {
          freq: RRule.MONTHLY,
          byweekday: [RRULE_WEEKDAY[rec.weekday]],
          bysetpos: [rec.week],
          ...(rec.activeMonths ? { bymonth: rec.activeMonths } : {}),
        },
        completedOn,
      );
    case 'yearly':
      return firstAfter(
        { freq: RRule.YEARLY, bymonth: [rec.month], bymonthday: [rec.day] },
        completedOn,
      );
  }
}

/** Project up to N future occurrences after a starting date (detail view + iCal). */
export function previewOccurrences(rec: Recurrence, startAfter: Date, count: number): Date[] {
  if (rec.kind === 'once') return [];
  const occ: Date[] = [];
  let cursor = startAfter;
  for (let i = 0; i < count; i++) {
    cursor = computeNextDueOn(rec, cursor);
    occ.push(cursor);
  }
  return occ;
}
```

> Note: `bymonth` already constrains calendar kinds to active months, so the seasonal skip-loop is only needed for `interval`. Confirm `firstAfter` with a `bymonth` that excludes the start still returns the next valid occurrence (rrule handles this).

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run lib/reminders/recurrence.test.ts`
Expected: PASS. The expected dates were verified against the real `rrule` for
2026/2027 (every-2-weeks 2026-04-30→2026-05-14; every-3-months 2026-01-15→
2026-04-15; every-1-year 2026-02-10→2027-02-10; weekday literals confirmed).
If a test fails, the implementation is wrong — fix `recurrence.ts`, NOT the
expectations. (The common trap: using `firstAfter`/`interval` for the unit
intervals returns the day after completion because rrule's `interval` doesn't
offset occurrence #0 — that's exactly why `addUnits` uses `count: 2` and takes
`[1]`.)

- [ ] **Step 5: Commit**

```bash
git add lib/reminders/recurrence.ts lib/reminders/recurrence.test.ts
git commit -m "feat(recurrence): compute next-due for new kinds + seasonality"
```

---

## Task 3: Data migration — rewrite legacy interval rows

**Files:**
- Create: `prisma/migrations/<timestamp>_normalize_interval_recurrence/migration.sql`

- [ ] **Step 1: Generate an empty migration** (no schema change — the column stays `Json`):

Run: `pnpm exec prisma migrate dev --create-only --name normalize_interval_recurrence`
Expected: creates an empty (or near-empty) `migration.sql`. If Prisma reports "no schema changes," create the directory + file manually with the same timestamped naming as siblings in `prisma/migrations/`.

- [ ] **Step 2: Write the SQL.** Replace the migration body with:

```sql
-- Normalize legacy interval recurrence { kind:'interval', days:N }
-- to the unit-based shape { kind:'interval', every:N, unit:'day' }.
UPDATE "reminders"
SET "recurrence" = ("recurrence" - 'days')
  || jsonb_build_object('every', ("recurrence"->'days'), 'unit', to_jsonb('day'::text))
WHERE "recurrence"->>'kind' = 'interval'
  AND "recurrence" ? 'days';
```

> The `recurrence` column is `jsonb`. Verify the column type with
> `\d reminders` if unsure; if it is `json` (not `jsonb`) the `-`/`||`/`?`
> operators won't apply — cast via `recurrence::jsonb` and store back. Eyeball
> the generated migration per the migration-drift discipline (no unexpected
> DROPs of pgvector indexes / XOR CHECK constraints).

- [ ] **Step 3: Apply and verify**

Run: `pnpm exec prisma migrate dev`
Expected: migration applies cleanly. Spot-check (if any legacy rows exist):
`SELECT recurrence FROM reminders WHERE recurrence->>'kind'='interval' LIMIT 5;` — each should have `every`+`unit`, no `days`.

- [ ] **Step 4: Commit**

```bash
git add prisma/migrations
git commit -m "feat(recurrence): migrate legacy interval {days} rows to {every,unit}"
```

---

## Task 4: Wire parseRecurrence into read sites + AI save

**Files:**
- Modify: `app/(app)/reminders/[id]/page.tsx:30`
- Modify: `app/(app)/reminders/[id]/edit/page.tsx:45`
- Modify: `app/api/calendar/[token]/route.ts:42`
- Modify: `lib/ai/suggest/reminders.ts:179`
- Modify: `lib/reminders/actions.ts:270`

- [ ] **Step 1: Replace each cast with `parseRecurrence(...)`.** At each site, swap `r.recurrence as unknown as Recurrence` (or `reminder.recurrence as unknown as Recurrence`) for `parseRecurrence(r.recurrence)` and add the import `import { parseRecurrence } from '@/lib/reminders/schema';` (keep the `Recurrence` type import where still used).

  - `app/(app)/reminders/[id]/page.tsx:30` → `const recurrence = parseRecurrence(r.recurrence);`
  - `app/(app)/reminders/[id]/edit/page.tsx:45` → `recurrence: parseRecurrence(r.recurrence),`
  - `app/api/calendar/[token]/route.ts:42` → `recurrence: parseRecurrence(r.recurrence),`
  - `lib/reminders/actions.ts:270` → `const recurrence = parseRecurrence(reminder.recurrence);`

- [ ] **Step 2: AI save boundary** — `lib/ai/suggest/reminders.ts` line ~179. The proposal carries the legacy `{days}` shape; normalize before computing/persisting:

```ts
const recurrence = parseRecurrence(r.recurrence);
const nextDueOn = computeNextDueOn(recurrence, today);
// ...and persist `recurrence` (the normalized value), not `r.recurrence`:
//   data: { ..., recurrence, ... }
```

Add `import { parseRecurrence } from '@/lib/reminders/schema';`. Update the `prisma.reminder.create`/related `data.recurrence` to use the normalized `recurrence`.

- [ ] **Step 3: Typecheck + run the affected integration tests**

Run: `pnpm exec tsc --noEmit 2>&1 | head -30`
Run: `pnpm vitest run tests/integration/ical-feed.test.ts tests/integration/reminders.test.ts tests/integration/ai`
Expected: typecheck clean (except the picker, Task 5/6); integration tests pass. The iCal feed and AI save now go through normalization.

- [ ] **Step 4: Commit**

```bash
git add app lib/ai/suggest/reminders.ts lib/reminders/actions.ts
git commit -m "feat(recurrence): normalize recurrence at all read + AI-save boundaries"
```

---

## Task 5: describeRecurrence helper for detail views

**Files:**
- Create: `lib/reminders/describe.ts`
- Test: `lib/reminders/describe.test.ts`

- [ ] **Step 1: Write failing tests** in `lib/reminders/describe.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { describeRecurrence } from './describe';

describe('describeRecurrence', () => {
  it('interval day', () => expect(describeRecurrence({ kind: 'interval', every: 60, unit: 'day' })).toBe('Every 60 days'));
  it('interval singular', () => expect(describeRecurrence({ kind: 'interval', every: 1, unit: 'week' })).toBe('Every week'));
  it('interval month plural', () => expect(describeRecurrence({ kind: 'interval', every: 3, unit: 'month' })).toBe('Every 3 months'));
  it('weekly multi', () => expect(describeRecurrence({ kind: 'weekly', weekdays: [1, 4] })).toBe('Every Mon & Thu'));
  it('monthly day', () => expect(describeRecurrence({ kind: 'monthly', dayOfMonth: 15 })).toBe('Monthly on the 15th'));
  it('monthly last', () => expect(describeRecurrence({ kind: 'monthly', dayOfMonth: 'last' })).toBe('Last day of the month'));
  it('monthlyWeekday last', () => expect(describeRecurrence({ kind: 'monthlyWeekday', week: -1, weekday: 5 })).toBe('Last Friday of the month'));
  it('yearly', () => expect(describeRecurrence({ kind: 'yearly', month: 4, day: 15 })).toBe('Every year on April 15'));
  it('once', () => expect(describeRecurrence({ kind: 'once' })).toBe('Once (does not repeat)'));
  it('season suffix', () => expect(describeRecurrence({ kind: 'interval', every: 2, unit: 'week', activeMonths: [4, 5, 6, 7, 8, 9, 10] })).toBe('Every 2 weeks (Apr–Oct)'));
  it('non-contiguous season suffix', () => expect(describeRecurrence({ kind: 'weekly', weekdays: [1], activeMonths: [3, 6, 9, 12] })).toBe('Every Mon (Mar, Jun, Sep, Dec)'));
  it('wrap-around season suffix (Nov–Feb)', () => expect(describeRecurrence({ kind: 'monthly', dayOfMonth: 1, activeMonths: [11, 12, 1, 2] })).toBe('Monthly on the 1st (Nov–Feb)'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run lib/reminders/describe.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/reminders/describe.ts`:**

```ts
import type { Recurrence } from './schema';

const WD_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON_SHORT = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MON_LONG = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEK_LABEL: Record<number, string> = { 1: 'First', 2: 'Second', 3: 'Third', 4: 'Fourth', [-1]: 'Last' };

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

// True if each step from one month to the next is +1 modulo 12, i.e. the
// sequence is a single unbroken run (e.g. [11,12,1,2] after rotation).
function consecutiveMod12(seq: number[]): boolean {
  for (let i = 1; i < seq.length; i++) {
    if (((seq[i] - seq[i - 1] + 12) % 12) !== 1) return false;
  }
  return true;
}

// Rotate a sorted set at its first gap so a wrap-around run becomes contiguous:
// [1,2,11,12] -> [11,12,1,2]. No gap (already a plain run) -> returned as-is.
function rotateToWrap(sorted: number[]): number[] {
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > 1) return [...sorted.slice(i), ...sorted.slice(0, i)];
  }
  return sorted;
}

function seasonSuffix(months: number[] | undefined): string {
  if (!months) return '';
  const sorted = [...months].sort((a, b) => a - b);
  if (sorted.length === 1) return ` (${MON_SHORT[sorted[0]]})`;
  if (consecutiveMod12(sorted)) {
    return ` (${MON_SHORT[sorted[0]]}–${MON_SHORT[sorted[sorted.length - 1]]})`;
  }
  const rot = rotateToWrap(sorted);
  if (consecutiveMod12(rot)) {
    return ` (${MON_SHORT[rot[0]]}–${MON_SHORT[rot[rot.length - 1]]})`;
  }
  return ` (${sorted.map((m) => MON_SHORT[m]).join(', ')})`;
}

export function describeRecurrence(rec: Recurrence): string {
  const season = 'activeMonths' in rec ? seasonSuffix(rec.activeMonths) : '';
  switch (rec.kind) {
    case 'once':
      return 'Once (does not repeat)';
    case 'interval': {
      const unit = rec.unit;
      const base = rec.every === 1 ? `Every ${unit}` : `Every ${rec.every} ${unit}s`;
      return base + season;
    }
    case 'weekly':
      return `Every ${rec.weekdays.map((d) => WD_SHORT[d]).join(' & ')}` + season;
    case 'monthly':
      return (rec.dayOfMonth === 'last' ? 'Last day of the month' : `Monthly on the ${ordinal(rec.dayOfMonth)}`) + season;
    case 'monthlyWeekday':
      return `${WEEK_LABEL[rec.week]} ${WD_LONG[rec.weekday]} of the month` + season;
    case 'yearly':
      return `Every year on ${MON_LONG[rec.month]} ${rec.day}` + season;
  }
}
```

> The contiguous/wrap helpers are fiddly; if a test fails, fix the helper, not
> the expectation. Keep the implementation honest — the tests pin Apr–Oct (run)
> and Mar/Jun/Sep/Dec (list).

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run lib/reminders/describe.test.ts`
Expected: PASS.

- [ ] **Step 5: Use it on the detail view.** In `app/(app)/reminders/[id]/page.tsx`, render `describeRecurrence(recurrence)` wherever the recurrence is currently shown (search the file for the existing recurrence display; if none exists, add a small line near the next-due section). Do NOT touch `SuggestionRow.tsx`.

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm exec tsc --noEmit 2>&1 | head -20
git add lib/reminders/describe.ts lib/reminders/describe.test.ts "app/(app)/reminders/[id]/page.tsx"
git commit -m "feat(recurrence): human-readable describeRecurrence on detail view"
```

---

## Task 6: RecurrencePicker UI

**Files:**
- Modify: `components/reminders/RecurrencePicker.tsx`

This task is UI wiring with no unit test (the component has none today; it's covered by e2e). Work in small commits and verify by typecheck + a manual run.

- [ ] **Step 1: Interval unit dropdown.** Add `unit` state (`'day'|'week'|'month'|'year'`, default `'day'`). Add a `<Select>` after the days `<Input>` with the four units. The interval row now emits `{ kind: 'interval', every: days, unit }` (rename the `days` state usage to `every` for clarity, or keep `days` as the variable feeding `every`). Update the label to "Every N <unit> from last completion".

- [ ] **Step 2: Weekly row.** Add a new radio option `value="weekly"`. When selected, reveal a 7-button weekday toggle group (Sun–Sat, JS order 0–6) backed by `weekdays: number[]` state (default `[1]`). Toggling updates the set; emit `{ kind: 'weekly', weekdays }` (guard: never emit an empty array — disable save / keep at least one). Use shadcn `ToggleGroup` if present, else a row of `Button variant={selected?'default':'outline'}`.

- [ ] **Step 3: Nth-weekday row.** Add radio `value="monthlyWeekday"`. Reveal a week `<Select>` (First=1, Second=2, Third=3, Fourth=4, Last=-1) + a weekday `<Select>` (Sun–Sat → 0–6). Emit `{ kind: 'monthlyWeekday', week, weekday }`.

- [ ] **Step 4: Monthly "last day".** On the existing monthly row, add a small toggle/checkbox "Last day of month". When checked, emit `{ kind: 'monthly', dayOfMonth: 'last' }` and disable the 1–28 input; when unchecked, fall back to the numeric `dayOfMonth`.

- [ ] **Step 5: Seasonality.** Below the kind radios, add a "Only certain months" toggle (hidden for `once` and `yearly`). When on, reveal a 12-button month toggle group (Jan–Dec → 1–12) backed by `activeMonths: number[]` state. Merge `activeMonths` into the emitted recurrence object only when the toggle is on AND ≥1 month selected; otherwise omit the field. Ensure `defaultValue` rehydrates `activeMonths` when editing.

- [ ] **Step 6: Rehydrate from `defaultValue`.** Extend the existing `useState` initializers so editing a reminder of any new kind pre-fills correctly (mirror the existing `defaultValue?.kind === ...` pattern for `weekly`, `monthlyWeekday`, monthly-`'last'`, unit, and `activeMonths`).

- [ ] **Step 7: Typecheck**

Run: `pnpm exec tsc --noEmit 2>&1 | head -20`
Expected: clean.

- [ ] **Step 8: Manual verification** (use the `verify` or `run` skill). Start the app, open `/reminders/new`, exercise each recurrence kind + a seasonal one, save, and confirm the detail view shows the right `describeRecurrence` label and a sane next-due date. Open the edit page to confirm rehydration.

- [ ] **Step 9: Commit**

```bash
git add components/reminders/RecurrencePicker.tsx
git commit -m "feat(recurrence): picker UI for weekdays, units, nth-weekday, last-day, seasonality"
```

---

## Task 7: Full verification

- [ ] **Step 1: Full test suite**

Run: `pnpm vitest run`
Expected: all pass.

- [ ] **Step 2: Lint + typecheck**

Run: `pnpm exec biome check . && pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 3: e2e (if the harness is available locally)** — exercise the reminders create/edit flow.

Run: `pnpm exec playwright test tests/e2e/` (or the project's e2e command)
Expected: pass, or note any pre-existing-failures unrelated to this change.

- [ ] **Step 4: Open PR.** Use `commit-commands:commit-push-pr` (or the project's PR flow) against `main`, summarizing the new recurrence kinds + seasonality and noting the JSON data migration.

---

## Out of scope (per spec)

- "Every N weeks on a specific weekday" (e.g. every other Monday) — use `interval` every-2-weeks (weekday not pinned) for now.
- Teaching the AI/LLM suggest path the new kinds — it keeps proposing the legacy subset; normalization happens at save.
