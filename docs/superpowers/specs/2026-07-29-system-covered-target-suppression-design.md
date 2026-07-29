# Suppress system-covered item targets

**Date:** 2026-07-29
**Status:** Approved, ready for planning

## Problem

The "HVAC Filters" reminder notification email lists six lines:

```
• Downstairs Furnace   — due August 1, 2026
• Downstairs HVAC      — due August 1, 2026
• Downstairs Heat Pump — due August 1, 2026
• Upstairs HVAC        — due August 1, 2026
• Upstairs Furnace     — due August 1, 2026
• Upstairs Heat Pump   — due August 1, 2026
```

Four of those are noise. The furnaces and heat pumps are components of the two
HVAC systems — `Item.systemId` points at them — and the reminder targets the
systems as well. Naming the system already says everything the component rows
say.

Nothing is malfunctioning. The reminder genuinely has six `ReminderTarget` rows
and `worker/jobs/notify.ts` maps them one-to-one. The redundancy is *semantic*
(item ⊂ system), so no duplicate-collapse could have caught it.

The in-app UI already solves this. `components/targets/TargetsChips.tsx`
suppresses an item chip whose parent system is in the same target set, and
`lib/reminders/queries.ts` selects `item.systemId` specifically to feed that
rule. Neither email path knows the rule exists — `notify.ts` does not even load
`systemId`, so the fact is out of scope at render time.

## Goal

Teach the reminder email, the digest email, and the in-app calendar grid what
the chip renderer already knows, without duplicating the rule a third and
fourth time.

## Non-goals

- **Changing the data.** The four item targets stay. They carry independent
  `nextDueOn` values and are completed individually; deleting them would lose
  per-filter tracking.
- **Deduping the editors.** `MarkCompleteDialog` and `ReminderForm` must keep
  listing all six targets. One is how you complete a single filter, the other
  is how you edit the target set. Hiding rows there would make targets
  unreachable.
- **The ICS feed.** `app/api/calendar/[token]/route.ts` already emits one event
  per reminder (`targets: { …, take: 1 }`). Unaffected.
- **Push notifications.** They carry title and description only.
- **Dashboard "Upcoming".** `listUpcomingReminders` already collapses to one row
  per reminder and renders no target names.

## The rule

New pure module `lib/reminders/target-coverage.ts`, with a colocated
`target-coverage.test.ts`.

```ts
export type CoverageFacts = {
  /** id of the System this target *is*; null for item targets. */
  systemId: string | null;
  /** id of the System owning the Item this target *is*; null when the item is
   *  unassigned, or when the target is a system. */
  itemSystemId: string | null;
  /** This target's own due date. Omit to skip the date check entirely. */
  dueOn?: CalendarDate;
};

export function dropSystemCoveredItems<T>(
  targets: readonly T[],
  facts: (t: T) => CoverageFacts,
): T[];
```

An item target *I* is hidden iff some target *S* in the same set satisfies both:

1. `S.systemId === I.itemSystemId` (and that value is non-null), and
2. their due dates agree.

Dates agree when **either side omits `dueOn`**, or when both are present and
equal. The omit-means-agree branch is what lets `TargetsChips` — which has no
date context at all — call this function and keep its current behavior exactly.

A system target is never a candidate for suppression, so any suppression implies
at least one system target survives. The list can never be emptied by this rule.

### Why date agreement matters

Each `ReminderTarget` carries its own `nextDueOn`, advanced independently when
that target is completed. A furnace filter completed late drifts away from its
system's date. Suppressing unconditionally would then hide an overdue component
until its parent system happened to come due. Requiring agreement costs nothing
in the common case — all six of the reported targets share August 1 — and
guarantees the email never silently drops something actionable.

`CalendarDate` is a `@db.Date` value pinned to UTC midnight, so comparison is
`getTime()` equality. No timezone is involved: per `lib/time/tz.ts`, a calendar
date is already a day and must never be read through the house timezone.

## Call sites

### `components/targets/TargetsChips.tsx`

`resolve()` delegates to `dropSystemCoveredItems`, passing no `dueOn`. This is a
pure refactor — the existing `TargetsChips.test.tsx` must stay green with no
edits, which is the check that the shared function preserved the semantics.

### Reminder email — `worker/jobs/notify.ts` + `lib/email/templates/reminder.tsx`

`notify.ts` adds `systemId` to the item select, which is the only reason the
fact reaches the template:

```ts
item: { select: { id: true, name: true, systemId: true } },
```

`ReminderEmailTarget.item` gains `systemId?: string | null`, and
`resolveTargets` filters before mapping. Both the HTML body and `buildText` go
through `resolveTargets`, so the plaintext part stays in sync for free.

The filter lives in the template rather than the worker so it is covered by the
fast unit test in `reminder.test.ts` rather than only by an integration test —
the explicit lesson recorded in PR #311.

### Digest email — `lib/digests/group.ts`

`groupBySystem` currently pushes each row's target into `entry.targets` during
the loop, dropping the one that *is* the group's own system. It will instead
buffer the rows per entry and project once at the end:

1. apply `dropSystemCoveredItems` to the entry's rows, then
2. drop the target that is the group's own system (unchanged rule — the heading
   already names it).

`DigestTarget` is `{ kind, id, name }` and carries no `systemId`, so
`itemSystemId` is read from the buffered **row**'s resolved `system`, not from
its `target`. That is the reason the loop buffers rows rather than targets.

Two properties make this simpler than it looks:

- **Attribution has already resolved parentage.** `queries.ts` sets an item
  target's group to `t.item.system`, so within group *S*, every item target's
  parent is *S* by construction.
- **Entry scope already guarantees date agreement.** The entry key is
  `(system, reminder, dueOn)`, so every row inside one entry shares a due date.
  `dueOn` is therefore omitted from the facts, and a drifted item target lands
  in a *different* entry — one carrying no system target — where nothing is
  suppressed. The date rule holds without any date code on this path.

An entry can now legitimately end up with zero targets. `digest.tsx` already
handles that in both parts — `it.targets.length > 0 ? ' · ' : ''` in the HTML
body and the `targetNames ? ' (…)' : ''` guard in `buildText`. Under the
`Downstairs HVAC` heading the entry renders as the reminder title followed by
`due August 1, 2026`, **with no `·` separator**, since the separator is
suppressed along with the targets.

The `queries.ts` projection is unchanged; `DigestRow` already carries both the
resolved `system` and the `target`.

### Calendar grid — `lib/calendar/queries.ts`

Six targets due August 1 produce six identical "HVAC Filters" dots. The events
carry no target name, so the repetition conveys nothing — and since
`CalendarEvent.id` is `reminder.id`, the six siblings already share a React key.

This is a *different* rule from system coverage: collapse duplicate
`(reminderId, date)` pairs, whatever their targets. It is extracted into a pure
`lib/calendar/collapse.ts` exporting `collapseDuplicateReminderEvents(events)`,
applied after projection, so it can be unit-tested — `listCalendarEventsInRange` has no test today and would otherwise
need Testcontainers. The stale comment at line 32 ("a reminder spanning 3 items
renders as 3 dots, not one") is rewritten to state the new intent.

Two details the signature does not convey on its own:

- The function takes the mixed `CalendarEvent[]` union, so the dedupe key
  includes `kind`. Service records are keyed on their own row id and can never
  collide, but keying on `kind` makes that structural rather than incidental.
- Collapse is **keep-first** and order-preserving. Input arrives
  `nextDueOn asc` and the caller re-sorts afterward regardless, so the surviving
  event's position is stable either way.

`components/calendar/MonthGrid.tsx` keys its events on `` `${ev.kind}:${ev.id}` ``.
Six targets on one date therefore emit six siblings sharing one React key today;
the collapse fixes that as a side effect rather than by patching the key.

## Testing

| File | Cases |
|---|---|
| `lib/reminders/target-coverage.test.ts` | parent targeted → hidden; parent not targeted → kept; dates differ → kept; unassigned item (`itemSystemId` null) → kept; system target never hidden; empty input |
| `lib/email/templates/reminder.test.ts` | six-target HVAC fixture renders two lines, in HTML *and* text; drifted date keeps its item |
| `lib/digests/group.test.ts` | entry carrying its own system target drops item targets; drifted-date entry keeps them; Unassigned group unaffected |
| `lib/calendar/collapse.test.ts` | duplicates on one date collapse; same reminder on two dates stays two events; distinct reminders untouched |
| `components/targets/TargetsChips.test.tsx` | unchanged, must stay green |

Every new assertion is verified red-then-green by removing the rule under test.
PR #311 found two sorting rules whose tests passed against already-sorted
fixtures; fixtures here are built to fail without the rule.

## Risks

- **Visual baselines.** Collapsing calendar dots changes
  `reminders-calendar-populated-{desktop,mobile}-chromium-linux.png` if the seed
  contains a multi-target reminder. Baselines regenerate only through
  `pnpm test:visual:update` (dockerized) — macOS-generated ones diff forever.
- **`Item.systemId` is `onDelete: SetNull`.** Deleting a system silently
  un-covers its items, and they reappear in the next email. This is correct
  behavior, and it is why coverage is computed at render time rather than
  denormalized.
- **Behavior change with no migration.** Nothing is stored; every surface
  recomputes per render. Reverting is a code revert.
