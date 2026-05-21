# Completion-aware ICS calendar feed

**Date:** 2026-05-21
**Status:** Approved (brainstorm) — pending implementation plan

## Problem

The ICS calendar feed (`app/api/calendar/[token]/route.ts` → `lib/ical/build.ts`) is
purely forward-looking. It emits one all-day event series per reminder starting at the
earliest target's `nextDueOn`, projecting ~12 future occurrences. It never shows
completion history, and it has a concrete bug: a completed one-shot reminder has its
`nextDueOn` advanced to the year-9999 sentinel (`computeNextDueOn` returns `FAR_FUTURE`
for `kind: 'once'`), so the feed emits a bogus all-day event dated `9999-12-31`.

We want the calendar to:

1. **Suppress the year-9999 sentinel event** for completed one-shots.
2. **Show completed occurrences** (all reminder kinds, including one-shots) as `✅`-prefixed
   events on the date they were completed.
3. **Make overdue legible**: a past, non-`✅` event is overdue. There is no dedicated
   overdue marker — plain title = not done, and the date relative to today distinguishes
   overdue (past) from upcoming (future).

## Background: data model

- `ReminderTarget.nextDueOn` is a required `DateTime`. Completing advances it
  (`lib/reminders/actions.ts:completeReminder`). For `once` reminders, completion sets it
  to `FAR_FUTURE` (`new Date('9999-12-31T00:00:00.000Z')`, module-private in
  `lib/reminders/recurrence.ts`). The reminder's `active` flag is **not** flipped on
  completion.
- `ReminderCompletion` records `completedOn` (the timestamp the user marked it done),
  `targetId`, and `reminderId`. **It does not record which scheduled occurrence the
  completion satisfied.** There is no `scheduledFor` column.
- Because completion advances `nextDueOn` forward from *now*, the system tracks at most
  **one** outstanding due slot per target at any time — it does not accumulate a backlog
  of missed scheduled dates.

These facts drive the design decisions below.

## Decisions

| Question | Decision | Rationale |
|---|---|---|
| Anchor date for a completed event | The **actual `completedOn` date** | Exact, already stored, no schedule reconstruction or completion-to-slot matching required. |
| History window | **All completions** (unbounded) | Fine for a single household. Documented extension point: add a `completedOn >= cutoff` filter in the route if it ever grows. |
| Multi-target reminders | **One merged series per reminder** (current UX) | Keeps the change minimal; completions across the reminder's targets are merged into one history stream. |
| One-shot vs recurring treatment | **Uniform** — all kinds get `✅` history; the only kind-aware bit is sentinel suppression | One-shots are the only kind that produces the sentinel, so suppressing the sentinel due event is the single special case. |
| Overdue marker | **None** — plain title = overdue when in the past | Explicit user intent. |
| Prefix glyph | `✅ ` (U+2705, "white heavy check mark") on completed events only | Renders as a green checkbox in calendar clients. |

## Behavior specification

For each reminder (one merged series), the feed emits:

| Event kind | Source | Title | Alarm |
|---|---|---|---|
| `completed` | one per `ReminderCompletion.completedOn` | `✅ <title>` | none |
| `due` | `nextDueOn`, **only if it is not the year-9999 sentinel** | `<title>` (plain) | lead-time alarm **only if the date is in the future** |
| `projected` | `previewOccurrences(recurrence, nextDueOn, 11)` (returns `[]` for `once`) | `<title>` (plain) | lead-time alarm |

Resulting cases:

- **Completed one-shot**: `nextDueOn` is the sentinel → no `due` event, no projections.
  Only `✅` events for its completion(s).
- **Active one-shot (never completed)**: one plain `due` event (overdue if past, upcoming
  if future). No projections.
- **Recurring**: `✅` event per completion + one plain `due` event (overdue or next
  upcoming) + 11 future projections.
- **No completions + future due**: identical output to today (backward compatible).

## Architecture (Approach B — split assembly from rendering)

### New: `lib/ical/assemble.ts`

A pure function that turns one reminder's state into a typed event list:

```ts
export type CalendarEventKind = 'completed' | 'due' | 'projected';

export type CalendarEvent = {
  uid: string;
  reminderId: string;                  // for the VEVENT url
  date: Date;                          // UTC midnight (all-day)
  title: string;                       // already prefixed with "✅ " when completed
  description: string;                 // reminder's description ?? '' — same for all kinds
  kind: CalendarEventKind;
  alarmSecondsBefore: number | null;   // null = emit no VALARM
};

export type AssembleInput = {
  id: string;
  title: string;
  description: string | null;
  recurrence: Recurrence;
  nextDueOn: Date;
  leadTimeDays: number;
  completions: Date[];                 // completedOn values, merged across targets
};

export function assembleReminderEvents(input: AssembleInput, now: Date): CalendarEvent[];
```

Rules implemented inside:

- Emit one `completed` event per `completions[i]`: `title = "✅ " + input.title`,
  `alarmSecondsBefore = null`, `uid = reminder-${id}-done-${isoDate(completedOn)}`.
- Emit the `due` event **unless** `nextDueOn` is the sentinel
  (`isSentinelDate(nextDueOn)`). `title = input.title`,
  `uid = reminder-${id}-${isoDate(nextDueOn)}`,
  `alarmSecondsBefore = nextDueOn >= now ? leadTimeDays * 86_400 : null`.
- Append projections from `previewOccurrences(recurrence, nextDueOn, 11)` (already `[]`
  for `once`): plain title, `uid = reminder-${id}-${isoDate(date)}`,
  `alarmSecondsBefore = leadTimeDays * 86_400` (projections are always future).
- All dates normalized to UTC midnight (matching the existing `build.ts` convention).

### Changed: `lib/ical/build.ts`

Becomes a dumb renderer. New signature accepts the assembled events:

```ts
export function buildIcal(events: CalendarEvent[], appUrl: string): string;
```

For each event: create an all-day VEVENT (`start = end = event.date`, `allDay: true`,
`summary = event.title`, `description`, `url = ${appUrl}/reminders/${reminderId}`), and
attach a `display` VALARM **only when `event.alarmSecondsBefore !== null`**.

`CalendarEvent` carries an explicit `reminderId: string` field for the URL. (Parsing it
back out of the uid would be fragile — the field is the decided approach, not an open
question.) All events for a reminder — `completed`, `due`, `projected` — carry the same
`description` (the reminder's `description ?? ''`).

### Changed: `lib/reminders/recurrence.ts`

Export the sentinel so `assemble.ts` recognizes a "done one-shot" without a magic literal:

```ts
export const FAR_FUTURE = new Date('9999-12-31T00:00:00.000Z');
export function isSentinelDate(d: Date): boolean; // d.getTime() === FAR_FUTURE.getTime()
```

### Changed: `app/api/calendar/[token]/route.ts`

- Extend the Prisma query to also fetch completions (merged across targets):
  ```ts
  completions: { select: { completedOn: true }, orderBy: { completedOn: 'asc' } }
  ```
  Keep the existing earliest-target `nextDueOn` selection and the
  `.filter(r => r.targets.length > 0)` guard.
- Map each reminder through `assembleReminderEvents(input, new Date())`, flat-map into a
  single `CalendarEvent[]`, and pass that to `buildIcal`.
- **Documented extension point**: to bound history later, add
  `where: { completedOn: { gte: cutoff } }` to the completions selection — no structural
  change required.

## UID strategy

Stable, namespaced UIDs prevent collisions between a `✅` event and a due event that fall
on the same UTC day:

- Completed: `reminder-${id}-done-${completedOnISODate}`
- Due: `reminder-${id}-${nextDueOnISODate}` (unchanged from today)
- Projected: `reminder-${id}-${dateISODate}` (unchanged from today)

## Edge cases

- **Sentinel one-shot** (`nextDueOn === FAR_FUTURE`): no due event, no projections; only
  `✅` events.
- **Active one-shot, never completed**: one plain due event.
- **Completion on the same UTC day as the due date**: distinct UID namespaces keep both.
- **No completions, future due**: byte-for-byte equivalent to current output (regression
  guard).
- **Timezone**: reuse the existing `Date.UTC(y, m, d)` all-day normalization in
  `build.ts`; `completedOn` is stored UTC. No new timezone logic is introduced.

## Testing

- **`lib/ical/assemble.test.ts`** (new, tagged `@critical`) — pure function against a
  fixed `now`:
  - completed one-shot suppresses the sentinel due event, keeps the `✅` event;
  - active one-shot emits exactly one plain due event, no projections;
  - recurring emits one `✅` per completion + one due + 11 projections;
  - past `nextDueOn` (overdue) emits a plain due event with `alarmSecondsBefore === null`;
  - `✅` events carry the prefix and never an alarm.
- **`lib/ical/build.test.ts`** (new/updated) — given a `CalendarEvent[]`, asserts VEVENT
  count, `SUMMARY` prefix, all-day formatting, and VALARM presence/absence per
  `alarmSecondsBefore`.
- **`tests/integration/ical-feed.test.ts`** (extend existing) — seed a reminder with
  completions; assert the feed body contains the `✅ ` summary line and does **not**
  contain a `9999`-dated event. Include a case where a completion's `completedOn` falls on
  the same UTC day as the reminder's `nextDueOn`, asserting both the `✅` event and the
  plain due event survive into the feed (distinct-UID collision guard, end-to-end).

## Files touched

| File | Change |
|---|---|
| `lib/ical/assemble.ts` | new — pure event assembler |
| `lib/ical/assemble.test.ts` | new — `@critical` unit tests |
| `lib/ical/build.ts` | simplify to a renderer over `CalendarEvent[]` |
| `lib/ical/build.test.ts` | new/updated renderer tests |
| `lib/reminders/recurrence.ts` | export `FAR_FUTURE` + `isSentinelDate` |
| `app/api/calendar/[token]/route.ts` | fetch completions, call `assembleReminderEvents` |
| `tests/integration/ical-feed.test.ts` | extend with completion + sentinel assertions |

## Out of scope / future

- Per-target series for multi-target reminders (chose merged single series).
- A bounded history window (chose all-history; documented where to add the filter).
- A dedicated overdue marker / distinct glyph (chose plain = overdue).
- Recording `scheduledFor` on `ReminderCompletion` to anchor `✅` events on scheduled
  (rather than actual-completed) dates.
