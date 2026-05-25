# Chores: optional item/system targets

**Status:** Draft
**Date:** 2026-05-24

## Problem

Today `Reminder` and `Chore` share the `reminders` table, discriminated by `kind: REMINDER | CHORE`. Both require ≥1 `ReminderTarget` (an item or system link). Chores in practice are often standalone tasks ("take out the trash", "rotate the mattress") with no asset to point at, and forcing a fake link to satisfy validation distorts the data.

The proposal: **chores have 0..N item/system links; reminders still require ≥1.** This turns the "asset-link" convention into a schema rule and sharpens the kind distinction:

- **Reminder** — *this thing needs servicing on a cadence, notify me.* Asset-centric.
- **Chore** — *do this task on a cadence, I'll check the list myself.* Task-centric.

Notifications remain the only behavioral difference (reminders fire push/email via `reminders-tick`; chores never do). Digests intentionally include both — that asymmetry is deliberate and is preserved.

## Approach

### Standalone targets

A chore with zero links still gets exactly one `ReminderTarget` row, with both `itemId` and `systemId` NULL. The row holds `nextDueOn` / `lastCompletedOn` / completions exactly as today.

Why standalone-target rather than lifting schedule fields onto `Reminder`:
- Worker (`reminders-tick`), completion writes, calendar render, ICS feed, and `lib/reminders/queries.ts` all operate on `ReminderTarget`. Keeping the standalone row means none of those paths fork by kind.
- The `NULLS NOT DISTINCT` unique on `(reminderId, itemId, systemId)` already guarantees at most one standalone row per reminder.
- Trade-off: the DB allows a "target with no link" shape, which is conceptually a little odd. Mitigated by zod enforcing that standalone targets only appear under `kind=CHORE` reminders.

### Server-side reconciliation

The user submits a target list (possibly empty). The server reconciles to enforce the invariant "every chore has ≥1 target row":

- `kind=CHORE`, submitted targets has ≥1 link → no standalone row; delete any pre-existing standalone.
- `kind=CHORE`, submitted targets is empty → ensure exactly one standalone row exists (create if missing; preserve its `lastCompletedOn` / `nextDueOn` across edits).
- `kind=REMINDER`, submitted targets must be ≥1 (existing rule).

This makes the "0 links ↔ 1 standalone" mapping a server concern, invisible to the form.

## Changes

### Schema / migration

Relax the XOR CHECK on `reminder_targets`:

```sql
ALTER TABLE "reminder_targets" DROP CONSTRAINT "reminder_targets_parent_xor";
ALTER TABLE "reminder_targets"
  ADD CONSTRAINT "reminder_targets_parent_at_most_one"
  CHECK (NOT ("itemId" IS NOT NULL AND "systemId" IS NOT NULL));
```

Reads as: "at most one of itemId/systemId may be set." Both-NULL becomes legal.

No data backfill — existing chores keep their links. The new shape is only available going forward.

The Prisma schema needs no model change; `itemId` / `systemId` are already `String?`. Per the [Prisma migration drift](memory:feedback_prisma_migration_drift) note, the migration is hand-written to swap the CHECK constraint without dropping the surrounding pgvector indexes.

### Reminder-specific target validators

Keep `lib/targets/schema.ts` (`targetSchema`, `targetsArraySchema`) untouched — it's shared with service records, warranties, and incoming-email link picking, all of which still want the strict "exactly one of itemId/systemId, ≥1 row" rules. The per-row `.refine` on `targetSchema` also stays as-is.

Define the reminders split in `lib/reminders/schema.ts` (next to the existing `createReminderSchema`):

- `remindersTargetsSchema = z.array(targetSchema).min(1, …)` — current behavior.
- `choresTargetsSchema = z.array(targetSchema).min(0)` — new.

Both build on the unchanged shared `targetSchema`, so the per-row "exactly one of itemId/systemId" refine still applies to every row submitted by the form. The standalone (both-NULL) row is **never produced by zod** — it's injected server-side after parse (see next section), bypassing the per-row refine by construction.

Call sites pick the right array schema based on `kind` via the discriminated union below.

### `lib/reminders/schema.ts`

`createReminderSchema` / `updateReminderSchema` use a discriminated union on `kind`:

- `kind: 'REMINDER'` branch uses `remindersTargetsSchema`.
- `kind: 'CHORE'` branch uses `choresTargetsSchema`.

The "kind cannot silently flip on update" guard noted in the file's existing comment is preserved.

### Server action / route handler (create + update)

After zod parses, before the Prisma write:

```ts
const reconciledTargets =
  kind === 'CHORE' && parsedTargets.length === 0
    ? [{ itemId: null, systemId: null }]   // standalone
    : parsedTargets;
```

On update, transitions between linked and standalone shapes follow these rules:

- **Links → standalone** (any N>0 link rows → 0 user-submitted targets): delete all link rows, create one standalone row. The standalone row inherits `lastCompletedOn` / `nextDueOn` from the **most recently completed** link row (max `lastCompletedOn`, NULLs last); if no link row was ever completed, inherit from the row with the **earliest `nextDueOn`** (preserves the "next thing due" semantic). If neither is defined, the standalone row starts fresh from the reminder's recurrence anchor.
- **Standalone → links** (1 standalone row → N>0 user-submitted targets): the standalone row's `lastCompletedOn` / `nextDueOn` seed **every** newly-inserted link row (each link row inherits the same schedule snapshot), then the standalone row is deleted. This avoids resetting the chore's schedule when the user belatedly tags it with assets.
- **Standalone → standalone** (no link rows submitted, standalone already exists): no-op on the target table; only the reminder row's metadata (title, recurrence, etc.) updates.
- **Links → links**: existing behavior, unchanged.

### `components/reminders/ReminderForm.tsx`

- When `isChore`, drop the `targets.length === 0` error gate (lines around 100, 127).
- Label the picker "Linked items / systems (optional)" only when `isChore`.
- Keep the picker visible — per the "optional" UX choice, not "hidden."

### `components/targets/TargetsPicker.tsx`

No prop changes needed; it already renders fine with an empty list. Spot-check that the empty state copy doesn't read as an error.

### Read paths — verify, don't change

These all already left-join through `ReminderTarget` and tolerate individual NULLs:

- `lib/reminders/queries.ts` — chore listing.
- `components/calendar/MonthGrid.tsx` — verify a chore with no link renders as just the title.
- ICS feed (project_ics_completion_feed_status) — chore events without a link render with title only.
- `worker/jobs/reminders-tick.ts` — skips `kind=CHORE` entirely; unaffected.
- Dashboard activity / item-restored event paths — chores without targets don't surface item names, which is correct.

## Tests

Per [project_testing_strategy_status](memory:project_testing_strategy_status), tag the critical-path coverage `@critical`.

- `lib/reminders/schema.test.ts` — extend:
  - chore with 0 targets parses successfully.
  - reminder with 0 targets still rejected.
  - chore with mixed item + system targets parses.
- Server action / handler unit tests:
  - chore create with 0 user targets → 1 standalone row written.
  - chore update from 1 link → 0 links → standalone row created, link row deleted.
  - chore update from 0 links → 1 link → standalone row deleted, link row inserted.
  - reminder create with 0 targets still rejected.
- DB-level smoke test: insert a standalone `ReminderTarget` succeeds; insert with both `itemId` AND `systemId` set still rejected by the new CHECK.
- E2E (`@critical`): create a chore via the form with no link, complete it once, verify it reappears next cycle.

## Out of scope

- Backfilling existing linked chores into standalone shape (call: leave existing chores alone).
- Changing chore completion semantics — still per-target; standalone is its own target.
- Touching reminders' validation or UX.
- A cross-table Postgres trigger enforcing "standalone targets only under CHORE parents" — zod-only enforcement, accepting the residual risk that a direct SQL insert outside the app could create an invalid row.
- Collapsing `REMINDER` and `CHORE` into a single kind with a `notify` boolean — decided against; the mental split + existing kind-branching code make the boolean a net loss.

## Open questions

None — all design calls resolved during brainstorm:

- Picker UX: **optional**, not hidden.
- Existing data: **leave as-is**.
- Schedule home: **standalone target row**.
- Cross-table CHECK: **zod-only** enforcement.
