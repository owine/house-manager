# Item-Restored Dashboard Event — Design

**Date:** 2026-05-20
**Status:** Design — pending review

## Problem

The dashboard activity feed (`lib/dashboard/queries.ts` → `recentActivity`) surfaces six event kinds, including `item-archived` (derived from `Item.archivedAt`). It has no `item-restored` event. A standing `NOTE` comment defers it "until an event log table exists."

The blocker is data, not UI: `restoreItem` sets `archivedAt = null`, **destroying the only timestamp**. After a restore, an item is indistinguishable from one that was never archived — there's nothing to derive a "restored" event from.

## Goal

Surface an `item-restored` event in the dashboard activity feed, derived from a durable timestamp, following the exact pattern already used for `item-archived`.

## Non-goals

- No full archive/restore history (multiple events per item over time). The activity feed shows recent transitions; the most-recent transition is sufficient.
- No new event-log/audit table.
- No `item-restored` surfacing anywhere other than the dashboard activity feed (not search, not notifications).
- No change to the six existing event kinds' behavior.

## Approach (chosen)

Add a `restoredAt` timestamp column to `Item`, and make archive/restore **mutually clear** each other's timestamp so exactly one is ever set. This reflects the item's *last lifecycle transition* and when it occurred:

| State | archivedAt | restoredAt |
|---|---|---|
| never archived | null | null |
| archived | T1 | null |
| restored | null | T2 |
| re-archived | T3 | null |

The dashboard derives `item-restored` from `restoredAt` exactly as it derives `item-archived` from `archivedAt`. Because the two timestamps are mutually exclusive, there are never stale/competing events.

Rejected alternatives:
- **Event-log table** — full history, but a new table + query rework; overkill for a single-user home inventory whose feed only shows recent activity.
- **Track restore without clearing** — simpler diff but produces stale competing events (a re-archived item would show both an old "restored" and a new "archived").

## Changes

### Schema (`prisma/schema.prisma`)

Add to `model Item`:
```prisma
  restoredAt      DateTime?
```
and an index mirroring the existing `@@index([archivedAt])`:
```prisma
  @@index([restoredAt])
```
One generated migration (`CREATE INDEX` + `ADD COLUMN`).

### Actions (`lib/items/actions.ts`)

Make the two timestamps mutually exclusive:
```ts
// archiveItem
await prisma.item.update({ where: { id }, data: { archivedAt: new Date(), restoredAt: null } });

// restoreItem
await prisma.item.update({ where: { id }, data: { archivedAt: null, restoredAt: new Date() } });
```
(`archiveItem` currently sets only `archivedAt`; `restoreItem` currently sets only `archivedAt: null`. Both gain the paired clear/set.)

### Dashboard query (`lib/dashboard/queries.ts`)

- Add `'item-restored'` to the `ActivityEvent['kind']` union.
- Add a 7th parallel `findMany` in the `Promise.all`: `prisma.item.findMany({ where: { restoredAt: { not: null } }, orderBy: { restoredAt: 'desc' }, take: limit, select: { id: true, name: true, restoredAt: true } })`.
- Map (mirroring the `archived` mapping, guarding the nullable timestamp):
  ```ts
  ...restored.flatMap((i) =>
    i.restoredAt
      ? [{
          kind: 'item-restored' as const,
          occurredAt: i.restoredAt,
          label: `Restored ${i.name}`,
          href: `/items/${i.id}`,
          icon: '📤',
        }]
      : [],
  ),
  ```
- Delete the stale `// NOTE: "item-restored" events are deferred ...` comment (lines 4-5).

The merged events array is already sorted by `occurredAt desc` and sliced to `limit`, so no further change.

### Interaction notes

- A restored item has `archivedAt: null`, so it correctly: (a) drops out of the `archived` list (`item-archived` won't fire), (b) re-appears in the `item-created` list (which filters `archivedAt: null`) under its original `createdAt` — correct, since "created" and "restored" are distinct events at distinct times.
- Icon `📤` pairs with archived's `📥`; trivially changeable.

## Testing

- **Action-level (integration, Testcontainers):**
  - `archiveItem` sets `archivedAt` (non-null) and `restoredAt` null.
  - `restoreItem` sets `restoredAt` (non-null) and `archivedAt` null.
  - Re-archive after restore: `archivedAt` non-null, `restoredAt` null again.
- **`recentActivity` (integration):**
  - After `restoreItem`, an `item-restored` event appears with `label: 'Restored {name}'`, `href: '/items/{id}'`, `occurredAt` = restoredAt.
  - After re-archiving that item, the feed shows `item-archived` and NOT `item-restored`.
  - A never-archived item produces no `item-restored` event.
- Existing dashboard `recentActivity` tests stay green (the six existing kinds are unchanged).

## Risks

- **Migration drift** (per the project gotcha): Prisma 7's auto-diff may emit a spurious `DROP INDEX embeddings_embedding_cosine_idx` (hand-written pgvector ivfflat index). Eyeball the generated migration and strip any such DROP before committing.
- **Backfill:** existing already-restored items (archived then restored before this ships) have `restoredAt: null` and won't retroactively show a restored event. Acceptable — the feed is forward-looking recent activity; no backfill needed.

## Out of scope / future

- Full lifecycle history / audit log (if ever wanted, that's the event-log-table approach, a separate design).
- Surfacing restore events outside the dashboard.
