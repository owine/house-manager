# Recurrence Multi-Value Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every recurrence kind hold multiple values (semi-monthly days, "first & third Monday", twice-a-year dates), add calendar-anchored bi-weekly to the `weekly` kind, and fix the Base UI label bug where coded selects render raw values ("1") instead of labels ("First").

**Architecture:** One shared pipeline drives all recurrence (Reminders **and** Chores, the detail page, the ICS feed): the Zod union + `parseRecurrence()` (`lib/reminders/schema.ts`), the rrule engine (`lib/reminders/recurrence.ts`), the renderer (`lib/reminders/describe.ts`), and the editor (`components/reminders/RecurrencePicker.tsx`). The canonical `Recurrence` type changes to array-valued shapes; legacy singular shapes are accepted at read-time via `parseRecurrence` normalization, so **no DB migration** is needed. The engine stays stateless — bi-weekly parity is preserved via an `anchor` stored inside the weekly recurrence JSON, set server-side.

**Tech Stack:** TypeScript, Zod (discriminated unions), `rrule`, Vitest, Next.js server actions, Base UI (`@base-ui/react`) Select/Popover, Tailwind/shadcn.

**Spec:** `docs/superpowers/specs/2026-05-21-recurrence-multivalue-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `lib/reminders/schema.ts` | `recurrenceSchema` union + `parseRecurrence` legacy normalizer | Modify |
| `lib/reminders/schema.test.ts` | schema validation + normalization tests | Modify |
| `lib/reminders/recurrence.ts` | `computeNextDueOn` / `previewOccurrences` (rrule) | Modify |
| `lib/reminders/recurrence.test.ts` | engine tests | Modify |
| `lib/reminders/describe.ts` | `describeRecurrence` renderer | Modify |
| `lib/reminders/describe.test.ts` | renderer tests | Modify |
| `lib/reminders/actions.ts` | create/update server actions — inject weekly `anchor` | Modify |
| `lib/ai/suggest/reminders.ts` | AI accept path | **Verify only** (already calls `parseRecurrence`; no change) |
| `components/reminders/RecurrencePicker.tsx` | the editor UI | Modify (largest) |

**Signatures unchanged:** `computeNextDueOn(rec, completedOn)` and `previewOccurrences(rec, startAfter, count)` keep their shapes — the `anchor` lives inside `rec`, so the detail page and ICS feed callers need no edits.

**Out of scope (verified):** `lib/ai/schemas.ts` and `components/ai/SuggestionRow.tsx` stay on the simple single-value shapes; the accept path already normalizes via `parseRecurrence`.

---

## Task 1: Schema — array-valued union + legacy normalization

**Files:**
- Modify: `lib/reminders/schema.ts`
- Test: `lib/reminders/schema.test.ts`

- [ ] **Step 1: Write failing tests for the new shapes + normalization**

Add to `lib/reminders/schema.test.ts` inside `describe('recurrenceSchema', …)` (replace the `it.each` rows for monthly/yearly that use the old single shapes, and add the new ones):

```ts
import { describe, expect, it } from 'vitest';
import { parseRecurrence, recurrenceSchema } from './schema';

describe('recurrenceSchema — array shapes', () => {
  it.each([
    // weekly + interval
    [{ kind: 'weekly', weekdays: [1], interval: 2 }, true],
    [{ kind: 'weekly', weekdays: [1] }, false], // interval is required (default applied only via parse)
    [{ kind: 'weekly', weekdays: [1], interval: 0 }, false],
    [{ kind: 'weekly', weekdays: [1], interval: 53 }, false],
    [{ kind: 'weekly', weekdays: [1], interval: 2, anchor: '2026-05-19' }, true],
    // monthly multi-day + last
    [{ kind: 'monthly', days: [1, 15], last: false }, true],
    [{ kind: 'monthly', days: [], last: true }, true],
    [{ kind: 'monthly', days: [], last: false }, false], // need at least one of days/last
    [{ kind: 'monthly', days: [1, 1], last: false }, false], // dup
    [{ kind: 'monthly', days: [29], last: false }, false], // >28
    // monthlyWeekday combos
    [{ kind: 'monthlyWeekday', combos: [{ week: 1, weekday: 1 }, { week: 3, weekday: 1 }] }, true],
    [{ kind: 'monthlyWeekday', combos: [] }, false],
    [
      { kind: 'monthlyWeekday', combos: [{ week: 1, weekday: 1 }, { week: 1, weekday: 1 }] },
      false,
    ], // dup pair
    [{ kind: 'monthlyWeekday', combos: [{ week: 0, weekday: 1 }] }, false], // bad week
    // yearly multi-date, day now 1..31
    [{ kind: 'yearly', dates: [{ month: 1, day: 1 }, { month: 7, day: 1 }] }, true],
    [{ kind: 'yearly', dates: [{ month: 1, day: 31 }] }, true], // 1..31 now allowed
    [{ kind: 'yearly', dates: [] }, false],
    [{ kind: 'yearly', dates: [{ month: 1, day: 1 }, { month: 1, day: 1 }] }, false], // dup
    [{ kind: 'yearly', dates: [{ month: 13, day: 1 }] }, false],
    [{ kind: 'yearly', dates: [{ month: 1, day: 32 }] }, false],
  ])('parses %j → success=%s', (input, expected) => {
    expect(recurrenceSchema.safeParse(input).success).toBe(expected);
  });
});

describe('parseRecurrence — legacy normalization', () => {
  it('weekly without interval → interval 1', () => {
    expect(parseRecurrence({ kind: 'weekly', weekdays: [1] })).toEqual({
      kind: 'weekly',
      weekdays: [1],
      interval: 1,
    });
  });
  it('monthly dayOfMonth number → days[]', () => {
    expect(parseRecurrence({ kind: 'monthly', dayOfMonth: 15 })).toEqual({
      kind: 'monthly',
      days: [15],
      last: false,
    });
  });
  it("monthly dayOfMonth 'last' → last:true", () => {
    expect(parseRecurrence({ kind: 'monthly', dayOfMonth: 'last' })).toEqual({
      kind: 'monthly',
      days: [],
      last: true,
    });
  });
  it('monthlyWeekday single → combos[]', () => {
    expect(parseRecurrence({ kind: 'monthlyWeekday', week: -1, weekday: 5 })).toEqual({
      kind: 'monthlyWeekday',
      combos: [{ week: -1, weekday: 5 }],
    });
  });
  it('yearly single → dates[]', () => {
    expect(parseRecurrence({ kind: 'yearly', month: 4, day: 15 })).toEqual({
      kind: 'yearly',
      dates: [{ month: 4, day: 15 }],
    });
  });
  it('legacy interval {days:N} still maps to {every,unit}', () => {
    expect(parseRecurrence({ kind: 'interval', days: 30 })).toEqual({
      kind: 'interval',
      every: 30,
      unit: 'day',
    });
  });
  it('preserves activeMonths through monthly normalization', () => {
    expect(parseRecurrence({ kind: 'monthly', dayOfMonth: 1, activeMonths: [7] })).toEqual({
      kind: 'monthly',
      days: [1],
      last: false,
      activeMonths: [7],
    });
  });
});
```

Also delete/replace the now-invalid old-shape rows in the existing `it.each` (the `{ kind: 'monthly', dayOfMonth: ... }` and `{ kind: 'yearly', month, day }` rows, and the `dayOfMonth: 'last'` assertion at ~line 180) — those shapes are no longer valid against `recurrenceSchema` directly (they're only accepted via `parseRecurrence`).

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm vitest run lib/reminders/schema.test.ts`
Expected: FAIL (new shapes rejected, normalization not implemented).

- [ ] **Step 3: Rewrite the union + normalizer in `lib/reminders/schema.ts`**

Replace the `recurrenceSchema` union members for `weekly`, `monthly`, `monthlyWeekday`, `yearly` and extend `parseRecurrence`:

```ts
const weekdaysSchema = z
  .array(z.number().int().min(0).max(6))
  .min(1)
  .refine((a) => new Set(a).size === a.length, { message: 'weekdays must be unique' });

const nthWeekSchema = z.union([
  z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1),
]);

const monthDaySchema = z.object({
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31), // 1..31; runtime clamps impossible days
});

export const recurrenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('interval'),
    every: z.number().int().min(1).max(3650),
    unit: z.enum(['day', 'week', 'month', 'year']),
    ...seasonal,
  }),
  // weekly — weekdays + interval (1=every week, 2=every other week, …) + optional
  // server-managed anchor (ISO date) used only when interval > 1 for stable parity.
  z.object({
    kind: z.literal('weekly'),
    weekdays: weekdaysSchema,
    interval: z.number().int().min(1).max(52),
    anchor: z.string().date().optional(),
    ...seasonal,
  }),
  // monthly — one or more days (1..28) and/or the last day of the month.
  z.object({
    kind: z.literal('monthly'),
    days: z
      .array(z.number().int().min(1).max(28))
      .refine((a) => new Set(a).size === a.length, { message: 'days must be unique' }),
    last: z.boolean(),
    ...seasonal,
  }).refine((r) => r.days.length > 0 || r.last, {
    message: 'monthly needs at least one day or last-of-month',
  }),
  // monthlyWeekday — one or more (week, weekday) combos, e.g. first & third Monday.
  z.object({
    kind: z.literal('monthlyWeekday'),
    combos: z
      .array(z.object({ week: nthWeekSchema, weekday: z.number().int().min(0).max(6) }))
      .min(1)
      .refine(
        (a) => new Set(a.map((c) => `${c.week}:${c.weekday}`)).size === a.length,
        { message: 'combos must be unique' },
      ),
    ...seasonal,
  }),
  // yearly — one or more month/day pairs; day 1..31 clamped at runtime. No seasonality.
  z.object({
    kind: z.literal('yearly'),
    dates: z
      .array(monthDaySchema)
      .min(1)
      .refine(
        (a) => new Set(a.map((d) => `${d.month}:${d.day}`)).size === a.length,
        { message: 'dates must be unique' },
      ),
  }),
  z.object({ kind: z.literal('once') }),
]);
```

Extend `parseRecurrence` — add legacy mappings before `recurrenceSchema.parse(candidate)`. Keep the existing `interval {days:N}` mapping, then add:

```ts
export function parseRecurrence(json: unknown): Recurrence {
  let candidate = json as Record<string, unknown> | null;
  if (candidate && typeof candidate === 'object') {
    const k = candidate.kind;
    // legacy interval {days:N} → {every:N, unit:'day'} (existing behavior)
    if (k === 'interval' && typeof candidate.days === 'number' && candidate.every === undefined) {
      const { days, ...rest } = candidate;
      candidate = { ...rest, every: days, unit: 'day' };
    }
    // legacy weekly without interval → interval 1
    else if (k === 'weekly' && candidate.interval === undefined) {
      candidate = { ...candidate, interval: 1 };
    }
    // legacy monthly {dayOfMonth} → {days, last}
    else if (k === 'monthly' && candidate.dayOfMonth !== undefined && candidate.days === undefined) {
      const { dayOfMonth, ...rest } = candidate;
      candidate =
        dayOfMonth === 'last'
          ? { ...rest, days: [], last: true }
          : { ...rest, days: [dayOfMonth], last: false };
    }
    // legacy monthlyWeekday {week, weekday} → {combos}
    else if (k === 'monthlyWeekday' && candidate.combos === undefined) {
      const { week, weekday, ...rest } = candidate;
      candidate = { ...rest, combos: [{ week, weekday }] };
    }
    // legacy yearly {month, day} → {dates}
    else if (k === 'yearly' && candidate.dates === undefined) {
      const { month, day, ...rest } = candidate;
      candidate = { ...rest, dates: [{ month, day }] };
    }
  }
  return recurrenceSchema.parse(candidate);
}
```

> Note: `anchor` uses `z.string().date()` (Zod's `YYYY-MM-DD` validator). Confirm the installed Zod version exposes `.date()`; if not, use `z.string().regex(/^\d{4}-\d{2}-\d{2}$/)`.

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm vitest run lib/reminders/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck (will surface every downstream break — expected)**

Run: `pnpm typecheck`
Expected: errors in `recurrence.ts`, `describe.ts`, `RecurrencePicker.tsx`, and their tests (old shapes). These are fixed in later tasks. Note them; do not fix unrelated code.

- [ ] **Step 6: Commit**

```bash
git add lib/reminders/schema.ts lib/reminders/schema.test.ts
git commit -m "feat(recurrence): array-valued schema + legacy parseRecurrence normalization"
```

---

## Task 2: Expansion engine — weekly interval/anchor, monthly multi-day, combos, yearly pairs

**Files:**
- Modify: `lib/reminders/recurrence.ts`
- Test: `lib/reminders/recurrence.test.ts`

- [ ] **Step 1: Migrate existing tests to new shapes + add new cases**

In `lib/reminders/recurrence.test.ts`, update every inline old shape to the new canonical shape, and add coverage. Examples of migrations and new tests:

```ts
// MIGRATIONS (old → new):
//   { kind: 'monthly', dayOfMonth: 15 }            → { kind: 'monthly', days: [15], last: false }
//   { kind: 'monthly', dayOfMonth: 'last' }        → { kind: 'monthly', days: [], last: true }
//   { kind: 'weekly', weekdays: [1] }              → { kind: 'weekly', weekdays: [1], interval: 1 }
//   { kind: 'monthlyWeekday', week: 1, weekday: 1 }→ { kind: 'monthlyWeekday', combos: [{ week: 1, weekday: 1 }] }
//   { kind: 'yearly', month: 3, day: 15 }          → { kind: 'yearly', dates: [{ month: 3, day: 15 }] }

describe('computeNextDueOn — multi-value & bi-weekly', () => {
  it('weekly interval 1 unchanged: next Monday after a Tuesday', () => {
    const d = computeNextDueOn(
      { kind: 'weekly', weekdays: [1], interval: 1 },
      new Date('2026-05-12T00:00:00Z'), // Tue
    );
    expect(d.toISOString().slice(0, 10)).toBe('2026-05-18'); // Mon
  });

  it('weekly interval 2 (every other Tuesday) holds parity from anchor', () => {
    const rec = {
      kind: 'weekly' as const,
      weekdays: [2], // Tue
      interval: 2,
      anchor: '2026-05-19', // a Tuesday
    };
    // Completing on the anchor Tuesday → next is +2 weeks, not +1.
    const d1 = computeNextDueOn(rec, new Date('2026-05-19T00:00:00Z'));
    expect(d1.toISOString().slice(0, 10)).toBe('2026-06-02');
    // Completing slightly late (Thu after) still lands on the on-parity Tuesday.
    const d2 = computeNextDueOn(rec, new Date('2026-05-21T00:00:00Z'));
    expect(d2.toISOString().slice(0, 10)).toBe('2026-06-02');
  });

  it('monthly multi-day: 1 & 15 picks the nearest upcoming', () => {
    const rec = { kind: 'monthly' as const, days: [1, 15], last: false };
    expect(
      computeNextDueOn(rec, new Date('2026-05-03T00:00:00Z')).toISOString().slice(0, 10),
    ).toBe('2026-05-15');
    expect(
      computeNextDueOn(rec, new Date('2026-05-16T00:00:00Z')).toISOString().slice(0, 10),
    ).toBe('2026-06-01');
  });

  it('monthly days + last: last-day competes with explicit days', () => {
    const rec = { kind: 'monthly' as const, days: [15], last: true };
    expect(
      computeNextDueOn(rec, new Date('2026-05-16T00:00:00Z')).toISOString().slice(0, 10),
    ).toBe('2026-05-31'); // last day of May
  });

  it('monthlyWeekday combos: first & third Monday', () => {
    const rec = {
      kind: 'monthlyWeekday' as const,
      combos: [{ week: 1, weekday: 1 }, { week: 3, weekday: 1 }],
    };
    const first = computeNextDueOn(rec, new Date('2026-05-01T00:00:00Z'));
    expect(first.toISOString().slice(0, 10)).toBe('2026-05-04'); // first Mon
    const next = computeNextDueOn(rec, first);
    expect(next.toISOString().slice(0, 10)).toBe('2026-05-18'); // third Mon
  });

  it('monthlyWeekday mixed combos: first Monday + last Friday', () => {
    const rec = {
      kind: 'monthlyWeekday' as const,
      combos: [{ week: 1, weekday: 1 }, { week: -1, weekday: 5 }],
    };
    expect(
      computeNextDueOn(rec, new Date('2026-05-05T00:00:00Z')).toISOString().slice(0, 10),
    ).toBe('2026-05-29'); // last Fri of May
  });

  it('yearly multi-date: Jan 1 & Jul 1 alternates', () => {
    const rec = { kind: 'yearly' as const, dates: [{ month: 1, day: 1 }, { month: 7, day: 1 }] };
    const a = computeNextDueOn(rec, new Date('2026-03-01T00:00:00Z'));
    expect(a.toISOString().slice(0, 10)).toBe('2026-07-01');
    const b = computeNextDueOn(rec, a);
    expect(b.toISOString().slice(0, 10)).toBe('2027-01-01');
  });

  it('yearly clamps impossible day: Feb 31 → Feb 28 (2026 non-leap)', () => {
    const rec = { kind: 'yearly' as const, dates: [{ month: 2, day: 31 }] };
    expect(
      computeNextDueOn(rec, new Date('2026-01-01T00:00:00Z')).toISOString().slice(0, 10),
    ).toBe('2026-02-28');
  });

  it('previewOccurrences alternates a multi-date yearly recurrence', () => {
    const rec = { kind: 'yearly' as const, dates: [{ month: 1, day: 1 }, { month: 7, day: 1 }] };
    const occ = previewOccurrences(rec, new Date('2026-03-01T00:00:00Z'), 4).map((d) =>
      d.toISOString().slice(0, 10),
    );
    expect(occ).toEqual(['2026-07-01', '2027-01-01', '2027-07-01', '2028-01-01']);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm vitest run lib/reminders/recurrence.test.ts`
Expected: FAIL (compile errors on new shapes / wrong results).

- [ ] **Step 3: Implement the engine changes in `lib/reminders/recurrence.ts`**

Add a yearly helper near `addMonthsClamped`:

```ts
/** Next occurrence of (month, day) strictly after `after`, clamping day to month length. */
function nextYearlyDate(after: Date, month: number, day: number): Date {
  for (let year = after.getUTCFullYear(); ; year++) {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate(); // day 0 of next month
    const cand = new Date(Date.UTC(year, month - 1, Math.min(day, lastDay)));
    if (cand.getTime() > after.getTime()) return cand;
  }
}
```

Rewrite the `weekly`, `monthly`, `monthlyWeekday`, and `yearly` cases of `computeNextDueOn`:

```ts
case 'weekly': {
  const byweekday = rec.weekdays.map((d) => RRULE_WEEKDAY[d]);
  if (rec.interval > 1) {
    // Stable parity: anchor the rule to a fixed origin and find the first
    // occurrence strictly after completedOn. Fall back to completedOn if no
    // anchor was persisted (shouldn't happen once actions inject it).
    const anchor = rec.anchor ? new Date(`${rec.anchor}T00:00:00.000Z`) : completedOn;
    const rule = new RRule({
      freq: RRule.WEEKLY,
      interval: rec.interval,
      byweekday,
      dtstart: anchor,
      ...(rec.activeMonths ? { bymonth: rec.activeMonths } : {}),
    });
    const after = rule.after(completedOn, /* inc */ false);
    if (!after) throw new Error('rrule returned no weekly occurrence');
    next = after;
  } else {
    next = firstAfter(
      {
        freq: RRule.WEEKLY,
        byweekday,
        ...(rec.activeMonths ? { bymonth: rec.activeMonths } : {}),
      },
      completedOn,
    );
  }
  break;
}
case 'monthly': {
  const bymonthday = [...rec.days, ...(rec.last ? [-1] : [])];
  next = firstAfter(
    {
      freq: RRule.MONTHLY,
      bymonthday,
      ...(rec.activeMonths ? { bymonth: rec.activeMonths } : {}),
    },
    completedOn,
  );
  break;
}
case 'monthlyWeekday':
  next = firstAfter(
    {
      freq: RRule.MONTHLY,
      byweekday: rec.combos.map((c) => RRULE_WEEKDAY[c.weekday].nth(c.week)),
      ...(rec.activeMonths ? { bymonth: rec.activeMonths } : {}),
    },
    completedOn,
  );
  break;
case 'yearly': {
  const candidates = rec.dates.map((d) => nextYearlyDate(completedOn, d.month, d.day));
  next = candidates.reduce((min, c) => (c.getTime() < min.getTime() ? c : min));
  break;
}
```

> `RRULE_WEEKDAY[d]` entries are rrule `Weekday` instances and expose `.nth(n)`; this replaces the old single `bysetpos`. The yearly branch no longer uses rrule (pairs aren't a cross-product). `nextYearlyDate` returns UTC midnight already, and `toUtcMidnight(next)` at the end is harmless/idempotent.

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm vitest run lib/reminders/recurrence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/reminders/recurrence.ts lib/reminders/recurrence.test.ts
git commit -m "feat(recurrence): bi-weekly anchor, multi-day monthly, weekday combos, yearly pairs"
```

---

## Task 3: Descriptions

**Files:**
- Modify: `lib/reminders/describe.ts`
- Test: `lib/reminders/describe.test.ts`

- [ ] **Step 1: Migrate + add failing tests**

Update old shapes in `describe.test.ts` and add:

```ts
it('weekly every other single weekday', () =>
  expect(describeRecurrence({ kind: 'weekly', weekdays: [2], interval: 2 })).toBe(
    'Every other Tuesday',
  ));
it('weekly interval >2 multi', () =>
  expect(describeRecurrence({ kind: 'weekly', weekdays: [1, 3], interval: 3 })).toBe(
    'Every 3 weeks on Mon & Wed',
  ));
it('weekly interval 1 multi unchanged', () =>
  expect(describeRecurrence({ kind: 'weekly', weekdays: [1, 4], interval: 1 })).toBe(
    'Every Mon & Thu',
  ));
it('monthly multi-day', () =>
  expect(describeRecurrence({ kind: 'monthly', days: [1, 15], last: false })).toBe(
    'Monthly on the 1st & 15th',
  ));
it('monthly days + last', () =>
  expect(describeRecurrence({ kind: 'monthly', days: [15], last: true })).toBe(
    'Monthly on the 15th + last day',
  ));
it('monthly only last', () =>
  expect(describeRecurrence({ kind: 'monthly', days: [], last: true })).toBe(
    'Last day of the month',
  ));
it('monthlyWeekday combos', () =>
  expect(
    describeRecurrence({
      kind: 'monthlyWeekday',
      combos: [{ week: 1, weekday: 1 }, { week: 3, weekday: 1 }],
    }),
  ).toBe('First & Third Monday of the month'));
it('monthlyWeekday mixed combos', () =>
  expect(
    describeRecurrence({
      kind: 'monthlyWeekday',
      combos: [{ week: 1, weekday: 1 }, { week: -1, weekday: 5 }],
    }),
  ).toBe('First Monday & Last Friday of the month'));
it('yearly multi-date', () =>
  expect(
    describeRecurrence({ kind: 'yearly', dates: [{ month: 1, day: 1 }, { month: 7, day: 1 }] }),
  ).toBe('Every year on Jan 1 & Jul 1'));
```

> Decide and lock the exact strings here — they are the assertion source of truth. The combos phrasing collapses a shared weekday ("First & Third Monday") but spells out mixed pairs ("First Monday & Last Friday").

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run lib/reminders/describe.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the new cases in `describe.ts`**

```ts
case 'interval': { /* unchanged */ }
case 'weekly': {
  const days = rec.weekdays.map((d) => WD_SHORT[d]).join(' & ');
  if (rec.interval === 1) return `Every ${days}${season}`;
  if (rec.interval === 2 && rec.weekdays.length === 1)
    return `Every other ${WD_LONG[rec.weekdays[0]]}${season}`;
  return `Every ${rec.interval} weeks on ${days}${season}`;
}
case 'monthly': {
  const dayList = rec.days.map((d) => ordinal(d)).join(' & ');
  let base: string;
  if (rec.days.length === 0) base = 'Last day of the month';
  else base = `Monthly on the ${dayList}${rec.last ? ' + last day' : ''}`;
  return base + season;
}
case 'monthlyWeekday': {
  // Collapse a shared weekday: "First & Third Monday"; otherwise spell out pairs.
  const uniqWeekdays = new Set(rec.combos.map((c) => c.weekday));
  let label: string;
  if (uniqWeekdays.size === 1) {
    const wd = WD_LONG[rec.combos[0].weekday];
    label = `${rec.combos.map((c) => WEEK_LABEL[c.week]).join(' & ')} ${wd}`;
  } else {
    label = rec.combos.map((c) => `${WEEK_LABEL[c.week]} ${WD_LONG[c.weekday]}`).join(' & ');
  }
  return `${label} of the month${season}`;
}
case 'yearly':
  return `Every year on ${rec.dates.map((d) => `${MON_SHORT[d.month]} ${d.day}`).join(' & ')}`;
```

> `season` is unchanged. Yearly still has no `activeMonths`, so no season suffix. Verify `WD_LONG`, `WEEK_LABEL`, `MON_SHORT`, `ordinal` are already defined (they are).
> **Intentional phrasing change (not a regression):** yearly now uses `MON_SHORT` ("Jan 1") where the old single-value code used `MON_LONG` ("January 1"). Update the existing yearly describe test assertion accordingly — it is a deliberate change, not a contradiction.

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run lib/reminders/describe.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/reminders/describe.ts lib/reminders/describe.test.ts
git commit -m "feat(recurrence): describe multi-value & bi-weekly phrasings"
```

---

## Task 4: Server actions — inject weekly anchor

**Files:**
- Modify: `lib/reminders/actions.ts`
- Verify: `lib/ai/suggest/reminders.ts` (no change expected)
- Test: `lib/reminders/actions.test.ts` (create if absent) **or** add to `tests/integration/reminders.test.ts`

**Background:** When `weekly.interval > 1`, persist an `anchor` (the seed `nextDueOn`, as `YYYY-MM-DD`) so parity is stable. Do it in the create path and the update path; re-anchor on **any** weekly edit while `interval > 1` (per spec). The AI accept path already calls `parseRecurrence` then `computeNextDueOn`, so it inherits correct behavior without an anchor (interval is always 1 from the AI schema) — verify only.

- [ ] **Step 1: Write a failing unit test for the anchor helper**

Create `lib/reminders/anchor.ts` as the single home for this pure logic, and `lib/reminders/anchor.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { withWeeklyAnchor } from './anchor';

describe('withWeeklyAnchor', () => {
  const due = new Date('2026-05-19T00:00:00Z'); // Tue
  it('sets anchor on weekly interval > 1', () => {
    const r = withWeeklyAnchor({ kind: 'weekly', weekdays: [2], interval: 2 }, due);
    expect(r).toEqual({ kind: 'weekly', weekdays: [2], interval: 2, anchor: '2026-05-19' });
  });
  it('leaves interval 1 weekly untouched (no anchor)', () => {
    const r = withWeeklyAnchor({ kind: 'weekly', weekdays: [2], interval: 1 }, due);
    expect(r).toEqual({ kind: 'weekly', weekdays: [2], interval: 1 });
  });
  it('passes through non-weekly kinds unchanged', () => {
    const r = withWeeklyAnchor({ kind: 'monthly', days: [1], last: false }, due);
    expect(r).toEqual({ kind: 'monthly', days: [1], last: false });
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run lib/reminders/anchor.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `lib/reminders/anchor.ts`**

```ts
import type { Recurrence } from './schema';

/** Format a Date as YYYY-MM-DD in UTC. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * For weekly recurrences with interval > 1, stamp a stable `anchor` (the seed
 * due date) so bi-weekly+ parity does not drift across completions. All other
 * recurrences (and interval === 1 weekly) are returned unchanged.
 */
export function withWeeklyAnchor(rec: Recurrence, seedDueOn: Date): Recurrence {
  if (rec.kind !== 'weekly' || rec.interval <= 1) return rec;
  return { ...rec, anchor: isoDate(seedDueOn) };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run lib/reminders/anchor.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `withWeeklyAnchor` into `actions.ts`**

In the create and update server actions, after the recurrence is parsed/validated and the seed `nextDueOn` is known, replace the stored recurrence with `withWeeklyAnchor(recurrence, nextDueOn)`. Read `lib/reminders/actions.ts` to find the exact create/update insertion points (where `recurrence` is written to `prisma.reminder.create`/`update`). The `nextDueOn` used for the anchor must be the per-reminder seed due date the form supplies (`createReminderSchema.nextDueOn`). On update, recompute the anchor from the (possibly new) `nextDueOn` so any weekly edit re-anchors.

- [ ] **Step 6: Verify the AI path needs no change**

Read `lib/ai/suggest/reminders.ts:177-198`. Confirm it calls `parseRecurrence(r.recurrence)` then `computeNextDueOn`. Since the AI `recurrenceSchema` only emits `interval`/`monthly`/`yearly` (never `weekly`), no anchor is needed. Leave unchanged. (If a future AI weekly is added, route it through `withWeeklyAnchor` too.)

- [ ] **Step 7: Typecheck + run reminder tests**

Run: `pnpm typecheck && pnpm vitest run lib/reminders`
Expected: PASS (engine/describe/schema/anchor green; `actions.ts` compiles).

- [ ] **Step 8: Commit**

```bash
git add lib/reminders/anchor.ts lib/reminders/anchor.test.ts lib/reminders/actions.ts
git commit -m "feat(recurrence): stamp stable anchor for bi-weekly on create/update"
```

---

## Task 5: Picker UI — label fix + bi-weekly + multi-value controls

**Files:**
- Modify: `components/reminders/RecurrencePicker.tsx`
- Test: manual via `pnpm dev` + a component smoke test if the repo has a pattern for it (search `components/**/*.test.tsx`); otherwise rely on `buildRecurrence` correctness exercised through schema/engine tests.

**This is the largest task.** Work it in sub-steps, committing after each coherent control so review is easy. Preserve the existing single-`State`-object + `update()`/`buildRecurrence()` merge pattern (it deliberately avoids updating the parent Controller during render).

### 5a — State + buildRecurrence rewrite

- [ ] **Step 1: Update the `State` type and `buildRecurrence`/`initialState`**

Replace single-value fields with the array shapes and transient add-row inputs:

```ts
type Combo = { week: NthWeek; weekday: number };
type MonthDay = { month: number; day: number };

type State = {
  kind: Recurrence['kind'];
  every: number;
  unit: 'day' | 'week' | 'month' | 'year';
  weekdays: number[];
  weeklyInterval: number;       // NEW: 1 = every week
  monthlyDays: number[];        // NEW: replaces dayOfMonth
  monthlyLast: boolean;
  monthlyDayInput: number;      // NEW: transient "add day" field
  nthCombos: Combo[];           // NEW: replaces nthWeek/nthWeekday
  nthWeekInput: NthWeek;        // NEW: transient
  nthWeekdayInput: number;      // NEW: transient
  yearlyDates: MonthDay[];      // NEW: replaces yearMonth/yearDay
  seasonEnabled: boolean;
  activeMonths: number[];
};
```

`buildRecurrence` cases:

```ts
case 'weekly':
  return withSeason(
    { kind: 'weekly', weekdays: s.weekdays, interval: s.weeklyInterval }, s,
  );
case 'monthly':
  return withSeason(
    { kind: 'monthly', days: [...s.monthlyDays].sort((a, b) => a - b), last: s.monthlyLast }, s,
  );
case 'monthlyWeekday':
  return withSeason({ kind: 'monthlyWeekday', combos: s.nthCombos }, s);
case 'yearly':
  return { kind: 'yearly', dates: s.yearlyDates };
```

`initialState` must hydrate the new arrays from `defaultValue` (note `defaultValue` is already canonical — the form passes a parsed `Recurrence`). Provide sane empties/defaults: `weeklyInterval: dv?.kind==='weekly' ? dv.interval : 1`, `monthlyDays: dv?.kind==='monthly' ? dv.days : [1]`, `monthlyLast: dv?.kind==='monthly' ? dv.last : false`, `nthCombos: dv?.kind==='monthlyWeekday' ? dv.combos : [{ week: 1, weekday: 1 }]`, `yearlyDates: dv?.kind==='yearly' ? dv.dates : [{ month: 1, day: 1 }]`, plus transient inputs (`monthlyDayInput: 1`, `nthWeekInput: 1`, `nthWeekdayInput: 1`).

> Guardrail: never emit an empty `monthlyDays` while `monthlyLast` is false, never empty `nthCombos`, never empty `yearlyDates` — mirror the existing `toggleWeekday` "keep at least one" guard. The schema refines enforce this, so the UI must not let the user reach an invalid state.

- [ ] **Step 2: Typecheck the component in isolation**

Run: `pnpm typecheck`
Expected: errors only within the JSX you haven't rewritten yet (next sub-steps).

### 5b — Label-bug fix on coded single Selects

- [ ] **Step 3: Fix `<SelectValue/>` rendering for coded selects**

Base UI's `SelectValue` shows the raw value unless given a way to map value→label. Use the pattern from `components/items/ItemsFilterBar.tsx` (read it first to copy the exact prop usage — `items` on `Select.Root`, or a render-function child on `SelectValue`). Apply to: the yearly month select(s), and the nth-weekday position/weekday selects used in the add-row. Verify by eye in 5g that triggers read "First"/"Monday"/"January".

### 5c — weekly interval input

- [ ] **Step 4: Add the "every N weeks" input to the weekly row**

Before the weekday `ToggleRow`, add a number `Input` (min 1, max 52) bound to `state.weeklyInterval` via `update({ weeklyInterval: clampInt(e.target.value, 1, 52, 1) })`, with surrounding copy like "Every `[N]` week(s) on:".

### 5d — monthly multi-day chips

- [ ] **Step 5: Replace the single day input with input + Add → chips**

Number `Input` (1–28) bound to `state.monthlyDayInput`, an Add `Button` that appends to `monthlyDays` (dedup, ignore if present), and a chip row rendering each day with a remove control. Keep the "Last day of month" `Switch` bound to `monthlyLast`. Guard: removing the last chip while `monthlyLast` is false is disallowed (or auto-enables nothing — keep ≥1 day unless last is on).

### 5e — monthlyWeekday combo chips

- [ ] **Step 6: Replace the two bare selects with position + weekday selects + Add → combo chips**

Position `Select` (`NTH_WEEKS`) bound to `nthWeekInput`, weekday `Select` (`WEEKDAY_LONG`) bound to `nthWeekdayInput`, Add `Button` appending `{ week, weekday }` to `nthCombos` (dedup on `week:weekday`), chip row ("First Monday ×"). Both selects get the label fix from 5b.

### 5f — yearly collapsible calendar

- [ ] **Step 7: Build the collapsed chips + "Add date" Popover calendar**

Use `components/ui/popover.tsx` (Base UI Popover). Inside, a hand-rolled month grid:
- Local popover state: `viewMonth` (1–12), prev/next buttons cycling 1↔12.
- Render weekday header + a grid of day buttons 1..(days in `viewMonth`, using a fixed non-leap reference so Feb shows 28; **but allow up to 31** — show all real days of that month; the *value stored* is just `{month, day}`, day 1–31, runtime clamps). Clicking a day appends `{ month: viewMonth, day }` to `yearlyDates` (dedup on `month:day`) and closes/keeps-open the popover (keep open so multiple can be added).
- Collapsed view: chip row of `yearlyDates` ("Jan 1 ×") + an "Add date" trigger button.
- Year is never shown or stored.

> Keep this grid simple and local; do not add a dependency. A reference like `new Date(Date.UTC(2025, viewMonth, 0)).getUTCDate()` gives the day count for the chosen month (use a 31-capable reference month; for the picker we want to *offer* up to 31, so just hardcode per-month lengths `[31,29,31,30,31,30,31,31,30,31,30,31]` — offer Feb 29 too since runtime clamps).

### 5g — manual verification

- [ ] **Step 8: Run the app and verify each control**

Use the `run` skill / `pnpm dev`. On a reminder create/edit form (and confirm a Chores form too, since both use `ReminderForm`):
- Verify the **label bug is gone**: nth-weekday position/weekday and yearly month read words, not "1".
- Add monthly days 1 & 15 → chips; toggle last day.
- Add "First Monday" + "Third Monday" combos.
- Set weekly to "every 2 weeks on Tue".
- Open the yearly calendar, scroll months, add Jan 1 & Jul 1.
- Save, reopen the form, confirm values round-trip (this exercises `initialState` hydration from the canonical `defaultValue`).
- Check the detail page description renders the new phrasings.

- [ ] **Step 9: Lint + full test + typecheck**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run lib/reminders`
Expected: PASS. Fix any `knip`/biome findings (e.g. now-unused `NthWeek` helpers or constants).

- [ ] **Step 10: Commit (per sub-control or once at the end)**

```bash
git add components/reminders/RecurrencePicker.tsx
git commit -m "feat(recurrence): multi-value picker controls, bi-weekly input, label fix"
```

---

## Task 6: Full-suite green + integration sanity

**Files:** none (verification task)

- [ ] **Step 1: Run the unit + integration suites**

Run: `pnpm test:unit && pnpm test:integration`
Expected: PASS. Pay attention to `tests/integration/reminders*.test.ts`, `tests/integration/ical-feed.test.ts`, and `tests/integration/ai/*` — they round-trip recurrence through the DB and `parseRecurrence`. If any construct old shapes inline, migrate them, or (better) confirm they go through `parseRecurrence` and thus accept legacy.

- [ ] **Step 2: Grep for any remaining old-shape constructors**

Run: `grep -rn "dayOfMonth\|kind: 'yearly', month\|week: .*weekday:" --include="*.ts" --include="*.tsx" lib components app tests | grep -v node_modules`
Expected: only `components/ai/SuggestionRow.tsx` + `lib/ai/schemas*.ts` (intentionally legacy/single-value) and `parseRecurrence` internals. Anything else in the canonical path is a missed migration.

- [ ] **Step 3: Final typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A && git commit -m "test(recurrence): migrate remaining inline shapes; full suite green"
```

---

## Notes & Risks

- **`rrule` `.nth()` + `bymonth`:** combining `BYDAY=1MO,3MO` with `BYMONTH` (seasonality) is valid in rrule; the multi nth-weekday test plus a seasonal case will confirm.
- **`anchor` format:** stored as `YYYY-MM-DD`; parsed back with `new Date(`${anchor}T00:00:00.000Z`)`. Keep both sides UTC.
- **No DB migration:** existing rows are normalized on read by `parseRecurrence`. Do **not** add a Prisma migration.
- **Zod `.string().date()`:** if unavailable in the installed Zod version, fall back to a `YYYY-MM-DD` regex (noted in Task 1).
- **Picker round-trip:** `ReminderForm` passes a parsed canonical `Recurrence` as `defaultValue`; `initialState` must read the new array fields, not the legacy ones.
```
