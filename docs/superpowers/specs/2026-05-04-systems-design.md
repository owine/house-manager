# Systems — group items into a single logical system

**Date:** 2026-05-04
**Status:** Draft for review
**Authors:** Oliver Wine (with Claude)

## Overview

Add a `System` entity that groups related items into a single logical unit while keeping each component's identity (model, serial, per-unit warranty) intact. A System is itself first-class enough to own service records, warranties, reminders, and notes that belong to the system as a whole rather than to any one component.

Canonical example: an HVAC system made of a heat pump (outdoor unit), an evaporator coil, and a gas furnace (air handler / backup heat). Each has its own manufacturer, model, and serial. But the annual tune-up, the installer's labor warranty, and "replace whole-system filter" reminders belong to the system, not to any one box.

This is a focused extension of Plan 2a's item model. Single PR off main.

## Goals

1. Let the user create a System with a name, type, install date, installer, and notes; assign existing items to it; view all member items + system-level events on one page.
2. Allow a single service record, warranty, or reminder to target **multiple** items and/or systems via a per-record join table (e.g., one HVAC tune-up visit covers heat pump + furnace + humidifier; one extended-coverage warranty bundles three appliances; one "replace filters" reminder fans out to three components).
3. In any multi-target picker, **selecting a System auto-checks all its active component items** as well, with every checkbox individually toggleable so the user can trim the list before saving.
4. Reminder completion is configurable at the moment of completion — defaults to all targets at once, but the user can uncheck targets to record a partial completion that advances only the selected targets' due dates.
5. The system's detail page shows a unified timeline merging system-level events with all member items' events, deduplicating records that target both.
6. Items remain individually viewable and editable; nothing about the per-item experience regresses.

## Non-goals

- Many-to-many membership. An item belongs to at most one system. Shared components (e.g., a thermostat that controls heat pump + furnace) get assigned to the primary system; cross-references go in `notes`.
- System-of-systems / nested systems.
- Auto-suggesting which items belong together. Manual assembly only.
- Migrating existing items into systems automatically. The user opts in per system.
- Per-component "role within system" metadata (e.g., labeling the furnace as the "backup heat source"). If we want it later, add a `role String?` to a future membership table; for now, item name + notes carry it.
- Changing how categories work. A System has its own `kind` field; items keep their `Category`.

## User-resolved design choices

1. **System is hybrid first-class** (option C from brainstorming): owns its own row with name/install/installer, *and* can be a target on service records, warranties, and reminders — but per-component events stay attachable to items too.
2. **One system per item**: `Item.systemId String?` nullable FK.
3. **All three event tables are multi-target via parallel join tables**: `ServiceRecord` ↔ `ServiceRecordTarget`, `Warranty` ↔ `WarrantyTarget`, `Reminder` ↔ `ReminderTarget`. Each target row is `(parentId, itemId?, systemId?)` with a DB CHECK that exactly one of `itemId`/`systemId` is set. The polymorphic single-parent-FK pattern is *not* used; this is more uniform and lets a single record cover multiple things naturally.
4. **Picker auto-expands System selection to its components**: in any multi-target picker, checking a system also checks every active component item belonging to it. The system itself remains checked. The user can uncheck individual items (or the system) to trim the target list before saving. The auto-expand is a one-time UI action at the moment of selection — it does not create a live link, so adding a component to the system later does not retroactively touch existing records.
5. **Archive does not cascade**: archiving a system sets only the system's `archivedAt`. Member items stay active with their `systemId` cleared (mirroring the hard-delete `onDelete: SetNull` semantics). Components frequently outlive the system they were installed under, so the user archives them individually if they want to.
6. **Per-target due-state on reminders**: each `ReminderTarget` row carries its own `lastCompletedOn` and `nextDueOn` so per-target completion can advance dates independently. (Service records and warranties have no due-state, so their target rows are pure references.)
7. **Reminder completion is configurable at the moment of completion**, defaulting to all targets selected: the "Mark complete" UI shows all targets pre-checked. The user can uncheck targets to record a partial completion. Each checked target produces one `ReminderCompletion` row (each with its own optional auto-created `ServiceRecord`, which itself becomes a single-target service record attached to that target's item or system).
8. **Items and Systems both have multi-vendor relationships with roles**: parallel join tables `ItemVendor` and `SystemVendor` link to `Vendor` with a shared `VendorRole` enum (`PURCHASE`, `INSTALLER`, `SERVICE`, `WARRANTY_PROVIDER`, `MANUFACTURER`, `OTHER`). Each row references either an existing `Vendor` (`vendorId` FK) **or** a free-text `freeformName` (for entities that aren't worth a full vendor row, e.g., a manufacturer like "LG Electronics" you'll never call). XOR CHECK enforces exactly one is set. The single `installerVendorId` / `installer` fields on System are not introduced; those concerns are carried by `SystemVendor` rows with role `INSTALLER` from day one.

## Schema

New model:

```prisma
model System {
  id              String    @id @default(cuid())
  name            String
  kind            String?   // free-text: "HVAC", "Plumbing — hot water", "Solar", ...
  location        String?
  installDate     DateTime?
  installCost     Decimal?  @db.Decimal(10, 2)
  notes           String?   @db.Text
  archivedAt      DateTime?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  items                 Item[]
  serviceRecordTargets  ServiceRecordTarget[]
  warrantyTargets       WarrantyTarget[]
  reminderTargets       ReminderTarget[]
  systemVendors         SystemVendor[]
  attachments           Attachment[]
  systemNotes           Note[]    @relation("SystemNotes")

  @@index([archivedAt])
  @@map("systems")
}
```

A shared `VendorRole` enum and parallel `ItemVendor` / `SystemVendor` join tables capture the multi-vendor relationships for both items and systems:

```prisma
enum VendorRole {
  PURCHASE
  INSTALLER
  SERVICE
  WARRANTY_PROVIDER
  MANUFACTURER
  OTHER
}

model ItemVendor {
  id            String      @id @default(cuid())
  itemId        String
  vendorId      String?
  freeformName  String?     // used when no Vendor row exists, e.g., "LG Electronics"
  role          VendorRole
  notes         String?     @db.Text
  createdAt     DateTime    @default(now())

  item          Item        @relation(fields: [itemId], references: [id], onDelete: Cascade)
  vendor        Vendor?     @relation(fields: [vendorId], references: [id], onDelete: Restrict)

  @@index([itemId])
  @@index([vendorId])
  @@map("item_vendors")
}

model SystemVendor {
  id            String      @id @default(cuid())
  systemId      String
  vendorId      String?
  freeformName  String?
  role          VendorRole
  notes         String?     @db.Text
  createdAt     DateTime    @default(now())

  system        System      @relation(fields: [systemId], references: [id], onDelete: Cascade)
  vendor        Vendor?     @relation(fields: [vendorId], references: [id], onDelete: Restrict)

  @@index([systemId])
  @@index([vendorId])
  @@map("system_vendors")
}
```

Each table gets an XOR CHECK enforcing that exactly one of `vendor_id` / `freeform_name` is set (raw SQL in the migration, same pattern as the target tables).

**Vendor delete behavior**: the FK uses `onDelete: Restrict` rather than `SetNull`, because nulling `vendor_id` would violate the XOR CHECK (both columns null). Deleting a vendor with linked items/systems is blocked at the DB level. The UI offers two app-level resolutions before delete: (a) "Convert links to freeform" — copy `vendor.name` into each linked row's `freeformName`, then null `vendorId`, then delete; or (b) "Delete all links" — remove every linked row, then delete the vendor. Both are explicit user actions, never silent. (`ServiceRecord.vendor` and other Vendor FKs without an XOR partner keep `SetNull` as today — the constraint conflict only exists where freeform-fallback is in play.)

`Vendor` gets back-relations:

```prisma
model Vendor {
  // ...existing fields...
  itemVendors    ItemVendor[]
  systemVendors  SystemVendor[]
}
```

Modifications to existing models — all three event tables drop their direct parent FK and route through a target join table:

```prisma
model Item {
  // ...existing fields...
  systemId               String?
  system                 System?  @relation(fields: [systemId], references: [id], onDelete: SetNull)

  serviceRecordTargets   ServiceRecordTarget[]
  warrantyTargets        WarrantyTarget[]
  reminderTargets        ReminderTarget[]
  itemVendors            ItemVendor[]

  // Removed: serviceRecords ServiceRecord[], warranties Warranty[], reminders Reminder[]
  // (item's records now reached through *Target tables)

  @@index([systemId])
}

model ServiceRecord {
  // ...existing fields, with itemId removed...
  // Removed: itemId, item
  targets   ServiceRecordTarget[]
}

model ServiceRecordTarget {
  id               String         @id @default(cuid())
  serviceRecordId  String
  itemId           String?
  systemId         String?

  serviceRecord    ServiceRecord  @relation(fields: [serviceRecordId], references: [id], onDelete: Cascade)
  item             Item?          @relation(fields: [itemId], references: [id], onDelete: Cascade)
  system           System?        @relation(fields: [systemId], references: [id], onDelete: Cascade)

  @@unique([serviceRecordId, itemId, systemId])
  @@index([itemId])
  @@index([systemId])
  @@map("service_record_targets")
}

model Warranty {
  // ...existing fields, with itemId removed...
  // Removed: itemId, item
  targets   WarrantyTarget[]
}

model WarrantyTarget {
  id          String     @id @default(cuid())
  warrantyId  String
  itemId      String?
  systemId    String?

  warranty    Warranty   @relation(fields: [warrantyId], references: [id], onDelete: Cascade)
  item        Item?      @relation(fields: [itemId], references: [id], onDelete: Cascade)
  system      System?    @relation(fields: [systemId], references: [id], onDelete: Cascade)

  @@unique([warrantyId, itemId, systemId])
  @@index([itemId])
  @@index([systemId])
  @@map("warranty_targets")
}

model Reminder {
  // ...existing fields, with itemId / lastCompletedOn / nextDueOn removed...
  // (lastCompletedOn / nextDueOn move to ReminderTarget so per-target completion can advance dates independently)
  targets          ReminderTarget[]
  completions      ReminderCompletion[]
  notificationLogs NotificationLog[]
}

model ReminderTarget {
  id              String    @id @default(cuid())
  reminderId      String
  itemId          String?
  systemId        String?
  lastCompletedOn DateTime?
  nextDueOn       DateTime

  reminder        Reminder  @relation(fields: [reminderId], references: [id], onDelete: Cascade)
  item            Item?     @relation(fields: [itemId], references: [id], onDelete: Cascade)
  system          System?   @relation(fields: [systemId], references: [id], onDelete: Cascade)
  completions     ReminderCompletion[]

  @@unique([reminderId, itemId, systemId])
  @@index([itemId])
  @@index([systemId])
  @@index([nextDueOn])
  @@index([reminderId])
  @@map("reminder_targets")
}

model ReminderCompletion {
  // ...existing fields, plus:
  targetId   String
  target     ReminderTarget @relation(fields: [targetId], references: [id], onDelete: Cascade)
  // createdServiceRecordId already exists. The auto-created service record gets one
  // ServiceRecordTarget row pointing at the completion's target's item or system.

  @@index([targetId, completedOn])
}
```

Raw SQL in the migration enforces the XOR invariant on each target table:

```sql
ALTER TABLE service_record_targets
  ADD CONSTRAINT service_record_targets_parent_xor
  CHECK ((item_id IS NULL) <> (system_id IS NULL));
ALTER TABLE warranty_targets
  ADD CONSTRAINT warranty_targets_parent_xor
  CHECK ((item_id IS NULL) <> (system_id IS NULL));
ALTER TABLE reminder_targets
  ADD CONSTRAINT reminder_targets_parent_xor
  CHECK ((item_id IS NULL) <> (system_id IS NULL));
ALTER TABLE item_vendors
  ADD CONSTRAINT item_vendors_link_xor
  CHECK ((vendor_id IS NULL) <> (freeform_name IS NULL));
ALTER TABLE system_vendors
  ADD CONSTRAINT system_vendors_link_xor
  CHECK ((vendor_id IS NULL) <> (freeform_name IS NULL));
```

Backfill (interleaved with the schema change in the migration): for each existing `ServiceRecord`, insert one `ServiceRecordTarget` row carrying its current `itemId`. Same for `Warranty` and `Reminder`. For `Reminder`, the new target row also carries the reminder's existing `lastCompletedOn` and `nextDueOn`. Then update each existing `ReminderCompletion.targetId` to point at its reminder's (now-singleton) target row. Finally drop the old `itemId` / `lastCompletedOn` / `nextDueOn` / parent-related indexes from `reminders`, `service_records`, and `warranties`.

`Attachment` and `Note` already key on a polymorphic `parentType/parentId` (Plan 2b pattern); add `"system"` as a new parentType — no schema change there beyond the new `Note @relation("SystemNotes")` and a parallel `Attachment` relation.

`onDelete: SetNull` on `Item.systemId` means deleting a System leaves its components intact and orphaned (back to "loose item"). Deleting an item does not touch the system. This matches the user's mental model: tearing down an HVAC system shouldn't delete the furnace record.

## UI

Three new surfaces, plus light edits to existing ones:

1. **`/systems`** — list page mirroring `/items`. Card grid: name, kind, member count, install date, next reminder. Empty state explains the concept with the HVAC example.
2. **`/systems/[id]`** — detail page with four sections:
   - **Header**: name, kind, location, install date, edit / archive actions, and a **cost rollup**: components subtotal (`SUM(item.purchasePrice)` for active member items where `purchasePrice IS NOT NULL`) + `installCost`, with a tooltip breaking the two apart. If both are null, the rollup is hidden. Lifetime service-record cost is *not* rolled up here (different question; v2).
   - **Vendors**: chip list of `SystemVendor` rows, each labeled with its role and either the linked vendor's name (clickable → `/vendors/[id]`) or its `freeformName`. "Add vendor" opens an inline editor.
   - **Components**: card list of member items. Each card links to `/items/[id]`. "Add component" picker shows items with `systemId IS NULL` (filtered by an optional category match suggestion).
   - **Timeline**: unified, reverse-chronological list of service records, warranties, and reminders for the system *plus* all member items. Each row shows a small chip group of its targets: e.g., "HVAC system + 2 components". Filter chips: All / System-targeted / Component-targeted.
3. **`/systems/new`** — RHF + Zod form: name (required), kind, location, install date, install cost, notes. The vendor list is added on the detail page after creation (avoids a complex multi-row sub-form on the create page).

Edits to existing surfaces:

- **Item detail page** — new "System" field showing the parent system as a link, with a small "remove from system" / "assign to system" action.
- **Item form** — optional system picker (defaults to none). Archived systems are excluded from the picker.
- **Item detail page** — new "Vendors" chip list mirroring the system page's vendor section. Same role-tagged add/edit affordance.
- **Vendor / freeform-name editor** — shared sub-form used on both Item and System detail pages: a combobox that searches existing `Vendor` rows; a separate "free text" toggle that switches the input mode and stores `freeformName` instead. A role select is required. Inline "Create vendor" affordance for users who decide mid-flow to promote a freeform name into a real vendor row.
- **Vendor detail page** — new "Linked items" and "Linked systems" sections grouped by role. Each row links to the item/system and shows the role chip.
- **All three event forms (service record / warranty / reminder)** share the same multi-select **Targets picker**:
  - Two sections: *Systems* (active only) and *Items* (active only, grouped by category). Search box on top.
  - Pre-seeded from launch context (item page → that item; system page → that system + all its active components; standalone `/reminders/new` etc. → empty).
  - **Auto-expand on system check**: checking a system row also auto-checks its component items in one stroke. Subsequently un-checking the system does *not* auto-uncheck the components — the user is in control after the initial expand.
  - Validation: at least one target required.
- **Mark complete dialog (reminders only)** — for any reminder with 2+ targets, the completion action opens a dialog listing all targets with checkboxes, all checked by default. Notes field below. Submitting writes one `ReminderCompletion` row per checked target and advances each target's `nextDueOn` per the recurrence rule. Single-target reminders skip the dialog and complete in one click (existing behavior).
- **Sidebar nav** — add "Systems" entry between "Items" and "Vendors".

## Data flow

With every event table going through a target join, the timeline query becomes uniform: a record belongs on a system's page if **any** of its target rows points at the system or at any item whose `systemId` matches. The pattern collapses to one `findMany` per event type (no more system-vs-component split):

```ts
// pseudocode, server component
const targetSomeMatchesSystem = {
  some: {
    OR: [{ systemId: id }, { item: { systemId: id } }],
  },
} as const;

const [system, components, serviceRecords, warranties, reminders] = await prisma.$transaction([
  prisma.system.findUniqueOrThrow({ where: { id } }),
  prisma.item.findMany({ where: { systemId: id, archivedAt: null } }),
  prisma.serviceRecord.findMany({
    where: { targets: targetSomeMatchesSystem },
    include: { targets: { include: { item: true, system: true } } },
  }),
  prisma.warranty.findMany({
    where: { targets: targetSomeMatchesSystem },
    include: { targets: { include: { item: true, system: true } } },
  }),
  prisma.reminder.findMany({
    where: { targets: targetSomeMatchesSystem },
    include: { targets: { include: { item: true, system: true } } },
  }),
]);
```

Each record appears at most once per type because the `findMany` is on the parent record, not on its targets — the `some:` filter is a presence check. No render-time deduplication needed for that reason. (Within a single record's row, the targets list is rendered as a small chip group: e.g., "HVAC system + 2 components".)

**Item detail page query** follows the same shape, restricted to a single item:

```ts
prisma.serviceRecord.findMany({
  where: { targets: { some: { itemId } } },
  include: { targets: { include: { item: true, system: true } } },
});
// (same shape for warranty.findMany, reminder.findMany)
```

**Worker query change**: the existing reminder notification worker (`worker/`) currently selects from `reminders` ordered by `nextDueOn`. After this change it queries `reminder_targets` where `nextDueOn <= now + leadTime` and groups results by `reminderId` for the digest.

## Validation

Zod schemas mirror the new shapes:

- `SystemCreateSchema`: `name` required (1–120 chars), everything else optional.
- A shared `TargetSchema = z.object({ itemId: z.string().optional(), systemId: z.string().optional() }).refine(t => !!t.itemId !== !!t.systemId, "exactly one of itemId/systemId")` mirrors the DB CHECK.
- `ServiceRecordCreateSchema` / `WarrantyCreateSchema` / `ReminderCreateSchema` each take a `targets: z.array(TargetSchema).min(1)` (v1 requires ≥1 target — orphan records have no UI surface).
- `ReminderCompletionSchema`: `targetIds: z.array(z.string()).min(1)` — submitter picks which target rows the completion covers.
- `VendorLinkSchema = z.object({ vendorId: z.string().optional(), freeformName: z.string().min(1).max(120).optional(), role: z.nativeEnum(VendorRole), notes: z.string().optional() }).refine(v => !!v.vendorId !== !!v.freeformName, "exactly one of vendorId/freeformName")` — used by both `ItemVendor` and `SystemVendor` create/update endpoints.

## Testing

- **Unit**: `TargetSchema` XOR refinement; targets-array `.min(1)` validation on all three event create schemas; system create/update/archive; per-target completion advances only the selected targets' `nextDueOn`; auto-expand-on-system helper produces the expected (system + active components) target set; cost rollup correctly excludes archived components and treats null prices as zero; `VendorLinkSchema` XOR refinement (vendorId / freeformName).
- **Integration (Vitest + test DB)**: assigning/unassigning items to a system; deleting a system leaves items intact with `systemId = null`; deleting a target row does not affect sibling targets on the same record; the XOR CHECK rejects target rows with both or neither parent (on `service_record_targets`, `warranty_targets`, `reminder_targets`); the unique constraint on `(parentId, itemId, systemId)` rejects duplicate targets on a single record; the migration backfill creates exactly one target row per existing service record / warranty / reminder, rewires `ReminderCompletion.targetId` correctly, and preserves `lastCompletedOn`/`nextDueOn` on the new ReminderTarget; `item_vendors` and `system_vendors` XOR CHECK rejects rows with both or neither of `vendor_id`/`freeform_name`; attempting to delete a Vendor with linked items/systems fails with a Postgres FK error (Restrict); the app's "convert links to freeform" flow copies `vendor.name` to each linked row's `freeformName`, nulls `vendorId`, then succeeds at deleting the vendor; the "delete all links" flow removes link rows then deletes the vendor.
- **Smoke (Playwright)**: (1) create system → add two items → log a multi-target service record using auto-expand → verify it appears once on the system page and on each component page; (2) create a reminder with two targets → mark complete with one target unchecked → verify only the checked target's `nextDueOn` advanced and a single `ReminderCompletion` row was written; (3) link an item to an existing Vendor with role PURCHASE → also link to a free-text MANUFACTURER → verify both render on the item page and the vendor's detail page lists the item under its role.

## Open questions

None remaining for v1. Earlier deferrals (cost rollup, installer-as-vendor) were resolved into the spec on 2026-05-04: the system header now shows a components-subtotal + install-cost rollup, and the installer is a `Vendor` FK with the existing free-text field kept as a fallback for users who don't want to create a vendor row.

A future v2 enhancement worth flagging (not blocking): a *lifetime* cost rollup that also sums service-record costs across the system and its components. Different mental model from the v1 capital-cost rollup, so kept separate intentionally.

## Rollout

Single PR. One Prisma migration covering:

- New tables: `systems` (with `install_cost` decimal column, indexed on `archived_at`), `service_record_targets`, `warranty_targets`, `reminder_targets`, `item_vendors`, `system_vendors`.
- New `VendorRole` enum.
- New nullable column `systemId` on `items` (with index, FK).
- Removal of direct parent columns: `service_records.item_id`, `warranties.item_id`, `reminders.item_id`, `reminders.last_completed_on`, `reminders.next_due_on`, plus the `@@index([nextDueOn])`, `@@index([active, nextDueOn])`, and `@@index([itemId])` on `reminders`, and the `@@index([itemId])` on `service_records` and `warranties`.
- New column `reminder_completions.target_id` (FK + index).
- Five XOR CHECK constraints on the new target tables and the two vendor-link tables.
- Data backfill (one target row per existing service record / warranty / reminder; rewire `reminder_completions`). No backfill is needed for `item_vendors` / `system_vendors` because there are no pre-existing item-vendor or system-installer relationships in the database — Items have no vendor field today, and System is a brand-new model.

Migration mechanics: neither the CHECK constraints nor the backfill is expressible in `schema.prisma`, so generate the migration with `prisma migrate dev --create-only`, then hand-edit the generated SQL file to interleave the steps in the right order:

1. Add new tables and new columns (target tables, `systems`, `items.system_id`, `reminder_completions.target_id` initially nullable).
2. Backfill: `INSERT INTO ..._targets (parent_id, item_id) SELECT id, item_id FROM ...` for each event type; for reminders also copy `last_completed_on` / `next_due_on`. Then `UPDATE reminder_completions SET target_id = ...` joining on `reminder_id`.
3. Set `reminder_completions.target_id` to `NOT NULL`.
4. Drop the old parent columns and obsolete indexes from `service_records`, `warranties`, `reminders`.
5. Add the five CHECK constraints (three target-table XORs, two vendor-link XORs).

Worker code (`worker/` directory) needs an update in the same PR to query `reminder_targets` instead of `reminders.nextDueOn`. Existing data is preserved with no parent-row loss: every old service record / warranty / reminder now has exactly one target row pointing at its original item, so item-detail pages show the same records they did before.
