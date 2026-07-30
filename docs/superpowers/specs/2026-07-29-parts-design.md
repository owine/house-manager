# Parts — a construct for replaceable and consumable components

**Date:** 2026-07-29
**Status:** Approved (design)

## Problem

There is nowhere to record a replaceable component. Bulbs, air filters, water
filters, batteries, belts, fuses and softener salt all share a shape the schema
cannot express: a *specification* you consult in order to re-buy the thing,
attached to something else in the house, replaced repeatedly over time.

The gap surfaced through conversational capture. Asked to record some light
bulbs, the AI created an `Item` named "Backyard String Lights" and populated it
with bulb data — base type, colour temperature — because `Item` is the only
construct that can own metadata, a vendor link and a reminder. The shoehorn is
diagnostic rather than a prompt-quality failure: the model reached for `Item`
because nothing better exists.

Today the user logs a filter change as a self-performed `ServiceRecord` and
keeps the filter size in their head or in an item's free-text notes. That works
for history and cadence but loses the spec, which is the part they actually need
when standing in a hardware store.

## Goal

A `Part` construct that carries the re-buy specification, links to any number of
`Item`s and `System`s, and reuses the existing `Reminder` and `ServiceRecord`
machinery for cadence and replacement history.

Three requirements, in the user's words:

- **Spec lookup** — "what bulb goes in the backyard string lights?"
- **Replacement history** — "when did I last change the furnace filter?"
- **Due reminders** — "the furnace filter is due in two weeks."

## Non-goals

- **Stock on hand.** No counts of spares, no decrementing, no ledger. Explicitly
  declined: it turns a log into a balance-tracking system nobody maintains.
- **A separate replacement log.** Replacements are `ServiceRecord`s, matching what
  the user already does.
- **Warranty and inbound-email targeting.** Parts do not carry warranties, and
  inbound email has no reason to link to one. `warranty_targets` and
  `incoming_email_targets` are untouched.
- **Per-usage cadence.** See "Rejected alternatives".
- **Dashboard widgets.** Parts due already surface through reminders.

## Key existing behaviour this design relies on

Verified against the code:

- **`ReminderTarget` carries its own `nextDueOn` and `lastCompletedOn`**
  (`prisma/schema.prisma:496-497`), so cadence can be delegated wholesale rather
  than reimplemented.
- **`ReminderCompletion` can auto-create a `ServiceRecord`** via
  `Reminder.autoCreateServiceRecord` and
  `ReminderCompletion.createdServiceRecordId` — so "completing the filter
  reminder logs the swap" already exists.
- **`attachments` has no owner-XOR constraint.** Only
  `Attachment_storage_xor_link` and `Attachment_file_metadata_required`
  (`prisma/migrations/000000000000_squashed_migrations/migration.sql:731-743`).
  Adding `partId` is purely additive: one nullable FK, one index, no constraint
  surgery.
- **`reminder_targets`' parent CHECK is already a relaxed special case** —
  `NOT ("itemId" IS NOT NULL AND "systemId" IS NOT NULL)`, i.e. *at most* one,
  so an unlinked chore can own a standalone row
  (`prisma/migrations/20260525005333_chore_targets_allow_unlinked/migration.sql`).
  The "only CHOREs may do this" half is enforced in `lib/reminders/actions.ts`,
  not the database.
- **`tryDeleteVendor` establishes the probe-style delete pattern**
  (`lib/vendors/actions.ts:85-110`): attempt the delete, catch the RESTRICT FK
  violation via `isFkViolation`, return structured counts so the UI can offer a
  resolution. `lib/db-errors.ts` already handles the pg18 SQLSTATE 23001 quirk.
- **`Item` has no delete action.** `lib/items/actions.ts` exposes
  `archiveItem`/`restoreItem` only. `System` has both `archiveSystem` and
  `deleteSystem`.
- **`assignItemToSystem` / `unassignItemFromSystem`** (`lib/systems/actions.ts:95`,
  `:124`) are the template for link/unlink actions with their own UI affordance.
- **`enqueueSearchIndex` and `enqueueEmbed` are generic over entity kind**, so
  parts need no new queue. `lib/queue.ts` is untouched.
- **`freeformMetadataSchema` rejects reserved (`_`-prefixed) metadata keys**
  (`lib/categories.ts:24-33`) with a load-bearing comment about emitting the
  issue at the record root rather than per-key.

## Design

### Data model

`Part` is a **specification**. It owns no dates and no parent FK.

```prisma
enum PartKind {
  BULB
  AIR_FILTER
  WATER_FILTER
  BATTERY
  BELT
  FUSE
  CHEMICAL      // softener salt, pool chlorine, descaler
  OTHER
}

model Part {
  id                   String    @id @default(cuid())
  name                 String
  kind                 PartKind  @default(OTHER)

  // Describes an unlinked/generic part ("Kitchen can lights"). Per-installation
  // location lives on PartLink; see "Accepted warts".
  location             String?

  // Re-buy identity
  manufacturer         String?
  model                String?   // part number: BR30-927-DIM, FPR-20-25-1
  sku                  String?
  typicalCost          Decimal?  @db.Decimal(10, 2)
  packQuantity         Int?      // how many come in a box
  purchaseLinks        Json      @default("[]")   // [{ label?, url }]

  metadata             Json      @default("{}")   // per-kind spec, see below
  notes                String?   @db.Text

  archivedAt           DateTime?
  createdAt            DateTime  @default(now())
  updatedAt            DateTime  @updatedAt

  links                PartLink[]
  reminderTargets      ReminderTarget[]
  serviceRecordTargets ServiceRecordTarget[]
  attachments          Attachment[]

  @@index([kind])
  @@index([archivedAt])
  @@map("parts")
}

model PartLink {
  id                String   @id @default(cuid())
  partId            String
  itemId            String?
  systemId          String?

  // Per-installation facts: 24 S14s at the backyard lights, 6 BR30s in the
  // kitchen. Distinct from Part.packQuantity (how many per box).
  location          String?
  quantityInstalled Int?

  createdAt         DateTime @default(now())

  part              Part     @relation(fields: [partId], references: [id], onDelete: Cascade)
  item              Item?    @relation(fields: [itemId], references: [id], onDelete: Cascade)
  system            System?  @relation(fields: [systemId], references: [id], onDelete: Cascade)

  // NULLS NOT DISTINCT set in the migration directly, matching the four
  // existing target tables.
  @@unique([partId, itemId, systemId])
  @@index([partId])
  @@index([itemId])
  @@index([systemId])
  @@map("part_links")
}
```

**`Part` has no date columns.** This is the payoff from delegating cadence and
history: `nextDueOn` stays on `reminder_targets` and `performedOn` on
`service_records`, where both are already branded and guarded. So
`lib/prisma-extensions.ts` and `CALENDAR_DATE_FIELDS` in
`lib/calendar-date-guard.ts` need **no changes**, and the repo's most expensive
recurring bug class is sidestepped rather than defended against.

**A standalone part is a part with zero links.** No both-NULL sentinel row, so
`part_links` gets a plain two-way XOR identical to the existing target tables.

### Migration SQL

`prisma migrate diff` emits none of this; it must be appended by hand.

```sql
ALTER TABLE "part_links" ADD CONSTRAINT "part_links_parent_xor"
  CHECK (("itemId" IS NULL) <> ("systemId" IS NULL));

DROP INDEX "part_links_partId_itemId_systemId_key";
CREATE UNIQUE INDEX "part_links_partId_itemId_systemId_key"
  ON "part_links"("partId", "itemId", "systemId") NULLS NOT DISTINCT;

-- reminder_targets: replace the pairwise form with the general one. Still
-- "at most one" — the standalone-chore relaxation must survive.
ALTER TABLE "reminder_targets" DROP CONSTRAINT "reminder_targets_parent_at_most_one";
ALTER TABLE "reminder_targets" ADD CONSTRAINT "reminder_targets_parent_at_most_one"
  CHECK (num_nonnulls("itemId", "systemId", "partId") <= 1);

-- service_record_targets: still exactly one.
ALTER TABLE "service_record_targets" DROP CONSTRAINT "service_record_targets_parent_xor";
ALTER TABLE "service_record_targets" ADD CONSTRAINT "service_record_targets_parent_xor"
  CHECK (num_nonnulls("itemId", "systemId", "partId") = 1);

-- both NULLS NOT DISTINCT uniques must be dropped and recreated, not extended.
-- Names are explicit and must match a `map:` on the corresponding @@unique.
DROP INDEX "reminder_targets_reminderId_itemId_systemId_key";
CREATE UNIQUE INDEX "reminder_targets_reminder_item_system_part_key"
  ON "reminder_targets"("reminderId","itemId","systemId","partId") NULLS NOT DISTINCT;
DROP INDEX "service_record_targets_serviceRecordId_itemId_systemId_key";
CREATE UNIQUE INDEX "sr_targets_record_item_system_part_key"
  ON "service_record_targets"("serviceRecordId","itemId","systemId","partId") NULLS NOT DISTINCT;
```

**The index names must be shortened and mapped explicitly.** Prisma's default
name for the service-record unique would be
`service_record_targets_serviceRecordId_itemId_systemId_partId_key` — **65
characters, over Postgres's 63-byte identifier limit.** Postgres truncates
silently and Prisma truncates by its own rule, so the hand-written name and the
name Prisma expects would disagree and `migrate-check` would report permanent
drift. Both models therefore carry an explicit map:

```prisma
@@unique([reminderId, itemId, systemId, partId], map: "reminder_targets_reminder_item_system_part_key")
@@unique([serviceRecordId, itemId, systemId, partId], map: "sr_targets_record_item_system_part_key")
```

Both are mapped, not just the overflowing one, so the two tables stay symmetric.

`num_nonnulls(...)` replaces the pairwise formulation deliberately: the existing
`NOT (a AND b)` shape needs three clauses for three columns, and more as columns
are added.

Plus `partId String?` + relation + `@@index([partId])` on `ReminderTarget`,
`ServiceRecordTarget` and `Attachment`, with `@@unique` updated on the two target
models.

### Per-kind spec schemas

`lib/parts/kinds.ts`, mirroring `categoryConfigs` in `lib/categories.ts`. Because
`kind` is a real column it *is* the discriminator, so no `typeField`/`visibility`
indirection is needed:

```ts
export const partKindConfigs: Record<PartKind, z.ZodTypeAny> = { ... }
```

| Kind | Spec fields |
|---|---|
| `BULB` | `base` (E26/E12/E17/E39/GU10/GU24/GU5.3/G4/G9/other), `shape` (A19/A21/BR30/BR40/PAR20/PAR30/PAR38/MR16/G25/ST19/S14/T8/other), `technology` (LED/incandescent/halogen/CFL/fluorescent), `watts`, `wattEquivalent`, `lumens`, `colorTempK`, `cri`, `dimmable`, `voltage`, `ratedHours` |
| `AIR_FILTER` | `nominalSize` (`20x25x1`), `actualSize`, `merv`, `mpr`, `fpr`, `pleated`, `ratedMonths` |
| `WATER_FILTER` | `cartridgeType` (ro-membrane/sediment/carbon-block/fridge-inline), `micronRating`, `capacityGallons`, `ratedMonths` |
| `BATTERY` | `size` (AA/AAA/C/D/9V/CR2032/CR2450/CR123A/18650/other), `chemistry`, `voltage`, `capacityMah`, `rechargeable` |
| `BELT` | `beltType`, `length`, `profile` |
| `FUSE` | `amps`, `voltage`, `fuseType`, `fastBlow` |
| `CHEMICAL` | `form` (pellet/crystal/liquid/tablet/powder), `concentration`, `containerSize` |
| `OTHER` | freeform JSON, reserved-key guard included |

Three decisions inside that table:

- **`base` and `shape` are separate fields for bulbs.** *E26* is the socket,
  *BR30* is the geometry, and they vary independently. Collapsing them into one
  "type" is what would make the data useless for re-buying.
- **`packQuantity` is a column, not a spec field.** It appeared in three of eight
  kinds and shares its grain with `typicalCost` and `purchaseLinks`.
- **Lifespan stays per-kind** — `ratedHours` for bulbs, `ratedMonths` for filters.
  Different units, and neither is a cadence; the cadence is on the `Reminder`.
  Unifying them would force a unit field and buy nothing.

**Kind changes after creation** silently strip incompatible spec keys, since
non-strict `z.object` drops unknowns. Same as changing an item's category today.

**One targeted refactor:** extract `freeformMetadataSchema` from
`lib/categories.ts` into `lib/metadata/freeform.ts`, imported by both
`categories.ts` and `parts/kinds.ts`. `PartKind.OTHER` needs exactly the
reserved-key rejection that schema carries; copying it guarantees the two drift
and one loses the `_provenance` guard. Behaviour-preserving move only.

### Feature module

Standard triple under `lib/parts/`: `schema.ts` (Zod only), `queries.ts`
(read-only, no `'use server'`, takes `ListParams`, returns `{ parts, total }`),
`actions.ts` (`'use server'`). Plus `kinds.ts` for the per-kind configs.

`purchaseLinks` is validated as
`z.array(z.object({ label: z.string().max(80).optional(), url: z.string().url() })).max(10)`.

Deliberately **not** a `ConsumableVendor` join mirroring `ItemVendor`/
`SystemVendor`: neither can hold a URL — the link would live on
`Vendor.website`, forcing a `Vendor` row for Amazon in order to save a product
link. Wrong grain for a bulb.

### Archiving

**A part is treated as archived wherever all of its parents are archived** —
derived, not stored. No `Part.archivedAt` writes on parent archive, no
reconciliation, nothing to drift; restoring the parent brings the part back
automatically. `Part.archivedAt` still exists independently for "I stopped using
this bulb type while keeping the fixture".

The composite rule — a part is **live** when it is not itself archived *and*
either has no links or has at least one link to a live parent:

```ts
const LIVE_PART = {
  archivedAt: null,
  OR: [
    { links: { none: {} } },
    { links: { some: { OR: [{ item: { archivedAt: null } }, { system: { archivedAt: null } }] } } },
  ],
};
```

And its negation, backing the `/parts` "archived" filter — note it is *not*
simply `archivedAt: { not: null }`:

```ts
const ARCHIVED_PART = {
  OR: [
    { archivedAt: { not: null } },
    {
      AND: [
        { links: { some: {} } },
        { links: { none: { OR: [{ item: { archivedAt: null } }, { system: { archivedAt: null } }] } } },
      ],
    },
  ],
};
```

Both constants live in `lib/parts/queries.ts` and are exported, so the rule is
written once. It applies to: the `/parts` list, the target pickers, and the
search/embedding enumerators. It is a no-op on the Item/System Parts tabs, where
the parent is live by definition.

For search and embedding, parts follow **whatever the codebase already does with
`Item.archivedAt`** rather than inventing a policy — PR 1 must check
`buildDocument` and the reindex enumerator and match it. Getting this wrong
leaves a part whose only parent is archived sitting in Meilisearch and in the
pickers.

A link row with `itemId` NULL and a live `systemId` resolves correctly here:
`{ item: { archivedAt: null } }` compiles to an EXISTS-based `is:` filter, which
is false rather than vacuously true, and the `system` disjunct carries it.

The stored-cascade alternative (write `archivedAt` onto each part, clear on
restore) was rejected: two sources of truth and a reconciliation bug of the same
family as `Item.restoredAt`'s mutual-clear.

### Deleting a system that has parts

`Item` has no delete action, so this applies to `deleteSystem` only. Archiving a
system needs no prompt — the derived rule above covers it.

Link rows cascade when a system is deleted, so the parts survive. The prompt
therefore asks about *archiving orphaned parts*, not deleting parts:

```ts
export type TryDeleteSystemResult =
  | { ok: true }
  | { ok: false; hasParts: true; parts: { id: string; name: string; kind: PartKind; willBeOrphaned: boolean }[] }
  | { ok: false; formError: string };

deleteSystemWithParts(input: { systemId: string; archivePartIds: string[] }):
  Promise<ActionResult<{ archivedCount: number; keptCount: number }>>
```

1. **`deleteSystem(id)` pre-queries** for parts linked to that system and returns
   the **list** rather than a count, so the dialog can render names and kinds.

   Note this is *not* the probe-style pattern `tryDeleteVendor` uses.
   `PartLink.system` is `onDelete: Cascade` (shipped in PR 1a), so a system
   delete succeeds silently and cascades the link rows away — **there is no
   RESTRICT violation to catch.** `tryDeleteVendor` probes because a RESTRICT FK
   is the only thing stopping that delete; here nothing stops it, so an explicit
   pre-check is both correct and simpler:

   ```ts
   const parts = await prisma.part.findMany({
     where: { links: { some: { systemId: id } } },
     select: { id: true, name: true, kind: true, _count: { select: { links: true } } },
   });
   // willBeOrphaned: every one of this part's links points at the system being deleted
   ```

   An earlier draft of this section described a RESTRICT probe. That was a
   fossil of the pre-many-to-many design, where `Part` carried a single parent FK
   set to `Restrict` specifically to force the probe. Many-to-many removed it.
2. Dialog: one row per part with a checkbox, plus select-all/none. Rows are
   **default-checked only when `willBeOrphaned`** — a part still linked to two
   other fixtures should not be archived because one was deleted.
3. `deleteSystemWithParts` runs one `prisma.$transaction`: set `archivedAt` on
   the checked set, delete the link rows, delete the system.

**Concurrency is handled explicitly.** A part linked between the probe and the
submit appears in neither list. The action must re-read the system's links
*inside* the transaction and, if any is unaccounted for, roll back and return the
fresh probe result so the dialog re-renders. Deriving "unchecked" from "absent"
would silently archive-or-skip a part the user never saw.

`Part.name` is user-supplied and renders as text, never markup.

### Linking

- `linkPartToParent({ partId, itemId?, systemId? })` — one parent per call,
  rejected by the XOR CHECK otherwise; idempotent against the unique index.
- `unlinkPart({ linkId })`.
- "Link existing part" on the Item/System Parts tab, alongside "Add part".
  Follows `assignItemToSystem`/`unassignItemFromSystem`.

### Pages and navigation

| Route | Shell |
|---|---|
| `/parts` | `ListPageShell` + `PageHeader` + `EmptyState`; filter by kind, parent, archived |
| `/parts/new`, `/parts/[id]/edit` | `FormPageShell`; one `PartForm`, create vs edit by `defaultValues?.id` |
| `/parts/[id]` | `DetailPageShell`; tabs Overview, Links, Reminders, Service, Attachments |

All server components. Forms are `'use client'` + react-hook-form +
`zodResolver` on the shared server schema, with the action **injected as a prop**.
Values typed as `z.input<typeof schema>`.

Nav: a `/parts` entry in `AppSidebar.tsx` grouped with items/systems/vendors —
it is inventory, not activity. `Boxes` or `Puzzle` in preference to `Lightbulb`,
which over-indexes on bulbs.

**A Parts tab on the Item and System detail pages**, listing that parent's parts
with inline "Add part" (pre-filling the parent) and "Link existing part". This is
how parts actually get created; nobody navigates to `/parts/new` and then hunts
for the furnace.

**The detail view must filter reserved metadata keys.** `OverviewTab` for items
shipped this bug — `_provenance` rendered raw in "Additional Details". Any new
view enumerating a `metadata` blob needs `isReservedMetadataKey` from day one.

### Target pickers

- `lib/targets/schema.ts` — a **new** `partTargetSchema` (exactly one of
  `itemId`/`systemId`/`partId`) for reminders and service records;
  `targetSchema`'s existing refine is left alone for warranties and incoming
  email. See "Target validation schemas must be split, not widened". Both
  `toTargetInputs`' mapping branch *and* its filter widen.
- `lib/targets/expand.ts` — dedupe keys gain a `p:` prefix alongside `i:`/`s:`.
- Picker UI gains a third radio, wired via `label[for="…"]` (Playwright will
  error with "outside of viewport" on the bare `RadioGroupItem`).

### Target reconciliation — the data-loss trap

**This is the highest-risk change in PR 1.** Adding a third nullable parent
column silently redefines every predicate written as "both columns are null".

`lib/reminders/actions.ts:228-239` splits existing rows two ways:

```ts
const existingLinks = existing.targets.filter((t) => t.itemId !== null || t.systemId !== null);
const existingStandalone = existing.targets.find((t) => t.itemId === null && t.systemId === null);
```

A part-only row is `itemId === null && systemId === null`. So it is **excluded
from `existingLinks` and matched as the standalone-chore sentinel**, then hard
deleted by `tx.reminderTarget.delete({ where: { id: existingStandalone.id } })`
(`:289`). Every part target on a reminder would disappear on the next save, with
no error.

Compounding it, the diff key is `` `${t.itemId ?? ''}|${t.systemId ?? ''}` `` in
**four** places — `lib/reminders/actions.ts:274`, `:276`, `:293`, and
`lib/service-records/actions.ts:137`. Every part target collapses to the literal
string `"|"`, so a second part target on one reminder or record reads as a
duplicate and is dropped.

Required changes:

- **Redefine the standalone sentinel** as
  `itemId === null && systemId === null && partId === null`, and widen
  `existingLinks` to `itemId !== null || systemId !== null || partId !== null`.
  The invariant comment at `:230-236` describes the sentinel as the only
  both-NULL shape; it must be updated, not just the code.
- **Extend all four diff keys** to
  `` `${itemId ?? ''}|${systemId ?? ''}|${partId ?? ''}` `` — **and extend the
  Prisma `select`s that feed them**: `lib/reminders/actions.ts:151-161`,
  `lib/service-records/actions.ts:131-133`, and `createReminder`'s result select
  at `:121-123` (which feeds `revalidateReminderPaths`). **None of the three
  selects `partId`** — the reminder one also selects `lastCompletedOn` and
  `nextDueOn`, so don't diff against a literal `{ id, itemId, systemId }`.

  **Typecheck will not catch a missed select.** `key()`'s parameter is
  structurally typed with optional fields
  (`{ itemId?: string | null; systemId?: string | null }`), so adding `partId?`
  compiles fine against rows that never selected it. Every persisted part row then
  keys to `"x||"` while the submitted row keys to `"||p1"` — absent from
  `wantSet`, so it lands in `toDelete`. Green on `pnpm verify`, destroys data at
  runtime.
- **Widen the `toTargetInputs` filter**, not just its mapping branch.
  `lib/targets/schema.ts:29` filters `t.itemId !== null || t.systemId !== null`;
  left as-is it drops part rows from the edit form, the form submits without
  them, and `updateReminder`'s diff deletes them — reproducing the very loss this
  section exists to prevent. Its docblock (`:16-24`) describes the two-column
  invariant and goes stale.
- **`toTargetInputs` has exactly one production caller**
  (`app/(app)/reminders/[id]/edit/page.tsx:33`). The service-record edit page
  **duplicates the logic inline** — `app/(app)/service/[id]/edit/page.tsx:28-30`
  does its own `t.itemId ? { itemId } : { systemId: t.systemId as string }` — so
  widening the helper does **not** fix service records. Left as-is a part row
  becomes `{ systemId: null }`, fails the refine or submits garbage, and
  `updateServiceRecord`'s diff deletes the part target: the same loss, on the
  flagship furnace-filter path. Either route it through the shared helper or widen
  it in place; routing it through is preferable since the duplication is what hid
  the bug.

**Every create path must pass `partId` through**, or a part target inserts as an
all-NULL row and violates the new CHECK — these throw rather than misfile, so a
missed one is a 500, not silent corruption:

- `createReminder` — `lib/reminders/actions.ts:113-118`
- `updateReminder` — both the `createMany` and `create` calls in the branches above
- `targetsToCreateData` — `lib/service-records/actions.ts:43-48`, used by
  `createServiceRecord`

**`completeReminder` is the flagship path and breaks hardest.**
`lib/reminders/actions.ts:407` selects only `{ id, itemId, systemId }`, and
`:474-477` mirrors the target onto a new `ServiceRecordTarget` with
`itemId ?? null, systemId ?? null`. For a part target that row is all-NULL,
violating `num_nonnulls(...) = 1`, and the `$transaction` throws unhandled. This
is exactly the "completing the filter reminder logs the swap" behaviour this
design leans on. Both the select and the create need `partId`.

**`validateTargets`** in `lib/reminders/actions.ts:42-70` and
`lib/service-records/actions.ts:17-36` checks item/system existence and returns a
clean `'Item not found'`. Parts need the same, or a bogus `partId` surfaces as a
raw FK exception instead of a form error.

**`revalidateReminderPaths` / `revalidateForTargets`** revalidate `/items/:id`
and `/systems/:id` only, and their parameter types are `{ itemId, systemId }`.
Both need widening plus a `/parts/:id` branch, or a part detail page showing
reminders and service records serves stale data.

Integration tests must cover: saving a reminder that has a part target twice (the
target survives); a reminder with two part targets (both survive); completing a
part-targeted reminder with `autoCreateServiceRecord` (the mirrored
`ServiceRecordTarget` carries `partId`); and a CHORE that has a standalone
sentinel row when a part target is submitted — the sentinel is **replaced**, not
preserved, because the widened `existingLinks` makes part rows links and the
`else if (existingStandalone)` branch (`:267-289`) deletes the sentinel by
design.

### Target validation schemas must be split, not widened

`targetSchema` in `lib/targets/schema.ts` is **shared with two consumers whose
tables keep their two-way XOR**: `lib/warranties/schema.ts:5` (via
`targetsArraySchema`) and `lib/incoming-email/actions.ts:35`. Widening its refine
to exactly-one-of-three would let a `{ partId }` payload pass Zod for a warranty,
whose mapper (`lib/warranties/actions.ts:41`, `:92`) then writes an all-NULL row
that `warranty_targets_parent_xor` rejects. Same for
`lib/incoming-email/actions.ts:71`.

So:

- **`targetSchema` / `targetsArraySchema` keep their current item-XOR-system
  refine.** Warranties and incoming email are untouched, at the validation
  boundary as well as the table.
- **Add `partTargetSchema`** (exactly one of `itemId` / `systemId` / `partId`),
  consumed by `lib/reminders/schema.ts:151-152` and
  `lib/service-records/schema.ts:10`.
- `toTargetInputs` returns the widened shape and is used only by the reminder and
  service-record edit paths.

The earlier framing — "widen the shared refine" — was wrong: the non-goal that
`warranty_targets` and `incoming_email_targets` are untouched holds for the
tables but not for a validator they import.

**Selecting a System does not expand to its parts.** `expandSystemSelection`
auto-includes a system's active items; extending that to parts is the
obvious-looking move and is wrong. "Serviced the furnace" must not silently claim
the filter was replaced. Items are *components* of a system; parts are *consumed
by* it.

### Target label rendering

A third parent column breaks every site that renders a target label. The pattern
to grep is **not just `item?.name ?? system?.name`** — it is that expression
*plus* every `kind: 'item' | 'system'` union and every `t.item` / `t.system`
branch pair. Each needs a part branch, or a part-targeted row renders blank or
mislabelled:

- `components/targets/TargetsChips.tsx:36-63` — **the most damaging.** `resolve()`
  branches on `t.system` / `t.item` and its own comment says a target with
  neither "renders nothing". It backs `ReminderTable`, `ServiceRecordTable` and
  `WarrantyTable`, so a part-targeted service record would show **no target chip
  at all** in the main history table.
- `app/(app)/reminders/[id]/edit/page.tsx:31` — a comment describing the
  two-column invariant; goes stale.
- `app/(app)/dashboard/UpcomingRemindersCard.tsx:46` and
  `app/(app)/reminders/[id]/page.tsx:104-105` — byte-identical hits. Both fall
  through to `(unnamed target)` and both derive
  `kind: t.systemId ? 'system' : 'item'`, mislabelling a part as an item.
- `components/reminders/MarkCompleteDialog.tsx:22`, `:122` — a
  `kind: 'item' | 'system'` union that renders an "Item" badge for a part.
- `lib/email/templates/reminder.tsx:56-79` — **the notification email itself**,
  fed by `worker/jobs/notify.ts:30-34` (selects only `item`/`system`) and `:131`.
  It falls through to `label: '(no target)'` with `href: data.appUrl`. Part
  reminders are `kind: 'REMINDER'` and therefore *do* notify, so requirement 3
  ("the furnace filter is due in two weeks") would send an unlabelled email
  pointing at the app root. Both the template and the worker select need the part
  branch.
- `lib/digests/queries.ts:44-46` plus the `DigestTarget` type in
  `lib/digests/group.ts:8` — a part target falls through to `target: null`, which
  is indistinguishable from a standalone chore, so the digest names no target.
  The work is in the queries and the types; nothing in `lib/email/templates/digest.tsx`
  matches the grep.
- `lib/search/document.ts` — **the bullet an earlier draft got wrong.** `:159` is
  the *service* case in `toDocument`, not reminders. The reminder path (`:184`,
  and `buildDocument` at `:319-327`) reads `r.item?.name` only and does not
  include system names today, so there is no reminder `targetNames` to fix. The
  site that needs a part branch is the service-record aggregation loop in
  `buildDocument` at `:296-303`, **plus its select at `:284-289`**.
- `lib/embedding/canonicalize.ts:137` (service records). The sharp edge for PR 3:
  a part-targeted `ServiceRecord`'s embedding would silently omit the target
  name, undercutting the retrieval goal. `:161` (warranties) needs no change,
  since warranties never target parts — listed only so the grep hit isn't
  mistaken for an oversight.

**`dropSystemCoveredItems` (`lib/reminders/target-coverage.ts`) needs no change**
and must not be "fixed": a part row projects `{ systemId: null, itemSystemId: null }`
and the `itemSystemId === null` guard already keeps it. It sits directly upstream
of three of the sites above, so it will look suspicious.

**The ICS feed needs no change.** `app/api/calendar/[token]/route.ts` selects
only `targets.nextDueOn` and renders no target names. An earlier draft listed it;
that was wrong.

## Sequencing

Three PRs. PR 1 stands alone and is useful without the others.

**PR 1a — schema + target widening.** The `PartKind` enum, the `Part` and
`PartLink` models, the migration creating both tables, the `partId` columns and
the CHECK/index rebuild, plus the reconciliation fix, the validation-schema
split, and every label-rendering site — with their integration tests and nothing
else.

**The models must be here, not deferred.** Prisma requires both sides of a
relation, so `ReminderTarget.part Part?` cannot exist without `Part` and its
`reminderTargets` back-reference. And every label site reads the *relation*
(`t.part?.name`, plus `part: { select: { id, name } }` added to the selects in
`worker/jobs/notify.ts`, `lib/digests/queries.ts`, `lib/search/document.ts:284-289`
and `lib/embedding/canonicalize.ts`) — none of which a bare `partId String?`
supports. `validateTargets`' part-existence check needs `prisma.part.findMany`,
and without a `parts` table there is no FK, so a bogus `partId` would insert
cleanly: the precise failure that check exists to prevent.

Nothing user-visible still ships — two empty tables and a model with no Zod
surface, no routes and no nav entry are invisible to the user, so the intent of
the split (review the highest-risk change on its own) is preserved.

Integration tests split accordingly: `part_links` CHECK/unique assertions and the
target-reconciliation assertions are PR 1a (they need a `Part` fixture row, which
1a makes possible); the derived-archive query and `deleteSystemWithParts` are
PR 1b with the queries and dialog they exercise.

**PR 1b — feature surface.** `lib/parts/*` (schema, queries, actions, kinds),
pages, nav, Parts tabs, the picker UI, the link/unlink actions, the
`deleteSystemWithParts` dialog, the `freeform.ts` extraction, seed rows,
`knip.json` entries.

**PR 2 — conversational capture.** `CREATE_PART`/`UPDATE_PART` in
`ChatProposalKind`; the payload union in `lib/chat/schema.ts`;
`lib/chat/resolve.ts`; the apply switches in `lib/chat/actions.ts` (`:79`,
`:1067`). The system prompt must learn that parts exist, or the model keeps
reaching for `CREATE_ITEM` even with the enum available.

**This PR must fix `Decimal` handling in `ChatProposal.beforeSnapshot`.**
`prisma/schema.prisma:757-766` documents that Decimal fields serialize into
`Json` as strings and **silently break the diff render**, closing with "No
proposal kind touches a Decimal field today; keep it that way." `typicalCost`
breaks that invariant. Either exclude it from proposal payloads or fix the
snapshot/diff path properly — the latter is correct but touches shared code every
proposal kind flows through, so it is called out as work, not a footnote.

**PR 1b does not enqueue search indexing.** `enqueueSearchIndex` is typed to
`SearchKind`, and `'part'` does not join that union until PR 3 — so `createPart`
and `updatePart` omit the enqueue in PR 1 and gain it in PR 3, rather than the
executor hitting a type error and improvising. (`enqueueEmbed` is likewise
deferred; `EmbeddingEntityType.PART` also arrives in PR 3.)

**PR 3 — retrieval.** `'part'` in `SEARCH_KINDS` plus `ICON`, `RowFor`,
`toDocument`, `buildDocument` and the reindex enumerator in
`lib/search/document.ts`; `PART` in `EmbeddingEntityType` with a
`canonicalizePart` alongside the six existing canonicalizers. Note `system` is
itself not currently a `SearchKind` — adding `part` before `system` is
deliberate, since a part's spec is the thing the user needs to look up, but it is
worth knowing it isn't an oversight. The canonicalizer
must drop reserved metadata keys, as `canonicalizeItem` does. This is what makes
"what bulb goes in the backyard string lights?" answerable via Ask — spec data
you cannot retrieve is a filing cabinet with no index.

## Testing

- **Unit** — `lib/parts/schema.test.ts` (per-kind spec schemas, `purchaseLinks`
  URL validation, reserved-key rejection on `OTHER`), `lib/targets/schema.test.ts`
  and `expand.test.ts` extensions, `canonicalizePart` coverage.
- **Integration** (Testcontainers, real Postgres) — where the value is, because
  the CHECK constraints and `NULLS NOT DISTINCT` uniques **cannot be tested with
  mocks**. Assert: `part_links` rejects both-NULL and both-set; a part with zero
  links is legal; `num_nonnulls(...) <= 1` on `reminder_targets` with the
  standalone-chore case still passing; `= 1` on `service_record_targets`;
  duplicate `(reminder, item)` still rejected after the unique rebuild;
  `deleteSystemWithParts` rolling back when a link appears mid-transaction; the
  derived-archive query.
- **E2E** — create a part, link it to an item and a system, target it from a
  reminder and a service record, and exercise the delete-system dialog. At most
  one `@critical` tag, since CI runs only those.

## Rejected alternatives

**A dedicated `PartReplacement` log** instead of `ServiceRecord`. Argued for on
grain (service records are *jobs*; swaps are high-frequency and low-information)
and because it could carry `quantity`. Rejected because the user already logs
filter changes as self-performed `ServiceRecord`s — a second log would split
existing history at an arbitrary date. `quantity` goes in
`ServiceRecord.summary`.

**Parts as reminder targets only, with history via `ReminderCompletion`.**
Rejected because bulbs have no cadence: you replace them when they burn out. A
replacement with no reminder would have nowhere to live.

**A fully self-contained `Part` with its own `recurrence` and `nextDueOn`.**
Smallest diff, but consumables would silently never notify until a tick job,
notification logging, digest section and ICS entries were also built — the work
moves somewhere less tested, and the app ends up with two notions of "due".

**Option B: links as first-class "usages" that reminders target
(`reminder_targets.partUsageId`).** Gives per-location cadence — separate due
dates for two air handlers sharing a filter size. Rejected because bulbs have no
cadence and filters typically have one usage, so it pays off only for a narrow
case while charging everywhere: pickers would stop offering parts and start
offering part-at-a-location. `location` and `quantityInstalled` live on
`PartLink` regardless, so B remains a target-FK migration rather than a
restructuring if it is ever wanted.

**`Consumable` as the name.** Narrower, and would have discouraged filing whole
appliances under it. `Part` chosen for the wider net covering one-off replacement
parts. Cost accepted: `part` is a common word here (`tzParts`,
`formatToParts`), so greps are noisier.

**A `Category` FK for `kind`**, as `Item` uses. Rejected: the set is small and
stable and it selects a Zod schema, so an enum gives compile-time exhaustiveness
instead of a runtime lookup miss.

## Accepted warts

- **`Part.location` and `PartLink.location` both exist.** The former describes an
  unlinked generic part ("Kitchen can lights"), the latter a specific
  installation. Mildly redundant, kept so the user needn't create a link just to
  record where something is.
- **`deleteSystem`'s return type changes** from `ActionResult` to
  `TryDeleteSystemResult`, so its existing callers need updating. A visible
  breaking change, not a silent one.
- **`TargetInput` stays narrow.** Warranties and incoming email import it as
  their mapper parameter type, so the widened shape needs a distinct name —
  `PartTargetInput`.
- **`validateTargets`' cardinality message** (`'Select at least one item or
  system'`) should mention parts.
- **`Part.includeInSuggestions` was dropped.** `Item` carries it, so parity was
  tempting, but nothing consumes it — parts are not in the AI suggestion flow and
  this design does not put them there. YAGNI; add it when a consumer exists.
- **Cadence is shared across a part's links.** Two air handlers on different
  filter schedules need two reminders, or two parts. See Option B above.

## Related fixes shipped alongside this work

Two `_provenance` leaks found while investigating, fixed ahead of this design:

- `app/(app)/items/[id]/tabs/OverviewTab.tsx` rendered reserved metadata keys raw
  in "Additional Details".
- `components/items/ItemMetadataFields.tsx` pre-filled the freeform JSON textarea
  with `_provenance`, which `freeformMetadataSchema` *rejects* — making any
  AI-captured item in `other` or an unregistered category unsaveable on a field
  the user never touched.

Both still need tests. The underlying lesson: `RESERVED_METADATA_PREFIX` had
enforcement at the write path and the embedding path, and its own comment
enumerated those two as if the list were complete. Every boundary that
enumerates a metadata blob needs the filter — `Object.entries(metadata)` is the
grep that finds them.
