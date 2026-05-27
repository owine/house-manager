# Overdue Redefinition & Chore Auto-Complete — Design

**Status:** Draft
**Date:** 2026-05-27

Two behavioral tweaks to reminders/chores:

1. **Overdue** = `nextDueOn`'s calendar date is strictly **before** today in the house timezone. Due-today is **not** overdue.
2. **Chores** can opt into **auto-complete**: at the end of the due day (house tz), if not manually completed, the system completes the chore and rolls the recurrence forward.

## Motivation

- The current overdue logic is inconsistent across surfaces. `lib/digests/queries.ts` already does the right thing (calendar-day comparison in tz), but `components/reminders/ReminderStatusBadge.tsx` uses naive `floor((dueOn - now)/86_400_000)` math, and `lib/ical/assemble.ts` uses a UTC-midnight comparison. A chore due today flips to "Overdue" in the UI list the moment now passes midnight UTC of the due date, while the overdue digest correctly excludes it. Single semantics, single helper.
- Some chores are recurring habits where the user wants the system to maintain cadence even if they forget to tick a box — e.g. "swap HVAC filter" or "water plants" — without nagging notifications. Auto-complete satisfies that without changing the chore's underlying recurrence model.

---

## Tweak 1 — Overdue redefinition

### Rule

A reminder/chore target is **overdue** iff:
```
calendarDate(nextDueOn, houseTz) < calendarDate(now, houseTz)
```
…where `calendarDate(d, tz)` is the `{year, month, day}` tuple of `d` rendered in `tz`. Due-today, regardless of clock time, is **not** overdue.

### Schema

Add a house-wide timezone field:
```prisma
model HouseProfile {
  // ...existing fields
  timezone String @default("UTC")
}
```
HouseProfile is single-row; this is an additive non-destructive migration. The default `"UTC"` preserves current behavior for fresh installs.

> Note: per-user `NotificationPrefs.timezone` already exists and continues to drive digest delivery timing. The new `HouseProfile.timezone` is the single canonical clock for "what day is it" in the application — it does not replace per-user prefs.

### Helper

Add to `lib/time/tz.ts`:

```ts
/**
 * True iff `nextDueOn`'s calendar date in `tz` is strictly before `now`'s
 * calendar date in `tz`. Due-today (any wall-clock time) returns false.
 */
export function isOverdue(nextDueOn: Date, now: Date, tz: string): boolean;
```

Implementation compares `tzParts(...)` tuples (`{year, month, day}`) using the existing tz util — no millisecond math, no DAY_MS constant.

### Call site changes

| File | Current logic | Change |
|---|---|---|
| `components/reminders/ReminderStatusBadge.tsx:16` | `floor((dueOn - now)/DAY_MS) < 0` | Replace with `isOverdue(...)`. Component takes `tz` as a new prop (parent already has it via server context). |
| `lib/ical/assemble.ts:71` | `date.getTime() >= todayUtc.getTime() ? leadSeconds : null` | Switch overdue branch to `isOverdue(input.nextDueOn, now, tz)`; signature gains `tz` (callers thread it from `HouseProfile.timezone`). |
| `lib/digests/queries.ts` | Already correct, but rolls its own `startOfTodayInTz` | Refactor to use the shared `isOverdue` (or its building block) so all three sites share one implementation. |
| Dashboard / chores list / anywhere else rendering "Overdue" | grep audit during implementation | Same. |

### Tests

- `lib/time/tz.test.ts`: `isOverdue` cases — due today at 00:00 / 12:00 / 23:59, due yesterday, due tomorrow, DST spring-forward day, DST fall-back day, `tz="UTC"`, `tz="America/New_York"`.
- Update existing badge / iCal / digest tests to assert the new boundary semantics where they overlap.

---

## Tweak 2 — Chore auto-complete

### Schema

```prisma
model Reminder {
  // ...existing fields
  autoComplete Boolean @default(false)
}
```

App-layer constraint: `autoComplete = true` is only permitted when `kind = CHORE`. Enforced in the Zod schema for the chore form (matches existing pattern; ReminderKind constraints are app-layer, not DB CHECK).

### Sentinel system user

`ReminderCompletion.completedById` is a non-nullable FK. Seed a fixed-ID user row to attribute auto-completions:

```ts
// prisma/seed.ts (or a new dedicated seed)
await prisma.user.upsert({
  where: { id: 'system-auto-complete' },
  update: {},
  create: {
    id: 'system-auto-complete',
    email: 'system+auto-complete@house-manager.local',
    name: 'System (Auto-complete)',
  },
});
```

The email uses a non-routable local domain. The row never logs in (no Account, no Session). Adopting a sentinel user keeps the schema unchanged at every read site — cheaper than making `completedById` nullable across the codebase.

### Worker job

New job (or fold into `worker/jobs/reminders-tick.ts`, decided in the plan):

```
worker/jobs/chore-auto-complete-tick.ts
```

Tick logic, per run:

1. Read `HouseProfile.timezone` (single-row table, cache once per tick).
2. Query candidate targets:
   ```ts
   prisma.reminderTarget.findMany({
     where: {
       reminder: { kind: 'CHORE', autoComplete: true, active: true },
       // candidate = any target whose nextDueOn calendar day is < today (houseTz)
       nextDueOn: { lt: startOfTodayInTz(houseTz, now) },
     },
     include: { reminder: { select: { id: true, recurrence: true } } },
   });
   ```
3. For each candidate, inside one transaction:
   - Insert `ReminderCompletion` with `completedById = 'system-auto-complete'`, `completedOn = endOfDueDayUtc(target.nextDueOn, houseTz)`, `notes = "Auto-completed"`.
   - Update the target: `lastCompletedOn = completedOn`, `nextDueOn = computeNextDueOn(parseRecurrence(reminder.recurrence), completedOn)` — same advance helper as manual completion in `lib/reminders/actions.ts:392`.
   - **Skip** `autoCreateServiceRecord` side effects — auto-completes never create service records.
   - **Skip** notification side effects — no `NotificationLog`.
4. Enqueue search reindex for the reminder (parity with manual completion).

### Catch-up policy

If `autoComplete` is enabled on a chore that's already several cycles overdue, the worker advances **one cycle per tick**. Manual completion behaves the same way, so we reuse the proven path; the worker catches up over subsequent ticks naturally. No batched multi-cycle backfill.

### Idempotency

The advance updates `nextDueOn` to a future date inside the same transaction, so the same target cannot match the query a second time within the same tick. Job retries are safe because each tick re-queries from current DB state.

### UI

- **Chore form** (`components/chores/...` or whichever shares `ReminderForm.tsx` with kind=CHORE): add an "Auto-complete at end of due day" checkbox. Visible only when kind=CHORE. Defaults to unchecked.
- **Chore detail / history**: render a small "Auto" badge on completion rows where `completedById === 'system-auto-complete'`. Derive at render time — no schema change. If later we want to filter/style these more richly, an `isAuto`/`source` column is cheap to add, but YAGNI for v1.

---

## Files touched (rough inventory)

**Schema / data:**
- `prisma/schema.prisma` — `HouseProfile.timezone`, `Reminder.autoComplete`
- `prisma/migrations/<ts>_overdue_and_autocomplete/migration.sql` — additive
- `prisma/seed.ts` (or new file) — sentinel user upsert

**Library:**
- `lib/time/tz.ts` — `isOverdue` helper
- `lib/time/tz.test.ts` — unit tests
- `lib/digests/queries.ts` — refactor to shared helper
- `lib/reminders/schema.ts` — `autoComplete` field + cross-field rule (kind=CHORE if true)
- `lib/house-profile/queries.ts` / `schema.ts` — timezone read/write

**Workers:**
- `worker/jobs/chore-auto-complete-tick.ts` (new) or extension to `reminders-tick.ts`
- `worker/index.ts` — register the new job's schedule

**UI:**
- `components/reminders/ReminderStatusBadge.tsx` — use `isOverdue`, accept `tz` prop
- `components/reminders/ReminderForm.tsx` — `autoComplete` checkbox (kind=CHORE only)
- Chore history rendering — "Auto" badge on system-attributed completions

**iCal:**
- `lib/ical/assemble.ts` — switch to `isOverdue`, thread `tz` through callers

**Tests:**
- `lib/time/tz.test.ts` — new
- `tests/integration/chore-auto-complete.test.ts` — new (happy path, idempotency, catch-up, autoCreateServiceRecord-skip, notification-skip)
- Update badge / iCal / digest tests for new boundary

---

## Open questions / resolved

| Q | Decision |
|---|---|
| Auto-complete writes a completion record? | **Yes**, system-attributed via sentinel user. |
| End-of-day in whose tz? | **HouseProfile.timezone** (new field). |
| Auto-complete on REMINDER kind? | **No, CHORE only** (app-layer rule). |
| Create ServiceRecord on auto-complete? | **No**, even when `autoCreateServiceRecord = true`. |
| Overdue fix scope? | **Centralize** in `lib/time/tz.ts`, all call sites use the shared helper. |
| Sentinel user vs nullable FK? | **Sentinel user** (`id: 'system-auto-complete'`). |
| Multi-cycle catch-up? | **One cycle per tick**; worker catches up over subsequent ticks. |

---

## Out of scope

- Per-user timezone influence on overdue (digests already handle delivery timing per-user; overdue is a global property).
- An `isAuto`/`source` column on `ReminderCompletion` (deferred until we have a UI/reporting need beyond the derived "Auto" badge).
- Backfilling auto-complete for existing chores at migration time — opt-in only, new field defaults to `false`.
- Changing notification behavior. Auto-completed chores still don't notify (chores don't notify by default), and we don't introduce a new "auto-completed" notification kind.
