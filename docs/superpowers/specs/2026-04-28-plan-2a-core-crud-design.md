# Plan 2a — Core CRUD (Items, Vendors, Warranties, Service, Notes)

**Date:** 2026-04-28
**Status:** Draft for review
**Authors:** Oliver Wine (with Claude)
**Parent spec:** `docs/superpowers/specs/2026-04-26-house-manager-design.md`

## Overview

Plan 2a implements the core data-model entities and their CRUD UIs on top of the Plan 1 foundation. End state: a household member can sign in, add items (e.g., a furnace), record warranties, log service visits with vendor attribution, and write standalone or item-attached notes. The dashboard shows recent activity. The HouseProfile is editable from `/settings`.

Plan 2a deliberately excludes file attachments (Plan 2b), reminders/notifications (Plan 3), AI features (Plan 4), and polish/design-system work (Plan 5).

## Goals

1. Make the app genuinely useful as a household record-keeper without waiting for AI or notifications.
2. Land the canonical Server-Action + Zod-validation + Prisma-query pattern that all later entity work will copy.
3. Keep the data model durable — schema decisions made now (especially nullable FKs and soft delete) shape every later plan.
4. Stay within the existing Plan 1 infrastructure (no new services, env vars, or external APIs).

## Non-goals (Plan 2a only)

- File uploads / Attachment table — Plan 2b.
- Reminders, Web Push, email, iCal feed — Plan 3.
- Meilisearch sync, AI suggestions, RAG, OCR — Plan 4.
- Cmd-K palette, mobile bottom nav, dark mode, design system — Plan 5.
- Per-item visibility / ACLs — out of v1 entirely.
- Per-vendor soft delete — decided against; hard delete with confirmation suffices.

## Architecture

Inherits Plan 1's stack, processes, and patterns:

- Next.js 15 App Router under the existing `(app)/` route group (the auth gate from `app/(app)/layout.tsx` covers all new routes).
- Prisma 7 + Postgres. One new migration adds all 2a tables.
- Server Components for data fetching; Server Actions for mutations; Zod schemas shared between client form and server action; React Hook Form for client-side form state.
- No new Compose services, env vars, or external APIs.
- New runtime dependency: `react-markdown` (with `remark-gfm` and `rehype-sanitize`) for rendering markdown bodies.

## Data model

A single migration `core_crud` adds these models. All `@@map`-ed names use snake_case for the Postgres table names while Prisma keeps PascalCase models.

```prisma
model Category {
  id           String  @id @default(cuid())
  slug         String  @unique
  name         String
  icon         String?
  sortOrder    Int     @default(0)
  items        Item[]

  @@map("categories")
}

model Item {
  id              String     @id @default(cuid())
  name            String
  categoryId      String
  category        Category   @relation(fields: [categoryId], references: [id])
  location        String?
  manufacturer    String?
  model           String?
  serialNumber    String?
  purchaseDate    DateTime?
  purchasePrice   Decimal?   @db.Decimal(10, 2)
  metadata        Json       @default("{}")
  notes           String?    @db.Text
  archivedAt      DateTime?
  createdAt       DateTime   @default(now())
  updatedAt       DateTime   @updatedAt

  warranties      Warranty[]
  serviceRecords  ServiceRecord[]
  itemNotes       Note[]     @relation("ItemNotes")

  @@index([categoryId])
  @@index([archivedAt])
  @@map("items")
}

model Vendor {
  id              String     @id @default(cuid())
  name            String
  kind            String?
  phone           String?
  email           String?
  website         String?
  address         String?
  notes           String?    @db.Text
  tags            String[]
  createdAt       DateTime   @default(now())
  updatedAt       DateTime   @updatedAt

  serviceRecords  ServiceRecord[]

  @@map("vendors")
}

model Warranty {
  id              String     @id @default(cuid())
  itemId          String
  item            Item       @relation(fields: [itemId], references: [id], onDelete: Cascade)
  provider        String
  policyNumber    String?
  startsOn        DateTime
  endsOn          DateTime
  coverage        String?    @db.Text
  cost            Decimal?   @db.Decimal(10, 2)
  createdAt       DateTime   @default(now())
  updatedAt       DateTime   @updatedAt

  @@index([itemId])
  @@index([endsOn])
  @@map("warranties")
}

model ServiceRecord {
  id              String     @id @default(cuid())
  itemId          String?
  item            Item?      @relation(fields: [itemId], references: [id], onDelete: SetNull)
  vendorId        String?
  vendor          Vendor?    @relation(fields: [vendorId], references: [id], onDelete: SetNull)
  performedOn     DateTime
  cost            Decimal?   @db.Decimal(10, 2)
  summary         String
  notes           String?    @db.Text
  createdAt       DateTime   @default(now())
  updatedAt       DateTime   @updatedAt

  @@index([itemId])
  @@index([vendorId])
  @@index([performedOn])
  @@map("service_records")
}

model Note {
  id          String     @id @default(cuid())
  title       String
  body        String     @db.Text
  itemId      String?
  item        Item?      @relation("ItemNotes", fields: [itemId], references: [id], onDelete: SetNull)
  tags        String[]
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt

  @@index([itemId])
  @@map("notes")
}
```

### Design rationale

- **`Item.notes` (free-form markdown) vs. the `Note` model**. `Item.notes` is a one-field scratchpad on the item record for short context ("filter is on the front, push the dispenser to release"). `Note` is a first-class entity that can be standalone, tagged, and listed in a dedicated `/notes` view. Conflating them produces awkward UX.
- **`ServiceRecord.itemId` and `vendorId` nullable with `SetNull` on delete**. Service history must survive cleanup of the entity it referenced. With Item using soft delete (`archivedAt`), this matters more for vendor cleanup, but the same shape applies to both.
- **`Warranty` cascades from `Item`**. A warranty without its item is meaningless; if the underlying item is hard-deleted (rare, archive is preferred), the warranty goes with it.
- **`Decimal(10, 2)` for money**. Postgres-native, accurate to ±99,999,999.99 — sufficient for household scale.
- **`tags: String[]`** uses the Postgres native text array. Not normalized into a tag table. Simpler queries; the cost is no FK uniqueness on tags, acceptable for a single-household app.
- **Indexes**: just the obvious join and filter columns. Not over-indexing.
- **No Attachment table in 2a**. The polymorphic-FK columns it introduces don't exist on any model in this plan; they arrive in 2b.

### Category metadata strategy (option B2)

Each category may opt into typed metadata fields via a code-defined Zod schema in `lib/categories.ts`:

```ts
export const categoryMetadataSchemas: Record<string, z.ZodTypeAny> = {
  appliance: z.object({
    btu: z.number().optional(),
    capacity: z.string().optional(),
  }),
  vehicle: z.object({
    vin: z.string().length(17),
    licensePlate: z.string().optional(),
  }),
  // ... etc
};
```

Categories without an entry get a generic key/value editor in the form. Adding a new category is a `Category` row insert (via `prisma db seed`, Prisma Studio, or direct SQL); adding a typed schema for that category is a code change in `lib/categories.ts` plus a deploy. Existing freeform metadata stays as-is when a schema is later added.

## Routes

All new routes under `(app)/`, inheriting the auth gate from `app/(app)/layout.tsx`.

```
/(app)/
  /dashboard              — recent activity + quick stats + quick actions (UPDATED from Plan 1)
  /items                  — list (table | cards toggle, URL-based filters)
  /items/new
  /items/[id]             — detail (tabs: Overview | Warranties | Service | Notes)
  /items/[id]/edit
  /vendors                — list
  /vendors/new
  /vendors/[id]           — detail (info + ServiceRecords by this vendor)
  /vendors/[id]/edit
  /service                — global ServiceRecords list
  /service/new            — accepts ?itemId / ?vendorId for prefill
  /service/[id]
  /service/[id]/edit
  /notes                  — all notes (item-attached + standalone)
  /notes/new              — accepts ?itemId for prefill
  /notes/[id]
  /notes/[id]/edit
  /settings               — HouseProfile editor (singleton pattern)
```

No middleware change. Auth gate is still layout-based.

## Forms, validation, Server Actions

Canonical pattern, applied per entity:

```
/lib/items/
  schema.ts       — Zod schemas (create + update; metadata-by-category lookup)
  queries.ts      — Server-only data fetchers (Prisma reads)
  actions.ts      — "use server" mutations (create, update, archive, restore, delete)
  types.ts        — TS types from Zod + Prisma payload helpers
```

### Server Action contract

Every action returns a discriminated union — never throws on validation:

```ts
export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; fieldErrors?: Record<string, string[]>; formError?: string };
```

Each action:

1. Calls `auth()`; returns `{ ok: false, formError: 'Unauthorized' }` if no session.
2. Parses input via the entity's Zod schema; returns flattened `fieldErrors` on failure.
3. For Item create/update: additionally validates `metadata` against `metadataSchemaFor(categorySlug)`.
4. Performs the Prisma mutation.
5. Calls `revalidatePath` for paths whose data changed.
6. Returns `{ ok: true, data }`.

### Form pattern

- One Client Component per "create" and "edit" path; both reuse a shared `<EntityFormFields>` Client Component.
- React Hook Form with `@hookform/resolvers/zod` for client-side validation matching the server schema.
- After action returns `ok: true`, redirect via `router.push(...)`.
- `fieldErrors` render inline next to inputs; `formError` renders at form top.

### Item form: dynamic metadata section

The Item form has two sections — a static **Basic** block (name, category, location, manufacturer, model, serial, purchase date/price, notes) and a dynamic **Metadata** block whose fields are determined by the selected category. Switching categories swaps the metadata section in place. The client reads `categoryMetadataSchemas[slug]` (or falls back to a freeform key/value editor) and renders accordingly.

### Authorization

Single-household model: any signed-in user can mutate anything. Per-item ACLs are explicitly out of v1. The `auth()` check in each action is the only gate; if granular ACLs are ever added, they go in the same place.

## Page UX

### `/dashboard`

Three lanes (side-by-side desktop, stacked mobile):

- **Recent activity**: last 10 mixed events (item created, service logged, note added, item archived/restored). Single Server Component issues four `prisma` queries in parallel, merges, sorts, and slices to 10. Each row: icon · short text · relative timestamp · link to source.
- **Quick stats**: counts of active items, vendors, this-year service records. Big-number presentation. Keeps the dashboard from looking empty.
- **Quick actions**: four buttons — "Add item", "Log service", "Add vendor", "Add note" — linking to the corresponding `/new` routes.

### `/items`

- Server Component fetches items with `category` and `_count: { warranties, serviceRecords }` joined.
- Filters live in URL search params: `?category=hvac,electrical&location=basement&archived=false&q=furnace&page=N&pageSize=50&view=table|cards&sort=name|createdAt`. Bookmarkable, sharable, AI-constructable later.
- A small Client Component reads `?view` (or localStorage default) and renders one of two presentational components: a sortable table or a card grid. Toggle persists to localStorage.
- Empty state with a primary "Add your first item" CTA.

### `/items/new` and `/items/[id]/edit`

- Server Component fetches Categories. Renders `<ItemForm>` (Client Component).
- Basic section + dynamic Metadata section as described above.

### `/items/[id]`

Tabbed layout. Single `prisma.item.findUnique({ include: { category, warranties, serviceRecords: { include: { vendor } }, itemNotes } })` call.

- **Overview** (default): all base fields, category badge, location, manufacturer/model/serial, purchase info, freeform `Item.notes` rendered as markdown. Edit + Archive (or Restore) buttons.
- **Warranties**: list sorted by `endsOn` desc with status badges (active / expiring soon ≤60d / expired). "Add Warranty" button.
- **Service**: list of ServiceRecords for this item, sorted by `performedOn` desc. Each row: date · vendor · cost · summary, click-through to detail. "Log Service" button (pre-fills `itemId`).
- **Notes**: list of Notes attached to this item. "Add Note" button (pre-fills `itemId`).

Tab state lives in URL: `?tab=service`. Browser back/forward works.

### `/vendors`, `/vendors/[id]`

- List page: name, kind, tag chips, last service date.
- Filters: kind, tag.
- Detail page: contact info, notes (markdown), and a list of ServiceRecords this vendor performed (across all items). "Log Service for this vendor" button (pre-fills `vendorId`).
- Edit + Delete (with confirmation). No archive.

### `/service`, `/service/new`, `/service/[id]`

- `/service` lists all ServiceRecords across the household. Filters: item (autocomplete), vendor (autocomplete), date range, q (free-text on `summary`).
- `/service/new` accepts `?itemId=...` and/or `?vendorId=...` query params for prefill. Both fields are autocompletes that allow inline create.
- Detail page: full record + edit/delete.

### `/notes`, `/notes/[id]`

- `/notes` lists all notes (item-attached + standalone), filterable by tag and item. Item-attached notes show a small "📎 Furnace" badge linking to the item.
- Detail page renders the body as markdown. Edit/delete buttons.

### `/settings`

- Form for `HouseProfile`: location (text), climate zone (text or dropdown of common zones — IECC/USDA), property type (single-family / townhome / condo / multi-family / other).
- Singleton: only one row ever. If absent, the form renders empty and creates on save; if present, prefills and updates.

### Common UI primitives

- `<EmptyState icon message action />` — used across list pages and tabs.
- `<Markdown>` — Server Component wrapping `react-markdown` + `remark-gfm` + `rehype-sanitize`. Used for `Item.notes`, `Vendor.notes`, `Warranty.coverage`, `ServiceRecord.notes`, and `Note.body`.
- `<DateRange>` — Client Component used by `/service` filtering.
- No design system / component library yet. Inline styles or a small `globals.css`. Plan 5 introduces a real design system.

## Migrations and seeding

- `prisma/seed.ts` (currently a no-op from Plan 1) becomes idempotent: `upsert` per Category row by `slug`. Seeds: Appliance, HVAC, Plumbing, Electrical, Exterior, Vehicle, Tool, Landscaping, Other.
- `pnpm db:seed` runs the seed locally.
- The compose `web` service `command:` is updated to run `pnpm db:deploy && pnpm db:seed && pnpm start`. The seed is idempotent so re-running on every deploy is safe.
- The `migrate-check` CI job from Plan 1 catches schema/migration drift.

## Testing

### Unit (Vitest)

- Zod schema tests per entity: valid input parses; invalid input has correct field errors.
- `categoryMetadataSchemas` lookup: known category enforces typed fields; unknown falls back to freeform record.
- URL search-param parsing helpers (filter + sort + pagination) round-trip correctly.

### Integration (Vitest + Testcontainers)

- One per entity: create → read → update → archive (or delete for Vendor/Note) → verify state.
- Cascade tests:
  - Archiving an Item leaves its ServiceRecords intact (`SetNull` + `archivedAt`).
  - Hard-deleting a Vendor sets `ServiceRecord.vendorId` to NULL.
  - Hard-deleting an Item cascades to its Warranties.
- Singleton HouseProfile: creates on first save, updates thereafter.

### E2E (Playwright)

- Happy path: sign in → add an item → add a service record → see it on `/dashboard` recent activity.
- The mocked-OIDC sign-in fixture from Plan 1 (`tests/e2e/signin.spec.ts`) is extracted to a shared helper `tests/e2e/auth.ts`.

### Not tested

- Server Component rendering output. Next.js's testing story for Server Components is still rough; integration tests cover the data shape and E2E covers user-visible behavior.

## Observability

- Each Server Action logs `pino` at info level on success: `{ action, userId, entityId, durationMs }`. Validation failures log at warn level without leaking input. Unhandled errors surface via the existing log pipeline.
- No new admin pages. The `/admin/jobs` view is Plan 5.

## Operational notes

- **Backups**: the existing `pg_dump` covers all new tables automatically. No script changes.
- **No new env vars**.
- **No new Compose services**.
- **Rollback**: standard `prisma migrate resolve --rolled-back` + manual SQL if needed. Schema changes are additive (no column drops or type changes), so rolling back is mostly cosmetic — application rollback to a prior image leaves the new tables in place harmlessly.

## Open questions / future work

- **Per-vendor archive**: deferred. If vendors accumulate enough state to warrant soft delete (unlikely at household scale), promote `Vendor.archivedAt`.
- **Tag normalization**: deferred. If autocomplete-from-existing-tags becomes valuable, derive a distinct list at query time or add a `tags` materialized view.
- **HouseProfile climate zone source**: starting with IECC as a free-text/dropdown. If AI Suggest needs structured input later, expand the enum.
- **Cmd-K palette, mobile bottom nav**: Plan 5.

## Appendix: critical user flows

1. **First-run Items setup**: sign in → empty `/dashboard` → "Add item" → fill in furnace details + select HVAC category → metadata fields render (BTU, fuel type) → save → land on `/items/[id]` → switch to Service tab → "Log Service" → fill in last tune-up date and vendor (autocomplete creates new if needed) → save.
2. **Logging a service after a visit**: dashboard "Log service" → form pre-empty → autocomplete item ("Furnace"), vendor ("Plumber Pete"), date today, summary "Annual tune-up", cost → save → record visible on dashboard recent activity, item's Service tab, and vendor's detail page.
3. **Archiving a replaced item**: open old fridge → Overview tab → "Archive" → confirm → item disappears from default `/items` list but remains in vendor service histories. Add new fridge as a fresh Item.
4. **Filtering for a specific item**: `/items?category=hvac&q=furnace` (URL constructed by hand or via the filter UI). Bookmarkable.
5. **Adding a Pool Equipment category** (no code-defined schema yet): `pnpm exec prisma studio` → insert Category row with slug "pool-equipment" → return to app → "Add item" → select Pool Equipment → metadata renders as freeform key/value editor → save.
