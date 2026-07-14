# CalendarDate vs Instant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the **thirteen** live bugs caused by confusing calendar dates with instants, then make the confusion *unrepresentable* — first in the database, then in the type system.

**Architecture:** The app stores two semantically different things in one type. `nextDueOn`, `endsOn`, `startsOn`, `performedOn`, `purchaseDate`, `installDate` are **calendar dates** — a day, encoded as UTC midnight by convention. `now`, `completedOn`, `receivedAt`, `occurredAt` are **instants**. Both are `Date`, so TypeScript cannot tell them apart and every call site is a coin flip. We fix the bugs with the existing `lib/time/tz.ts` helpers (PR 2, PR 3), then migrate the columns to real Postgres `date` so a time component becomes **structurally impossible** (PR 4), then brand the TypeScript type so misuse becomes a **compile error** (PR 5).

**Tech Stack:** TypeScript 6, Prisma 7.8 (result extensions), Postgres 18, Vitest, Testcontainers, Next 15 RSC.

---

## The One Rule

Everything here follows from a single asymmetry. Get this wrong and you reintroduce the bugs.

| Value | What it is | Correct handling |
|---|---|---|
| `now`, `completedOn`, `receivedAt`, `occurredAt` | an **instant** | Interpret it **through the house tz** to find out what day it is: `startOfDayUtc(now, tz)` |
| `nextDueOn`, `endsOn`, `startsOn`, `performedOn`, `purchaseDate`, `installDate` | a **calendar date** | It is *already* a day. Read it in **UTC**. **Never** run it through a tz. |

The house tz answers **"what day is it now"**. It must never reinterpret a value that is already a day.

Both directions are live bugs:
- **Date → tz** (`tzParts(nextDueOn, tz)`): `2026-07-15T00:00:00Z` read in Chicago is "Jul 14". Every due date slides back a day. → C3.
- **Instant → UTC day** (`formatCalendarDate(completedOn)`): 8 PM Chicago is already tomorrow in UTC. Every evening event renders a day late. → C10, C11, C12.

**House timezone is `America/Chicago` (UTC−5 CDT / UTC−6 CST).** The recurring phrase "the 7 PM boundary" below is the moment UTC rolls to the next day — 7 PM local in summer, 6 PM in winter.

---

## Background

Seven prior fixes, all this same root cause: #151, #194, #205/#206, #225, #226, #255. Each patched one call site. **#267** (2026-07-14) fixed the test time bombs in `lib/digests/queries.test.ts` that were blocking Renovate's lockfile PRs. This plan covers the rest.

**Prod data audit (2026-07-14, read-only against `piwine`):**

| Column | Rows | Non-midnight | Verdict |
|---|---:|---:|---|
| `service_records.performedOn` | 24 | **2** | C5 — live writer |
| `reminder_targets.nextDueOn` | 19 | **2** | legacy, created 2026-05-05, **before** `toUtcMidnight` landed in #154 (2026-05-20). Writer already fixed. |
| `warranties.endsOn` | 4 | 0 | clean |
| `items.purchaseDate` | 31 | 0 | clean |
| `incoming_emails.aiExtractedPerformedOn` | 24 | 0 | clean |

**Critical:** C6/C13 (the drift bugs) corrupt the *day* while leaving the value perfectly UTC-midnight, because `computeNextDueOn` truncates at the end (`lib/reminders/recurrence.ts:177`). **Drift damage is invisible in the data and cannot be backfilled** — only fixed forward.

---

## The bug list

| # | Where | Symptom |
|---|---|---|
| C1 | `lib/digests/queries.ts:60` | anything due **today** falls between the overdue and weekly windows → appears in **neither** digest |
| C2 | `lib/digests/queries.ts:12` | `daysOverdue` reports "0d overdue" in positive-offset zones |
| C3 | `components/reminders/ReminderStatusBadge.tsx:36` | every due badge off by one day; "Due today" never shows on the right day |
| C4 | `components/warranties/WarrantyStatusBadge.tsx:4` | "Expired" from 7 PM the evening **before** the end date, and all through the final covered day |
| C5 | `lib/reminders/actions.ts:450`, `lib/incoming-email/actions.ts:253` | `performedOn` written as an instant → evening completions filed under tomorrow, and **excluded from /service date filters** |
| C6 | `lib/reminders/actions.ts:418`, `lib/ai/suggest/reminders.ts:174` | `computeNextDueOn` seeded with an instant → +1 day when completed after 7 PM |
| C7 | `app/(app)/reminders/calendar/page.tsx:52` | "today" ring jumps to tomorrow at 7 PM; today greys out as past |
| C8 | `lib/ical/assemble.ts:53` | auto-completed chores' ✅ lands a day late in the subscribed calendar |
| C9 | `worker/jobs/reminders-tick.ts:75` | lead window opens early → 0-lead reminder emails at 7 PM the night before |
| **C13** | **`worker/jobs/chore-auto-complete-tick.ts:41-43`** | **a weekly auto-completing chore becomes an 8-day chore — and the drift COMPOUNDS every cycle. Verified: Mon → Tue → Wed → Thu → Fri → Sat → Sun in six cycles. Worst bug in the list.** |
| C10 | `components/reminders/CompletionRow.tsx:21` | `formatCalendarDate(completedOn)` — completions render a day late; **systematically** for auto-completed chores |
| C11 | `app/(app)/dashboard/InboxPreviewCard.tsx:44` | `formatCalendarDate(receivedAt)` — evening emails show tomorrow's date |
| C12 | `app/(app)/dashboard/RecentActivityList.tsx:13` | `formatCalendarDate(occurredAt)` — same class, lower impact |
| L1 | `lib/dashboard/queries.ts:236` | local-ctor `startOfYear`; breaks the moment `TZ` is set on the container |
| L2 | `lib/reminders/actions.ts:208,252,307` | `utcMidnight(new Date())` seeds the **UTC** day, not the house day |

---

## PR 2 — Read-side bugs

Branch: `fix/calendar-date-read-side`

### Task 1: C1/C2 — the digest gap and the day count

`getWeeklyForUser` filters `{ gte: now, lte: now + 7d }` — UTC-midnight dates against a raw **instant**. The digest fires at `weeklySummaryHour` house-local, which in Chicago is always *after* today's UTC midnight, so `nextDueOn = today@00:00Z` fails `gte: now` and is dropped. Since `getOverdueForUser` correctly excludes due-today, **a reminder due today is reported in neither digest.** It also ignores its own `_timezone` param.

`daysBetween(now, nextDueOn)` divides instant-minus-date by 86400000 → truncates wrong when the house offset exceeds the digest hour.

**Files:** Modify `lib/digests/queries.ts:12-14,51-67`. Test `lib/digests/queries.test.ts` (uses `TZ`/`NOW`/`cal` from #267).

- [ ] **Step 1: Write the failing tests** — due-today appears in the weekly digest and in neither-is-a-bug; the window spans the intended number of days; `daysOverdue` is 1 for a Tokyo digest firing at 23:00Z the previous day.

⚠️ **Decide the window width explicitly.** `{ gte: start, lte: start + 7d }` with both operands at UTC midnight includes day 0 **and** day 7 — **eight** calendar days, and consecutive digests then double-report the boundary day. Use `lt: start + 7d` for a true 7-day window. State the choice in the test name.

- [ ] **Step 2: Run, verify fail.** `pnpm exec vitest run lib/digests/queries.test.ts`
- [ ] **Step 3: Implement.**

```ts
async function findAndProject(userId, where, sort, now: Date, timezone: string) {
  // ... query unchanged ...
  // Anchor the day count to the start of the house day: both operands are then
  // UTC-midnight, so the division is exact (epoch math -- no DST hazard).
  const today = startOfDayUtc(now, timezone);
  return targets.map((t) => ({
    /* ... */ daysOverdue: Math.max(0, daysBetween(today, t.nextDueOn)),
  }));
}

export async function getWeeklyForUser(userId, timezone, now = new Date()) {
  // From the start of the house day, not the firing instant -- otherwise
  // anything due today is already "past" and is silently dropped.
  const start = startOfDayUtc(now, timezone);
  const end = new Date(start.getTime() + 7 * 86_400_000);
  return findAndProject(userId, { gte: start, lt: end }, 'asc', now, timezone);
}
```
Rename `_timezone` → `timezone`.

- [ ] **Step 4:** `pnpm exec vitest run lib/digests/queries.test.ts tests/integration/digest-tick.test.ts`
- [ ] **Step 5:** Commit.

### Task 2: C3 — every reminder badge is off by one day

`ReminderStatusBadge.tsx:36` runs the **calendar date** through the tz. Verified at 11:00 Chicago on an ordinary Tuesday: due *tomorrow* → "Due today"; due *today* → "Due soon"; every countdown one short.

- [ ] **Step 1:** Failing test — `tz='America/Chicago'`, `now=2026-07-14T16:00:00Z`, assert `cal(7,14)`→"Due today", `cal(7,15)`→"Due soon", `cal(7,20)`→"In 6d". Plus an evening-boundary case: at `2026-07-15T01:00:00Z` (20:00 CDT, still Jul 14 in Chicago) `cal(7,14)` must still read "Due today".
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Delete the local `calendarDaysBetween` and the `tzParts` import. The tz belongs on `now`, never on `nextDueOn`:

```ts
import { isOverdue, startOfDayUtc } from '@/lib/time/tz';
// nextDueOn is already a calendar date. Only `now` -- an instant -- needs the
// house tz, to work out which day "today" is. Never the other way round.
const days = Math.round((nextDueOn.getTime() - startOfDayUtc(now, tz).getTime()) / 86_400_000);
```
- [ ] **Step 4:** Run tests. **Step 5:** Commit.

### Task 3: C4 — warranties expire the evening before

`WarrantyStatusBadge.tsx:4` — `endsOn.getTime() - Date.now()` goes negative at UTC midnight = **7 PM Chicago the day before**. Takes **no tz** and reads the ambient clock.

**Files — this is a 3-file thread, not 2:**
- `components/warranties/WarrantyStatusBadge.tsx` — add `tz` + `now` props
- `app/(app)/warranties/[id]/page.tsx:39` — a server page; `await getHouseTimezone()` ✓
- `components/warranties/WarrantyTable.tsx:75` — **a component; it cannot await.** Thread `tz` as a prop from `app/(app)/items/[id]/tabs/WarrantiesTab.tsx:28`, which takes it from `app/(app)/items/[id]/page.tsx`. Copy the precedent in `components/reminders/ReminderTable.tsx:52`, which already receives `tz` as a prop.

⚠️ **No page in `app/` calls `getHouseTimezone()` today** — its only callers are `worker/jobs/notify.ts:48` and `digest-tick.ts:75`. You are adding the first.

- [ ] **Step 1:** Failing test — warranty ending Jul 14: at `2026-07-15T01:00:00Z` (20:00 CDT Jul 14, the **last covered day**) it must NOT read "Expired". At `2026-07-15T16:00:00Z` (Jul 15) it must.
- [ ] **Step 2:** Run, verify fail. **Step 3:** Implement with `isOverdue(endsOn, now, tz)` (the end date is inclusive). **Step 4:** Run + `pnpm typecheck`. **Step 5:** Commit.

### Task 4: C7 — calendar "today" ring jumps at 7 PM

`app/(app)/reminders/calendar/page.tsx:52-53` uses **UTC**-today. `MonthGrid` is correct; only its input is wrong. `parseMonth` (line 20) also calls `new Date()` internally and rolls the default month over on the evening of the last day of a month — **it must take the anchor as a parameter.**

- [ ] `const todayIso = startOfDayUtc(new Date(), await getHouseTimezone()).toISOString().slice(0,10)`, and pass the same anchor into `parseMonth`. Test, commit.

### Task 5: C9 — reminder emails arrive the night before

`worker/jobs/reminders-tick.ts:75-76` compares a UTC-midnight date to an instant → the lead window opens `offset` hours early. With `leadTimeDays: 0` the email fires at **7 PM the previous evening**.

⚠️ **`handleRemindersTick(deps)` takes no `now`** (`worker/jobs/reminders-tick.ts:6,14`) — it calls `new Date()` internally, so the test below is impossible until you add `now: Date = new Date()` as a parameter and update the two callers in `worker/index.ts:53,75`. The pattern already exists in `handleChoreAutoCompleteTick(now = new Date())`.

⚠️ **Line 31 is the same bug and must change too.** The pre-filter `nextDueOn: { lte: new Date(now.getTime() + maxLead * DAY_MS) }` becomes *narrower* than the fixed gate in a positive-offset zone (`today > now`), silently dropping reminders the gate would admit. Change to `lte: new Date(today.getTime() + maxLead * DAY_MS)`.

- [ ] **Step 1:** Failing test — seed a `HouseProfile` with `America/Chicago` (existing tests rely on the `'UTC'` default, which is exactly why this never surfaced). Reminder due Jul 15, `leadTimeDays: 0`: must NOT notify at `2026-07-15T01:00:00Z`, MUST at `2026-07-15T13:00:00Z`.
- [ ] **Step 2:** Run, verify fail. **Step 3:** Implement — compare house-day to house-day:

```ts
const tz = await getHouseTimezone();
const today = startOfDayUtc(now, tz);
const notifyOn = new Date(r.nextDueOn.getTime() - r.leadTimeDays * DAY_MS);
if (notifyOn.getTime() > today.getTime()) continue;
```
- [ ] **Step 4:** Run. **Step 5:** Commit.

### Task 6: C10/C11/C12 — instants rendered as UTC calendar days

The mirror image of C3, and the audit's blind spot. `formatCalendarDate` renders in `timeZone: 'UTC'` (`lib/format/date.ts:25`), so handing it an **instant** shows the UTC day — which after 7 PM Chicago is tomorrow.

- [ ] `components/reminders/CompletionRow.tsx:21` — `formatCalendarDate(completedOn)`. Evening completions render a day late, and for **auto-completed chores** (`completedOn = 05:00Z the next day`) it is a day late *every single time*. Same underlying data as C8; fix both or the `.ics` and the UI will disagree.
- [ ] `app/(app)/dashboard/InboxPreviewCard.tsx:44` — `formatCalendarDate(receivedAt)`.
- [ ] `app/(app)/dashboard/RecentActivityList.tsx:13` — `formatCalendarDate(occurredAt)`.

Fix: these are instants, so render the **house day**: `formatCalendarDate(startOfDayUtc(instant, tz))`, threading `tz` in. Test each, commit.

### Task 7: L1 — dashboard "service this year"

`lib/dashboard/queries.ts:236` — `new Date(new Date().getFullYear(), 0, 1)` uses the **local** ctor + **local** getter. Correct today only because the containers happen to run UTC. `quickStats()` takes no params and does not import `getHouseTimezone` — **you must thread a tz in.**

- [ ] Test `quickStats()` with a Jan-1 service record. Implement `new Date(Date.UTC(tzParts(new Date(), tz).year, 0, 1))`. Commit.

### Task 8: Pin `TZ` in CI

⚠️ **Do not oversell this.** `process.env.TZ` only affects the *local* `Date` ctor and un-zoned locale formatting. Every bug C1–C13 is about the **house** tz, passed explicitly to `Intl`, and is **unaffected** by the runner's TZ. Verified: `TZ=America/Chicago pnpm test:unit` → 852 tests, **all pass**, before any fix. The pin catches only the local-ctor class (L1). Keep it as hygiene; do not claim it guards the class.

- [ ] Add `TZ: America/Chicago` to the workflow-level `env:` in `.github/workflows/ci.yml`. Run the full suite under it locally first. Commit.

### Task 9: Remaining test time bombs

- [ ] `tests/integration/notify-job.test.ts:~176` — `quietStart: '00:00', quietEnd: '23:59'` intends "all day", but `isInQuietWindow` (`lib/notifications/quiet-hours.ts:25`) evaluates the non-crossing branch as `minutesNow >= 0 && minutesNow < 1439` — **exclusive** of 23:59. Fails during the 23:59 UTC minute. Use `quietEnd: '00:00'` (overnight branch, always true) or inject `now`.
- [ ] `tests/integration/digest-tick.test.ts:45,133` — `beforeEach` captures `new Date().getUTCHours()` but the handler re-reads the clock; an hour rollover between setup and act flips every test. Inject `now`.
- [ ] `tests/integration/digest-tick.test.ts:63` — same `Date.now() - 24h` wall-clock seed as the #267 bomb. Benign *only* because the file seeds no `HouseProfile` (tz defaults to `'UTC'`). Task 5 seeds a Chicago tz in a sibling file — arm this before someone does it here. Seed UTC-midnight dates.
- [ ] Commit. **Open PR 2.**

---

## PR 3 — Write-side bugs

Branch: `fix/calendar-date-write-side`

### Task 10: C13 — the compounding chore drift ⚠️ HIGHEST IMPACT

`worker/jobs/chore-auto-complete-tick.ts:41-43`:
```ts
const completedOn = endOfCalendarDayInTz(t.nextDueOn, tz);   // INSTANT: 05:00Z the NEXT day
const nextDueOn = computeNextDueOn(recurrence, completedOn); // seeded with an instant
```
`addInterval` adds `every * DAY_MS` **before** `toUtcMidnight`, so the extra 5 hours push it over the day boundary. Unlike C6, this **compounds**, because the next cycle re-seeds from the already-shifted `nextDueOn`. Verified for a 7-day chore first due Mon Jul 13:

```
cycle 1 -> Tue Jul 21 (+8d)   cycle 4 -> Fri Aug 14 (+8d)
cycle 2 -> Wed Jul 29 (+8d)   cycle 5 -> Sat Aug 22 (+8d)
cycle 3 -> Thu Aug 6  (+8d)   cycle 6 -> Sun Aug 30 (+8d)
```
A "weekly" chore is an 8-day chore, forever, walking through the week.

- [ ] **Step 1:** Failing test — a 7-day auto-complete chore must advance exactly +7d, and must still be +7d after six cycles.
- [ ] **Step 2:** Run, verify fail (+8d).
- [ ] **Step 3:** Seed from the calendar date, not the instant. `t.nextDueOn` **is** the calendar day the chore was due, so use it directly:

```ts
const nextDueOn = computeNextDueOn(recurrence, t.nextDueOn);
```
(Keep `completedOn` as the instant — it is genuinely one, and it is what the completion record wants.)
- [ ] **Step 4:** Run. **Step 5:** Commit.

### Task 11: C6 — interval reminders land a day late

`lib/reminders/actions.ts:418` and `lib/ai/suggest/reminders.ts:174` seed `computeNextDueOn` with a raw instant. A completion at 8 PM Chicago anchors to **tomorrow**.

⚠️ Correction to an earlier draft: this does **not** compound here — each cycle seeds from the completion instant, not the stored `nextDueOn`, so it's independently +1 day. (The compounding case is C13.)

- [ ] Test-first, then `computeNextDueOn(recurrence, startOfDayUtc(now, tz))` at both sites.

### Task 12: C5 — `performedOn` written as an instant

`lib/reminders/actions.ts:450` (`performedOn: now`) and `lib/incoming-email/actions.ts:253` (`?? email.receivedAt`). Everywhere else `performedOn` is a calendar date. Consequence beyond display: `lib/service-records/queries.ts:21` filters `performedOn: { lte: toDate }` where `toDate` is UTC midnight — **a service record auto-created by completing a reminder is silently missing from a /service date filter that should include it.**

- [ ] Test-first, then `performedOn: startOfDayUtc(now, tz)` in both. Keep `completedOn`/`lastCompletedOn` as instants.

### Task 13: C8 — ✅ events on the wrong day in the .ics feed

`lib/ical/assemble.ts:53` — `utcMidnight(completedOn)` on an **instant**. Systematic for auto-completed chores (`completedOn = 05:00Z next day` → bucketed on the following day).

- [ ] Test-first, then `startOfDayUtc(completedOn, tz)` (`tz` is already a param of `assembleReminderEvents`). Must agree with Task 6's `CompletionRow` fix.

### Task 14: L2 — `utcMidnight(new Date())` seeds the UTC day

- [ ] `lib/reminders/actions.ts:208,252,307` → `startOfDayUtc(new Date(), tz)`. A reminder created at 8 PM Chicago is currently seeded due *tomorrow*.

**Open PR 3.**

---

## PR 4 — Make it unrepresentable in the database

Branch: `refactor/calendar-date-columns`

`ItemVendor.contractEndsOn` and `SystemVendor.contractEndsOn` are already `DateTime? @db.Date` — **the schema already contains the fix.** A `date` column cannot hold a time component, so the entire bug class becomes structurally impossible for these columns, and a bad write fails at the constraint instead of silently storing 8 PM. This is a stronger guarantee than any TypeScript brand, and it removes the need for a Prisma write-guard extension entirely.

### Task 15: Migrate the calendar-date columns to `@db.Date`

Columns (all currently `TIMESTAMP(3)`):
`ReminderTarget.nextDueOn`, `Warranty.endsOn`, `Warranty.startsOn`, `ServiceRecord.performedOn`, `Item.purchaseDate`, `System.installDate`, `Checklist.nextDueOn`

- [ ] **Step 1: Back up prod first.** See `docs/backups.md`. Non-negotiable — this is a destructive type change.
- [ ] **Step 2: Write the `USING` clause carefully.** ⚠️ **A naive cast corrupts good data.**

These columns are `timestamp` **without** time zone. A plain `("performedOn" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago')::date` applied to *every* row would drag the 22 already-correct UTC-midnight rows **back one day** (`2026-07-15 00:00` → Chicago `2026-07-14 19:00` → `Jul 14`). The conversion must be conditional on the row actually being dirty:

```sql
ALTER TABLE service_records
  ALTER COLUMN "performedOn" TYPE date
  USING (
    CASE
      -- Already a clean calendar date (written by the form via parseDateInput):
      -- take the day as-is.
      WHEN "performedOn" = date_trunc('day', "performedOn")
        THEN "performedOn"::date
      -- Written as an instant (C5). Label it as the UTC instant it actually is,
      -- render it as Chicago wall-clock, and take THAT day.
      ELSE (("performedOn" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Chicago')::date
    END
  );
```

⚠️ The `AT TIME ZONE 'UTC'` first is essential. Without it, Postgres *interprets* the naive timestamp as Chicago wall-clock and runs the conversion backwards; the result also depends on the session `TimeZone` GUC, so the migration would produce different data depending on who ran it. Verified on postgres:18.

The other columns are all clean (0 non-midnight rows), so a plain `USING "col"::date` is sufficient — but **re-run the detection query immediately before migrating**, not from this document:

```sql
SELECT count(*) FILTER (WHERE c <> date_trunc('day', c)) FROM ...
```

- [ ] **Step 3:** Update `prisma/schema.prisma` — add `@db.Date` to each column. Generate the migration, then **hand-edit it** to insert the `USING` clauses (Prisma will emit a plain cast). Per `feedback_prisma_migration_drift`, eyeball the generated SQL for dropped pgvector indexes / CHECK constraints.
- [ ] **Step 4: Verify Prisma's round-trip.** Confirm `@db.Date` reads back as a `Date` at **UTC midnight** and that writing a `Date` with a time component now **fails** rather than truncating silently. Write an integration test asserting exactly this — it is the whole point of the PR.
- [ ] **Step 5:** Run the full suite. `pnpm exec vitest run` + `pnpm test:integration`.
- [ ] **Step 6:** Deploy carefully — this is a type change on a live table. Back up, migrate, verify, keep the rollback (volume rename, per `project_pg18_upgrade_status`) to hand.

**Open PR 4.**

---

## PR 5 — Make it a compile error

Branch: `refactor/calendar-date-brand`

The DB now guarantees midnight. The brand stops the *other* half: running a calendar date through a timezone, and passing an instant where a day is meant.

### Task 16: The brand and its guards

**Files:** `lib/time/tz.ts`

- [ ] Add the type and the only sanctioned constructors:

```ts
declare const CalendarDateBrand: unique symbol;

/**
 * A date-only value: a *day*. Backed by a Postgres `date` column, so it always
 * arrives at UTC midnight. NOT an instant.
 *
 * The distinction is the most bug-prone thing in this codebase -- 13 bugs and
 * counting. See docs/superpowers/plans/2026-07-14-calendar-date-vs-instant.md.
 * The brand is erased at build time; it exists purely so the compiler can stop
 * you running a day through a timezone, or passing an instant where a day goes.
 */
export type CalendarDate = Date & { readonly [CalendarDateBrand]: true };

export function calendarDate(year: number, month: number, day: number): CalendarDate {
  return new Date(Date.UTC(year, month - 1, day)) as CalendarDate;
}

export function asCalendarDate(d: Date): CalendarDate {
  assertCalendarDate(d, 'asCalendarDate'); // NOTE: takes TWO required params
  return d as CalendarDate;
}
```

- [ ] **⚠️ The `never`-overload guard DOES NOT WORK. Do not use it.** An earlier draft proposed:

```ts
export function tzParts(d: CalendarDate, tz: string): never;   // ← USELESS
export function tzParts(instant: Date, tz: string): TzParts;
```
Overload resolution picks the first signature and returns `never` — but **`never` is assignable to everything**, so the call site compiles clean. Verified against the repo's TypeScript under `--strict`: the exact C3 bug shape produces **zero errors**. It looks like a guard and is not one.

**Use this instead** — verified to error on a `CalendarDate` while still accepting a plain `Date`:

```ts
export function tzParts(
  instant: Date & { readonly [CalendarDateBrand]?: never },
  timeZone: string,
): TzParts
// tzParts(nextDueOn, tz) -> TS2345: 'CalendarDate' is not assignable to
//                           'Date & { [CalendarDateBrand]?: undefined }'   <- the C3 bug
// tzParts(now, tz)       -> ok
```

- [ ] **⚠️ `utcMidnight(d: Date): Date` is a hole through the ratchet.** It is *precisely* the forbidden "read an instant in UTC to get a day" operation. If you type it `-> CalendarDate` it becomes a compiler-blessed laundromat for converting any instant into a `CalendarDate`. Give it the same `{ [CalendarDateBrand]?: never }` param guard, or make it private to `tz.ts` and replace its three call sites (`actions.ts:208,252,307`, already fixed in Task 14) with `startOfDayUtc`.

- [ ] Tighten the rest:
  - `startOfDayUtc(instant: Date, tz: string): CalendarDate`
  - `isOverdue(nextDueOn: CalendarDate, now: Date, tz: string): boolean`
  - `formatCalendarDate(d: CalendarDate | null | undefined, month?)` — **keep the nullable union**, or ~10 callers break (`OverviewTab.tsx:69`, `ItemCardGrid.tsx:36`, `ItemMetaCard.tsx:34`, `systems/page.tsx:93`, `SystemHeader.tsx:57`, `VendorLinkChips.tsx:78`). Drop `string` — nothing passes one. **This signature alone catches C10/C11/C12 at compile time.**
  - `computeNextDueOn(rec: Recurrence, completedOn: CalendarDate): CalendarDate` — makes C6 and C13 unstateable.
  - `previewOccurrences(rec, startAfter: CalendarDate, count)` (`recurrence.ts:181`) — loops `cursor = computeNextDueOn(rec, cursor)`, so it must be branded too. Callers: `app/(app)/reminders/[id]/page.tsx:36`, `lib/ical/assemble.ts:80`.

### Task 17: Brand at the Prisma boundary

**Verified against the real generated client:** a Prisma `result` extension **does** change the field's TypeScript type, **does** propagate through nested `include`, and a `select` that omits the field correctly drops it. This gives one chokepoint instead of a cast at ~30 read sites.

- [ ] Add to `lib/db.ts`:

```ts
return new PrismaClient({ adapter, log: ['warn', 'error'] }).$extends({
  // These are `date` columns -- calendar dates, not instants. Brand them once,
  // here, so the type flows out of the DB instead of being re-asserted at every
  // read site.
  result: {
    reminderTarget: {
      nextDueOn: { needs: { nextDueOn: true }, compute: ({ nextDueOn }) => asCalendarDate(nextDueOn) },
    },
    warranty: { /* endsOn, startsOn */ },
    serviceRecord: { /* performedOn */ },
    item: { /* purchaseDate (nullable!) */ },
    system: { /* installDate */ },
  },
});
```

- [ ] **⚠️ `globalForPrisma` is typed `PrismaClient`.** The extended client is a *different* type — use `ReturnType<typeof createPrismaClient>` or the brand is silently erased.
- [ ] **⚠️ `tests/integration/helpers.ts:23` constructs its own `new PrismaClient({ adapter })`** and types `IntegrationContext.prisma` as `PrismaClient` (line 9). Both must use the extended client or every integration test sees unbranded dates.
- [ ] **`assertCalendarDate` short-circuits on `NODE_ENV === 'production'`** (`lib/time/tz.ts:82`). So in prod it never throws (silently branding anything); in **dev and integration tests** it throws — and inside a `result.compute`, one dirty row poisons an entire `findMany`. PR 4's `date` columns make this moot, which is why PR 4 comes first.

### Task 18: Work the compiler's list

- [ ] `pnpm typecheck`. Every error is either (a) a site PR 2/PR 3 already fixed that just needs its type updated, or (b) **a bug the audit missed** — treat each as a finding, not a nuisance.
- [ ] **`as CalendarDate` and `@ts-expect-error` are forbidden here.** If you need one, the model is wrong.
- [ ] `pnpm exec knip` — the extension may orphan helpers (e.g. the deleted `calendarDaysBetween`).
- [ ] Put the One Rule table in `lib/time/tz.ts`'s module docblock, so the next person meets the rule before they meet the bug.

**Open PR 5.**

---

## Definition of done

- [ ] All 13 bugs + L1/L2 fixed, each with a regression test that fails without the fix.
- [ ] A weekly auto-completing chore advances **exactly 7 days**, six cycles running (C13).
- [ ] Calendar-date columns are Postgres `date`; a write with a time component **fails**.
- [ ] `tzParts(nextDueOn, tz)` and `formatCalendarDate(completedOn)` are **compile errors** — verified by actually trying them, not by assuming.
- [ ] Verified against the real app, not just tests (`/verify`): at 8 PM Chicago, a reminder due today badges "Due today"; a warranty ending today does not read "Expired"; a completion made now renders with today's date.
