# Recurrence Expansion — Design

**Date:** 2026-05-20
**Status:** Approved (design)

## Goal

Extend reminder/chore recurrence beyond the current `interval` (days only) /
`monthly` / `yearly` / `once` set so users can express:

- **Days of week** — "every Monday", "every Tue & Fri".
- **Interval with units** — "every 2 weeks", "every 3 months", "every year" —
  calendar-aware, anchored to last completion.
- **Nth weekday of month** — "first Monday", "last Friday".
- **Last day of month** — "end of the month" chores.
- **Seasonality** — restrict any recurrence to a chosen set of active months
  (e.g. mow "every 2 weeks, Apr–Oct"; furnace filter "monthly, Nov–Feb").

"Weekly on a single day" is just the days-of-week picker with one day selected.

## Non-goals (v1)

- "Every N weeks **on a specific weekday**" (e.g. "every other Monday"). A
  multi-weekday `weekly` carries no interval multiplier; use `interval`
  (every 2, unit `week`) if you don't need the weekday pinned. Documented gap.
- RRULE-string storage / arbitrary iCal rules.

## Approach

Keep the existing **Zod discriminated union** stored as opaque `Json` on the
`Reminder` row (Approach A from brainstorming). Adding a pattern is a union
variant + a `computeNextDueOn` case + a picker row — no table schema change.

This preserves the core anchoring split:

- `interval` is anchored to **last completion** ("N units after I last did it").
- All other kinds are anchored to the **calendar** (next matching date after
  completion).

Rejected alternatives: a single RRULE string (can't express
"N days after completion", forces full migration); adding `weekly` without the
interval-unit rework (leaves "every 3 months" unsolved).

## Data model

`recurrenceSchema` (`lib/reminders/schema.ts`) final shape:

| kind             | shape                                              | anchor          | example            |
|------------------|----------------------------------------------------|-----------------|--------------------|
| `interval`       | `{ every: 1–3650, unit: 'day'\|'week'\|'month'\|'year' }` | last completion | every 3 months     |
| `weekly`         | `{ weekdays: number[] (0–6, unique, ≥1) }`         | calendar        | every Mon & Thu    |
| `monthly`        | `{ dayOfMonth: 1–28 \| 'last' }`                   | calendar        | 1st / last of month|
| `monthlyWeekday` | `{ week: 1\|2\|3\|4\|-1, weekday: 0–6 }`           | calendar        | last Friday        |
| `yearly`         | `{ month: 1–12, day: 1–28 }` *(unchanged)*         | calendar        | Apr 15             |
| `once`           | `{}` *(unchanged)*                                 | —               | one-shot           |

Weekday convention: `0 = Sunday … 6 = Saturday` (matches `rrule`'s
`RRule.SU..SA` weekday objects; map via the library's weekday constants).

### Seasonality (optional, orthogonal)

Seasonality is **not** a kind — it's an optional `activeMonths: number[]`
(1–12, unique, ≥1) added to every recurring variant (`interval`, `weekly`,
`monthly`, `monthlyWeekday`, `yearly`); omitted/`undefined` means year-round.
Not applicable to `once`. Each `discriminatedUnion` member gets the field via a
shared base extension so the `kind` discriminant still works.

Behavior: **jump to next in-season** — `computeNextDueOn` returns the first
occurrence whose month is in `activeMonths`.
- Calendar kinds (`weekly`, `monthly`, `monthlyWeekday`, `yearly`): pass
  `bymonth: activeMonths` to `rrule`, which filters natively.
- Completion-anchored `interval`: after computing the next occurrence, if its
  month ∉ `activeMonths`, step forward by the interval again until it lands
  in-season (safety cap of e.g. 1000 iterations; on exceeding it, **throw**
  rather than loop or silently return — schema guarantees ≥1 active month, so
  the cap should never be hit in practice).
- For `yearly` (single fixed month) seasonality is effectively a no-op and the
  picker won't offer it; validation allows it but it has no effect.

### Backward compatibility

Today's `interval` is `{ days: N }`. Strategy: **rewrite + keep shim.**

1. **Normalizer** — add `parseRecurrence(json: unknown): Recurrence` in
   `lib/reminders/schema.ts` that maps the legacy shape
   `{ kind: 'interval', days: N }` → `{ kind: 'interval', every: N, unit: 'day' }`
   before validating against `recurrenceSchema`. Use it at every DB read
   boundary that currently casts `recurrence as Recurrence` (recurrence is read
   back as `Json` and cast, not parsed, so a legacy row would otherwise produce
   `NaN` from `rec.every`).
   Read sites to wrap (enumerate during planning): the iCal feed builder
   (`lib/ical/build.ts` / `IcalReminderRow.recurrence`), detail-view occurrence
   projection, the `reminders-tick` worker, and `saveAcceptedReminders`.
2. **Data migration** — Prisma migration with raw SQL rewriting existing rows:
   `UPDATE reminders SET recurrence = recurrence - 'days' || jsonb_build_object('every', recurrence->'days', 'unit', '"day"'::jsonb) WHERE recurrence->>'kind' = 'interval' AND recurrence ? 'days';`
   (final SQL to be confirmed against the stored JSON; eyeball the generated
   migration per the migration-drift discipline).
3. The normalizer stays as defense even after the rewrite so any stragglers /
   external imports keep working.

## Recurrence math (`lib/reminders/recurrence.ts`)

`computeNextDueOn(rec, completedOn)` gains cases:

- `interval`, `unit === 'day'` — keep the exact `completedOn + every * DAY_MS`
  arithmetic (DST-free, no rrule). For `week`/`month`/`year` use `rrule`
  (`freq` WEEKLY/MONTHLY/YEARLY, `interval: every`, `count: 1`). **Avoid the
  off-by-one**: rrule treats `dtstart` itself as a candidate occurrence, so use
  `dtstart: completedOn + DAY_MS` exactly as the existing `monthly`/`yearly`
  cases do (they compute `after = completedOn + DAY_MS`), guaranteeing the
  result is strictly after the completion day.
- `weekly` — `rrule` `freq: WEEKLY`, `byweekday: weekdays.map(toRRuleWeekday)`,
  `dtstart: completedOn + DAY_MS`, `count: 1`.
- `monthly` — `bymonthday: dayOfMonth === 'last' ? -1 : dayOfMonth` (rrule
  resolves `-1` to the actual last day of each month).
- `monthlyWeekday` — `freq: MONTHLY`, `byweekday: weekday`, `bysetpos: week`,
  `dtstart: completedOn + DAY_MS`, `count: 1` (rrule resolves `bysetpos: -1` to
  the last matching weekday).
- `yearly`, `once` — unchanged.

When `activeMonths` is set: calendar kinds add `bymonth: activeMonths` to the
rrule; `interval` (all units, including day-unit plain arithmetic) wraps the
result in a skip-loop that **re-applies the same interval step** (e.g. day-unit
steps by `every` days, week-unit by `every` weeks) until `getUTCMonth()+1 ∈
activeMonths`, capped to throw. Note: a small day-unit `every` across a multi-
month off-season may take many iterations (e.g. every-3-days across a 5-month
gap ≈ 50 steps) — well under the cap.

`previewOccurrences` is unchanged (it just loops `computeNextDueOn`), so the
iCal feed (`lib/ical/build.ts`) and detail-view projections pick up the new
kinds automatically.

## UI

**`components/reminders/RecurrencePicker.tsx`**
- Interval row: existing number input + a new unit `<Select>`
  (day/week/month/year). Label reads "Every N <unit> from last completion".
- New weekly row: a weekday checkbox/toggle group (Sun–Sat), ≥1 required.
- New nth-weekday row: a week `<Select>` (First/Second/Third/Fourth/Last) + a
  weekday `<Select>`.
- Monthly row: add a "Last day" choice alongside the 1–28 input (e.g. a
  toggle that sets `dayOfMonth: 'last'`).
- Seasonality: a collapsed "Only certain months" toggle that reveals a 12-month
  picker (multi-select toggle group). Shown for all kinds except `once` and
  `yearly`. Empty selection clears `activeMonths` (year-round).
- Use shadcn primitives (`Select`, `Checkbox`/toggle group, `Input`) per repo
  convention; lucide icons where glyphs are needed.

**AI suggest path — keep the LLM surface simple (decision)**

There is a *second, independent* recurrence schema at `lib/ai/schemas.ts`
(`recurrenceSchema` / `ProposedRecurrence` / `proposedReminderSchema`) — a
strict subset (`interval {days}`, `monthly {dayOfMonth}`, `yearly`). We
**leave it unchanged**: the LLM keeps proposing only those simple shapes
(YAGNI — no value in teaching the model nth-weekday/seasonality; the user can
refine in the full reminder form after accepting).

The single required change is at the **save boundary**:
`saveAcceptedReminders` (`lib/ai/suggest/reminders.ts`) currently passes
`r.recurrence` straight into `computeNextDueOn` and persists it verbatim. Route
it through `parseRecurrence()` first so the legacy `{days}` proposal is
normalized to `{ every, unit: 'day' }` before `computeNextDueOn` (which will
now expect the new shape) and before persistence. `SuggestionRow.tsx`
(`formatRecurrence`, `defaultRecurrence`, the inline editor) stays as-is on the
legacy shape — no edits needed there.

**`components/reminders/RecurrencePicker.tsx` — recurrence label**
- The full reminder/chore form is where the new kinds + seasonality are edited
  (see above). For the human-readable label shown on detail views, extend the
  relevant formatter to render: "Every 3 months", "Every Mon & Thu",
  "Last Friday of the month", "Last day of the month", and a season suffix when
  `activeMonths` is set, e.g. "Every 2 weeks (Apr–Oct)". Add a new
  `describeRecurrence(rec: Recurrence): string` in `lib/reminders/` covering all
  kinds, used for **detail-view / persisted-recurrence display only**.
  `SuggestionRow.tsx` keeps its own `formatRecurrence` on the legacy
  `ProposedRecurrence` subset — do **not** unify them (the AI shape isn't
  assignable to `Recurrence`, so a helper typed on `Recurrence` won't accept it).

## Error handling

- `parseRecurrence()` throws on genuinely malformed JSON (existing rows are
  trusted to be one of the known shapes after normalization).
- Action boundary keeps Zod validation as today. Invariants:
  `weekdays` non-empty + unique + each 0–6; `week ∈ {1,2,3,4,-1}`;
  `weekday 0–6`; `every` 1–3650; `dayOfMonth` 1–28 or `'last'`;
  `activeMonths` (if present) non-empty + unique + each 1–12.

## Testing

Unit tests (`lib/reminders/recurrence.test.ts`):
- `interval` week/month/year next-due, incl. calendar correctness
  (Jan 31 + 1 month, Feb-end behavior) and a DST-boundary week interval.
- `weekly` single + multi-day, wrap-around (complete Fri → next Mon).
- `monthlyWeekday` nth + last (`bysetpos: -1`) incl. months with 4 vs 5 of a weekday.
- `monthly` `'last'` across 28/30/31-day months.
- Legacy `{ days: N }` → `{ every: N, unit: 'day' }` normalization round-trip.
- Seasonality: `interval` skip-loop jumps off-season → next in-season (incl.
  year wrap, e.g. complete in Nov with Apr–Oct window → next April); calendar
  kind with `bymonth` filter; `activeMonths` omitted = year-round (unchanged).

Schema tests also cover: reject empty/duplicate/out-of-range `activeMonths`.

Schema tests (`lib/reminders/schema.test.ts`):
- Reject empty/duplicate/out-of-range `weekdays`, bad `week`, bad `dayOfMonth`.
- `parseRecurrence` accepts both legacy and new interval shapes.
