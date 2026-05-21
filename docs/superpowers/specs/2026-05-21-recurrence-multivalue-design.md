# Recurrence: multi-value, bi-weekly, and label-fix — Design

**Date:** 2026-05-21
**Status:** Approved (design)
**Scope:** `lib/reminders/schema.ts`, `lib/reminders/recurrence.ts`, `lib/reminders/describe.ts`, `components/reminders/RecurrencePicker.tsx`, `lib/reminders/actions.ts`, `lib/ai/suggest/reminders.ts`, plus tests.

## Problem

Three user-reported issues, all in the recurrence subsystem:

1. **Label bug.** The "On the [nth] [weekday] of every month" row and the "Every year on [month] [day]" row render raw stored values ("1", "1") instead of labels ("First", "Monday", "January"). This is a Base UI `Select.Value` behavior: with no item-to-label mapping, the trigger shows the raw `value`. The unit dropdown only *looks* correct because its value (`"day"`) reads like a label.
2. **No bi-weekly / "every other week".** A calendar-anchored "every other Tuesday" cannot be expressed. (`{kind:'interval', every:2, unit:'week'}` exists but is anchored to last completion, so it drifts and is not weekday-pinned.)
3. **No multiple values of the same kind.** "Every month on day 1 **and** 15" (semi-monthly), "first **and** third Monday", and twice-a-year dates cannot be expressed. Only `weekly` currently accepts multiple values (multiple weekdays).

These all live in a single shared pipeline, so fixing them is one coordinated change rather than per-page work.

## Architecture context

Recurrence flows through four files, shared by Reminders **and** Chores (which differ only by a `ReminderKind` flag), plus the reminder detail page and the ICS feed:

- **`lib/reminders/schema.ts`** — the `recurrenceSchema` discriminated union (Zod) and `parseRecurrence()` (read-time normalizer; recurrence is stored as opaque `Json`).
- **`lib/reminders/recurrence.ts`** — `computeNextDueOn(rec, completedOn)` (rrule-backed) and `previewOccurrences()`.
- **`lib/reminders/describe.ts`** — `describeRecurrence(rec)` (the only human-readable renderer).
- **`components/reminders/RecurrencePicker.tsx`** — the only editor, embedded in `ReminderForm`.

The engine is **stateless**: it recomputes the next due date purely from a passed-in date. Callers:

| Caller | Arg passed as `completedOn` | Role |
|---|---|---|
| `lib/reminders/actions.ts` (`completeReminder`) | `new Date()` (now) | advance `ReminderTarget.nextDueOn` on completion |
| `lib/ai/suggest/reminders.ts` (`acceptProposedReminders`) | `new Date()` (today) | seed initial `nextDueOn` |
| `app/(app)/reminders/[id]/page.tsx` | `r.nextDueOn` | read-only preview (4 occurrences) |
| `lib/ical/assemble.ts` | `input.nextDueOn` | read-only ICS projection (11 occurrences) |

`ReminderTarget.nextDueOn` **drifts on completion**; `ReminderTarget` has no `createdAt` and there is **no immutable anchor date** in the schema. This matters for bi-weekly (see Anchoring).

## Decisions (from brainstorming)

- Multi-value support **everywhere it makes sense**: monthly days, nth-weekday combos, yearly month/day pairs.
- Bi-weekly via an **interval added to the `weekly` kind** (calendar-anchored), not by relying on the completion-anchored `interval` kind.
- Monthly day control: **number input + "Add" → removable chips**.
- nth-weekday control: **add-combo chips** (pick position + weekday → "First Monday"); supports mixed pairs.
- Yearly control: **collapsible calendar** (chips + "Add date" → Popover month-grid; click a day to add). Year ignored.
- Yearly day cap: **1–31, clamped at runtime** (Feb 31 → Feb 28/29).

## Schema changes (`lib/reminders/schema.ts`)

The discriminated union grows. `once` and `interval` are unchanged.

| kind | today | new |
|---|---|---|
| `weekly` | `weekdays: number[]` (≥1, unique, 0–6) | `weekdays` + `interval: number` (int, 1–52, default 1) + `anchor?: string` (ISO date, server-managed; present only when `interval>1`) |
| `monthly` | `dayOfMonth: number\|'last'` | `days: number[]` (each int 1–28, unique) + `last: boolean` (default false). Refine: `days.length >= 1 \|\| last === true`. |
| `monthlyWeekday` | `{week, weekday}` | `combos: {week: 1\|2\|3\|4\|-1, weekday: 0–6}[]` (≥1; unique `(week,weekday)` pairs) |
| `yearly` | `{month: 1–12, day: 1–28}` | `dates: {month: 1–12, day: 1–31}[]` (≥1; unique `(month,day)` pairs). Day **1–31**, clamped at runtime. |

`activeMonths` (seasonality) remains optional on `interval`/`weekly`/`monthly`/`monthlyWeekday`, and remains intentionally absent on `yearly`.

### Backward compatibility — no DB migration

Recurrence is stored as opaque `Json` and read through `parseRecurrence()`. Extend `parseRecurrence()` to normalize every legacy shape forward at read-time, then validate against the new schema:

- monthly `{dayOfMonth: n}` → `{days: [n], last: false}`; `{dayOfMonth: 'last'}` → `{days: [], last: true}`.
- monthlyWeekday `{week, weekday}` → `{combos: [{week, weekday}]}`.
- yearly `{month, day}` → `{dates: [{month, day}]}`.
- weekly without `interval` → `interval: 1`.
- (Existing legacy `interval {days: N}` → `{every: N, unit: 'day'}` mapping is retained.)

Existing rows keep working with zero data migration. The new `*-array` shapes are what the picker emits and what `parseRecurrence` produces; the singular legacy shapes are accepted on read only.

## Bi-weekly anchoring

"Every other Tuesday" is meaningful only against a fixed reference week, but the engine recomputes from a drifting `completedOn`, so `INTERVAL=2` alone is a no-op.

**Approach (chosen):** store an `anchor` ISO date inside the `weekly` recurrence JSON, set **server-side** to the seed `nextDueOn` whenever `interval > 1`. The engine runs `WEEKLY;INTERVAL=N;BYDAY=…` with `dtstart = anchor` and takes the first occurrence strictly after `completedOn`. Stable parity, no drift.

- `interval === 1` (the common case) needs no anchor and behaves exactly as today.
- `anchor` is set/refreshed in `actions.ts` and `ai/suggest/reminders.ts` at create/update whenever `weekly.interval > 1`.
- **Re-anchor policy:** re-anchor on **any** edit to a `weekly` recurrence while `interval > 1` (interval, weekdays, or seasonality), not only on interval change. This keeps the anchor's weekday consistent with the rule and avoids deciding stale-anchor behavior ad hoc. (rrule would still resolve a stale anchor via `BYDAY`, but re-anchoring is the defined behavior.)
- The anchor is shared across a reminder's multiple targets — acceptable and arguably desirable (shared parity).

**Rejected alternative:** a `ReminderTarget.anchorDate` column threaded through all four call sites — more correct per-target, but a migration + signature churn for an imperceptible benefit.

## Expansion engine (`lib/reminders/recurrence.ts`)

- **weekly:** `byweekday = weekdays.map(d => RRULE_WEEKDAY[d])`, `interval = rec.interval`. `dtstart = interval > 1 ? toUtcMidnight(anchor) : completedOn + 1 day`. Take first occurrence strictly after `completedOn` (`.after(completedOn, false)`). Seasonality via `bymonth` as today.
- **monthly:** `bymonthday = [...days, ...(last ? [-1] : [])]`. rrule handles the multi-day + last-day union directly. `firstAfter` as today.
- **monthlyWeekday:** `byweekday = combos.map(c => RRULE_WEEKDAY[c.weekday].nth(c.week))` (replaces the old `bysetpos`). `RRULE_WEEKDAY` entries are rrule `Weekday` instances and expose `.nth()`.
- **yearly:** computed **without rrule** — rrule's `bymonth × bymonthday` is a cross-product and cannot express `(month, day)` *pairs*. For each pair, construct the next occurrence after `completedOn` (this year or next), **clamping `day` to the target month's length** (reuse the clamping helper). Return the earliest across all pairs. `toUtcMidnight`. Because `previewOccurrences` feeds each result back as the next `completedOn`, a multi-date yearly recurrence must alternate correctly across the set (e.g. Jan 1 → Jul 1 → Jan 1 → …) — see Testing.
- `once` and `interval` paths unchanged (including the seasonality skip-loop and `SKIP_CAP`).

## Descriptions (`lib/reminders/describe.ts`)

- **weekly:** `interval === 1` → existing "Every Mon & Wed"; `interval === 2` with a single weekday → "Every other Tuesday"; otherwise "Every N weeks on Mon & Wed".
- **monthly:** "Monthly on the 1st & 15th"; append " + last day" when `last`; "Last day of the month" when `days` is empty and only `last` is set (handle the `days.length === 0 && last` path explicitly so the join emits no stray separator).
- **monthlyWeekday:** join combos — "First & Third Monday", "First Monday & Last Friday".
- **yearly:** join dates — "Jan 1 & Jul 1".
- Season suffix logic unchanged.

## Picker UI (`components/reminders/RecurrencePicker.tsx`)

- **Label-bug fix:** give every coded single `Select` an item→label mapping using Base UI's `items` / value-render, matching the working pattern in `ItemsFilterBar.tsx`. Applies to the yearly month select and the nth-weekday position/weekday selects.
- **weekly:** add an "every `[N]` weeks" number input (1–52) before the weekday toggle row.
- **monthly:** number input (1–28) + **Add** → removable day chips; keep the "Last day of month" switch.
- **monthlyWeekday:** position `Select` + weekday `Select` + **Add** → removable combo chips ("First Monday").
- **yearly:** collapsed to date chips + an **"Add date"** button; clicking opens a Base UI `Popover` containing a **hand-rolled month-grid calendar** (prev/next month navigation, click a day 1–31 to add; year ignored). No new dependency. Existing 1–28 yearly rows load into the new grid unchanged (1–28 ⊂ 1–31).
- The single-object `State` grows (`weeklyInterval`, `monthlyDays`, `monthlyLast`, `nthCombos`, `yearlyDates`, plus transient add-row inputs). The existing `update()` / `buildRecurrence()` merge pattern (which avoids the stale-setState / update-parent-during-render pitfall) is preserved.

## Server actions

`lib/reminders/actions.ts` (create/update paths) and `lib/ai/suggest/reminders.ts` inject/refresh the `weekly.anchor` from the computed/seed `nextDueOn` when `interval > 1`.

## Testing

- **`recurrence.test.ts`:** bi-weekly parity across successive completions; semi-monthly (days `[1,15]`); days + `last` union; multi nth-weekday ("first & third Monday"); mixed combos ("first Monday + last Friday"); yearly multi-date ordering + Feb clamp (Jan 31 vs Feb); **multi-date yearly preview alternation** via `previewOccurrences` (Jan 1 & Jul 1 → alternates, does not repeat).
- **schema / `parseRecurrence`:** legacy-shape normalization for monthly, monthlyWeekday, yearly, and weekly-without-interval; rejection of invalid arrays (empty, duplicate pairs).
- **`describe.test.ts`:** each new phrasing, including the only-`last` monthly path.

## Out of scope (YAGNI)

- No `ReminderTarget` migration / anchor column.
- No new calendar dependency (hand-rolled month grid in the existing Popover).
- **Monthly stays 1–28 + "last" (not 1–31).** rrule `bymonthday=31` *skips* months without a 31st rather than clamping, which would be inconsistent with the yearly clamp behavior and surprising; "last" already covers month-end. The monthly(1–28) vs yearly(1–31) asymmetry is intentional and confirmed.
