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
  (`lib/vendors/actions.ts:77-110`): attempt the delete, catch the RESTRICT FK
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

  includeInSuggestions Boolean   @default(true)
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

-- both NULLS NOT DISTINCT uniques must be dropped and recreated, not extended
DROP INDEX "reminder_targets_reminderId_itemId_systemId_key";
CREATE UNIQUE INDEX "reminder_targets_reminderId_itemId_systemId_partId_key"
  ON "reminder_targets"("reminderId","itemId","systemId","partId") NULLS NOT DISTINCT;
DROP INDEX "service_record_targets_serviceRecordId_itemId_systemId_key";
CREATE UNIQUE INDEX "service_record_targets_serviceRecordId_itemId_systemId_partId_key"
  ON "service_record_targets"("serviceRecordId","itemId","systemId","partId") NULLS NOT DISTINCT;
```

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
| `WATER_FILTER` | `cartridgeType` (RO membrane/sediment/carbon block/fridge inline), `micronRating`, `capacityGallons`, `ratedMonths` |
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

List queries derive it:

```ts
// a part is visible if it has no links, or at least one link to a live parent
OR: [
  { links: { none: {} } },
  { links: { some: { OR: [{ item: { archivedAt: null } }, { system: { archivedAt: null } }] } } },
]
```

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

1. `deleteSystem(id)` probes. On the RESTRICT violation, `isFkViolation` catches
   it and the action returns the **list** rather than a count, so the dialog can
   render names and kinds.
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

- `lib/targets/schema.ts` — `targetSchema` gains `partId`; the refine changes
  from `Boolean(itemId) !== Boolean(systemId)` to exactly-one-of-three.
  `toTargetInputs` gains a `partId` branch, keeping the standalone-chore filter.
- `lib/targets/expand.ts` — dedupe keys gain a `p:` prefix alongside `i:`/`s:`.
- Picker UI gains a third radio, wired via `label[for="…"]` (Playwright will
  error with "outside of viewport" on the bare `RadioGroupItem`).

**Selecting a System does not expand to its parts.** `expandSystemSelection`
auto-includes a system's active items; extending that to parts is the
obvious-looking move and is wrong. "Serviced the furnace" must not silently claim
the filter was replaced. Items are *components* of a system; parts are *consumed
by* it.

### Reminder rendering

`lib/targets/expand.ts`, the reminder email templates, the digest templates and
the ICS feed all render target labels as Item-or-System. Each needs a third
branch, or a part-targeted reminder notifies with a blank label.

## Sequencing

Three PRs. PR 1 stands alone and is useful without the others.

**PR 1 — core.** Schema + migration SQL, `lib/parts/*`, pages, nav, Parts tabs,
target-picker and reminder-rendering changes, the `deleteSystemWithParts` dialog,
the `freeform.ts` extraction, seed rows, `knip.json` entries.

**PR 2 — conversational capture.** `CREATE_PART`/`UPDATE_PART` in
`ChatProposalKind`; the payload union in `lib/chat/schema.ts`;
`lib/chat/resolve.ts`; the apply switches in `lib/chat/actions.ts` (`:84`,
`:1072`). The system prompt must learn that parts exist, or the model keeps
reaching for `CREATE_ITEM` even with the enum available.

**This PR must fix `Decimal` handling in `ChatProposal.beforeSnapshot`.**
`prisma/schema.prisma:757-766` documents that Decimal fields serialize into
`Json` as strings and **silently break the diff render**, closing with "No
proposal kind touches a Decimal field today; keep it that way." `typicalCost`
breaks that invariant. Either exclude it from proposal payloads or fix the
snapshot/diff path properly — the latter is correct but touches shared code every
proposal kind flows through, so it is called out as work, not a footnote.

**PR 3 — retrieval.** `'part'` in `SEARCH_KINDS` plus `ICON`, `RowFor`,
`toDocument`, `buildDocument` and the reindex enumerator in
`lib/search/document.ts`; `PART` in `EmbeddingEntityType` with a
`canonicalizePart` alongside the six existing canonicalizers. The canonicalizer
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
