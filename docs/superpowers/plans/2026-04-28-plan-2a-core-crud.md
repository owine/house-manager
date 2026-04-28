# Plan 2a — Core CRUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the core entity CRUD (Items, Vendors, Warranties, ServiceRecords, Notes) plus dashboard activity feed and HouseProfile settings, on top of the Plan 1 foundation. End state: a household member can add their fridge, log a service visit, attach a vendor, write notes, and see recent activity on the dashboard.

**Architecture:** Single Prisma migration adds all 6 new tables (Category, Item, Vendor, Warranty, ServiceRecord, Note). Each entity gets a vertical slice (`lib/<entity>/{schema,queries,actions}.ts` + Server-Component pages under `app/(app)/<entity>/`). Server Actions return discriminated-union results; React Hook Form + Zod handles client validation. The Item detail page tabs are wired incrementally as ServiceRecord/Warranty/Note data sources land.

**Tech Stack:** Next.js 15 App Router, Prisma 7, Zod 4, React Hook Form, react-markdown + remark-gfm + rehype-sanitize, Vitest (unit + integration via Testcontainers), Playwright (E2E). All inherited from Plan 1.

**Spec:** `docs/superpowers/specs/2026-04-28-plan-2a-core-crud-design.md`

---

## File structure created or modified by this plan

```
prisma/
  schema.prisma                    — adds Category, Item, Vendor, Warranty, ServiceRecord, Note
  migrations/<timestamp>_core_crud/migration.sql   — auto-generated
  seed.ts                          — replaces no-op with idempotent Category upsert

lib/
  categories.ts                    — slugs, names, icons, per-category Zod metadata schemas
  markdown.tsx                     — <Markdown> Server Component (react-markdown + sanitizer)
  url-params.ts                    — parse/serialize filter+sort+pagination URL search params
  result.ts                        — ActionResult discriminated-union type

  vendors/
    schema.ts                      — Zod create/update schemas
    queries.ts                     — Prisma reads
    actions.ts                     — Server Actions
    schema.test.ts                 — Zod schema tests

  items/
    schema.ts
    queries.ts
    actions.ts
    schema.test.ts

  service-records/
    schema.ts
    queries.ts
    actions.ts
    schema.test.ts

  warranties/
    schema.ts
    queries.ts
    actions.ts
    schema.test.ts

  notes/
    schema.ts
    queries.ts
    actions.ts
    schema.test.ts

  house-profile/
    actions.ts                     — singleton get/save Server Action
    schema.ts

  dashboard/
    queries.ts                     — recent activity merged feed + quick stats

components/
  forms/
    FormField.tsx                  — <FormField label error>{children}</FormField> primitive
    SubmitButton.tsx               — useFormStatus-aware submit
    ErrorBanner.tsx                — top-of-form error
  vendors/
    VendorForm.tsx                 — Client Component, used by /new and /edit
    VendorTable.tsx                — Server Component
  items/
    ItemTable.tsx                  — Server Component
    ItemCardGrid.tsx               — Server Component
    ItemListView.tsx               — Client Component, table/cards toggle
    ItemForm.tsx                   — Client Component (basic + dynamic metadata)
    ItemMetadataFields.tsx         — Client Component, renders typed-or-freeform fields
    ItemTabs.tsx                   — Client Component for ?tab= state
    WarrantyStatusBadge.tsx        — small status chip (active/expiring/expired)
  service-records/
    ServiceRecordForm.tsx
    ServiceRecordTable.tsx
    ItemAutocomplete.tsx           — used in ServiceRecord form
    VendorAutocomplete.tsx         — used in ServiceRecord form
  warranties/
    WarrantyForm.tsx
    WarrantyTable.tsx
  notes/
    NoteForm.tsx
    NoteTable.tsx
    NoteEditor.tsx                 — markdown textarea + preview
  dashboard/
    RecentActivity.tsx
    QuickStats.tsx
    QuickActions.tsx
  EmptyState.tsx                   — shared <EmptyState> primitive

app/(app)/
  dashboard/page.tsx               — REPLACES Plan 1's "Hello, name"
  vendors/page.tsx                 — list
  vendors/new/page.tsx
  vendors/[id]/page.tsx            — detail
  vendors/[id]/edit/page.tsx
  items/page.tsx                   — list
  items/new/page.tsx
  items/[id]/page.tsx              — tabbed detail
  items/[id]/edit/page.tsx
  service/page.tsx                 — list
  service/new/page.tsx
  service/[id]/page.tsx
  service/[id]/edit/page.tsx
  notes/page.tsx
  notes/new/page.tsx
  notes/[id]/page.tsx
  notes/[id]/edit/page.tsx
  settings/page.tsx                — HouseProfile editor

tests/
  unit/lib/url-params.test.ts
  unit/lib/categories.test.ts
  integration/items.test.ts
  integration/vendors.test.ts
  integration/service-records.test.ts
  integration/warranties.test.ts
  integration/notes.test.ts
  integration/house-profile.test.ts
  e2e/auth.ts                      — extracted shared sign-in fixture
  e2e/signin.spec.ts               — refactored to use auth.ts
  e2e/happy-path.spec.ts           — new: sign in → add item → log service → see on dashboard
```

---

## Task 1: Schema migration + idempotent Category seed

**Files:**
- Modify: `prisma/schema.prisma` — append the six new models
- Create: `prisma/migrations/<timestamp>_core_crud/migration.sql` (generated)
- Modify: `prisma/seed.ts` — replace no-op with Category upserts

- [ ] **Step 1: Add the new models to `prisma/schema.prisma`**

Append after the existing models (User, HouseProfile, Account, Session, VerificationToken):

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

- [ ] **Step 2: Bring up Postgres + Meilisearch and create the migration**

```bash
docker compose up -d db meilisearch
sleep 5
set -a && source .env && set +a
pnpm db:migrate -- --name core_crud
```

Expected: a new directory `prisma/migrations/<timestamp>_core_crud/` containing `migration.sql`.

- [ ] **Step 3: Replace `prisma/seed.ts` with idempotent Category seed**

```ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CATEGORIES = [
  { slug: 'appliance', name: 'Appliance', icon: 'washing-machine', sortOrder: 10 },
  { slug: 'hvac', name: 'HVAC', icon: 'thermometer', sortOrder: 20 },
  { slug: 'plumbing', name: 'Plumbing', icon: 'droplet', sortOrder: 30 },
  { slug: 'electrical', name: 'Electrical', icon: 'zap', sortOrder: 40 },
  { slug: 'exterior', name: 'Exterior', icon: 'home', sortOrder: 50 },
  { slug: 'vehicle', name: 'Vehicle', icon: 'car', sortOrder: 60 },
  { slug: 'tool', name: 'Tool', icon: 'wrench', sortOrder: 70 },
  { slug: 'landscaping', name: 'Landscaping', icon: 'leaf', sortOrder: 80 },
  { slug: 'other', name: 'Other', icon: 'box', sortOrder: 99 },
];

async function main() {
  for (const c of CATEGORIES) {
    await prisma.category.upsert({
      where: { slug: c.slug },
      create: c,
      update: { name: c.name, icon: c.icon, sortOrder: c.sortOrder },
    });
  }
  console.log(`Seeded ${CATEGORIES.length} categories.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 4: Run the seed and verify**

```bash
pnpm db:seed
docker compose exec -T db psql -U housemanager -d housemanager -c "SELECT slug, name FROM categories ORDER BY \"sortOrder\";"
```

Expected: 9 rows. Re-run `pnpm db:seed` once more — should succeed without changing anything (idempotent).

- [ ] **Step 5: Update Compose web service to seed on startup**

In `docker-compose.yml`, change the `web` service `command:` from:

```yaml
    command: sh -c "pnpm db:deploy && pnpm start"
```

to:

```yaml
    command: sh -c "pnpm db:deploy && pnpm db:seed && pnpm start"
```

- [ ] **Step 6: Verify lint/typecheck/tests still pass**

```bash
pnpm db:generate
pnpm verify
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add core CRUD schema and seed Categories"
```

---

## Task 2: Shared primitives — Markdown, ActionResult, URL params, form components

**Files:**
- Create: `lib/result.ts`, `lib/url-params.ts`, `lib/markdown.tsx`
- Create: `components/EmptyState.tsx`, `components/forms/FormField.tsx`, `components/forms/SubmitButton.tsx`, `components/forms/ErrorBanner.tsx`
- Create: `tests/unit/lib/url-params.test.ts`

- [ ] **Step 1: Install markdown deps and react-hook-form**

```bash
pnpm add react-markdown remark-gfm rehype-sanitize react-hook-form
pnpm add @hookform/resolvers
```

- [ ] **Step 2: Create `lib/result.ts`**

```ts
export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; fieldErrors?: Record<string, string[]>; formError?: string };
```

- [ ] **Step 3: Create `lib/markdown.tsx`**

```tsx
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 4: Write the failing test for `lib/url-params.ts`**

`tests/unit/lib/url-params.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseListParams, serializeListParams } from '@/lib/url-params';

describe('parseListParams', () => {
  it('parses defaults from empty search params', () => {
    const result = parseListParams(new URLSearchParams(''));
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(50);
    expect(result.sort).toBeUndefined();
    expect(result.q).toBeUndefined();
    expect(result.filters).toEqual({});
  });

  it('parses pagination, sort, q, and arbitrary filters', () => {
    const sp = new URLSearchParams(
      'page=3&pageSize=25&sort=createdAt&q=furnace&category=hvac,electrical&location=basement',
    );
    const result = parseListParams(sp);
    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(25);
    expect(result.sort).toBe('createdAt');
    expect(result.q).toBe('furnace');
    expect(result.filters.category).toEqual(['hvac', 'electrical']);
    expect(result.filters.location).toEqual(['basement']);
  });

  it('clamps invalid pagination values to safe defaults', () => {
    const sp = new URLSearchParams('page=-1&pageSize=99999');
    const result = parseListParams(sp);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(200);
  });
});

describe('serializeListParams', () => {
  it('round-trips through parse', () => {
    const original = {
      page: 2,
      pageSize: 25,
      sort: 'name' as const,
      q: 'fridge',
      filters: { category: ['appliance'], location: ['kitchen'] },
    };
    const sp = serializeListParams(original);
    const parsed = parseListParams(new URLSearchParams(sp));
    expect(parsed).toEqual(original);
  });

  it('omits defaults', () => {
    const sp = serializeListParams({ page: 1, pageSize: 50, filters: {} });
    expect(sp).toBe('');
  });
});
```

- [ ] **Step 5: Run the test — expect failure**

```bash
pnpm test:unit
```

Expected: failure on import of `@/lib/url-params`.

- [ ] **Step 6: Implement `lib/url-params.ts`**

```ts
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const RESERVED_KEYS = new Set(['page', 'pageSize', 'sort', 'q', 'view', 'tab']);

export type ListParams = {
  page: number;
  pageSize: number;
  sort?: string;
  q?: string;
  filters: Record<string, string[]>;
};

export function parseListParams(sp: URLSearchParams): ListParams {
  const rawPage = Number.parseInt(sp.get('page') ?? '1', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;

  const rawPageSize = Number.parseInt(sp.get('pageSize') ?? String(DEFAULT_PAGE_SIZE), 10);
  const pageSize =
    Number.isFinite(rawPageSize) && rawPageSize >= 1
      ? Math.min(rawPageSize, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

  const sort = sp.get('sort') ?? undefined;
  const q = sp.get('q') ?? undefined;

  const filters: Record<string, string[]> = {};
  for (const [key, value] of sp.entries()) {
    if (RESERVED_KEYS.has(key)) continue;
    filters[key] = value.split(',').filter(Boolean);
  }

  return { page, pageSize, sort, q, filters };
}

export function serializeListParams(params: Partial<ListParams>): string {
  const sp = new URLSearchParams();
  if (params.page && params.page !== 1) sp.set('page', String(params.page));
  if (params.pageSize && params.pageSize !== DEFAULT_PAGE_SIZE) sp.set('pageSize', String(params.pageSize));
  if (params.sort) sp.set('sort', params.sort);
  if (params.q) sp.set('q', params.q);
  if (params.filters) {
    for (const [key, values] of Object.entries(params.filters)) {
      if (values.length > 0) sp.set(key, values.join(','));
    }
  }
  return sp.toString();
}
```

- [ ] **Step 7: Run tests — expect 7 passing (4 existing + 3 new)**

```bash
pnpm test:unit
```

- [ ] **Step 8: Create the form/layout primitive components**

`components/EmptyState.tsx`:
```tsx
type Props = {
  icon?: React.ReactNode;
  message: string;
  action?: React.ReactNode;
};

export function EmptyState({ icon, message, action }: Props) {
  return (
    <div style={{ padding: '3rem', textAlign: 'center', color: '#666' }}>
      {icon && <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>{icon}</div>}
      <p>{message}</p>
      {action && <div style={{ marginTop: '1rem' }}>{action}</div>}
    </div>
  );
}
```

`components/forms/FormField.tsx`:
```tsx
type Props = {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
};

export function FormField({ label, htmlFor, error, hint, children }: Props) {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <label htmlFor={htmlFor} style={{ display: 'block', fontWeight: 500, marginBottom: '0.25rem' }}>
        {label}
      </label>
      {children}
      {hint && !error && <p style={{ fontSize: '0.85rem', color: '#666', marginTop: '0.25rem' }}>{hint}</p>}
      {error && <p style={{ fontSize: '0.85rem', color: '#c00', marginTop: '0.25rem' }}>{error}</p>}
    </div>
  );
}
```

`components/forms/SubmitButton.tsx`:
```tsx
'use client';
import { useFormStatus } from 'react-dom';

export function SubmitButton({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} style={{ padding: '0.5rem 1rem' }}>
      {pending ? 'Saving…' : children}
    </button>
  );
}
```

`components/forms/ErrorBanner.tsx`:
```tsx
export function ErrorBanner({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div role="alert" style={{ padding: '0.75rem 1rem', background: '#fee', border: '1px solid #fbb', borderRadius: '4px', marginBottom: '1rem' }}>
      {message}
    </div>
  );
}
```

- [ ] **Step 9: Verify and commit**

```bash
pnpm verify
git add -A
git commit -m "feat: add shared form, layout, and url-param primitives"
```

---

## Task 3: Category metadata schemas

**Files:**
- Create: `lib/categories.ts`, `tests/unit/lib/categories.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/unit/lib/categories.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { categoryMetadataSchemas, metadataSchemaFor } from '@/lib/categories';

describe('categoryMetadataSchemas', () => {
  it('defines schemas for known categories', () => {
    expect(categoryMetadataSchemas.appliance).toBeDefined();
    expect(categoryMetadataSchemas.vehicle).toBeDefined();
    expect(categoryMetadataSchemas.hvac).toBeDefined();
  });
});

describe('metadataSchemaFor', () => {
  it('returns the typed schema for a known category', () => {
    const schema = metadataSchemaFor('vehicle');
    const parsed = schema.safeParse({ vin: '1HGBH41JXMN109186', licensePlate: 'ABC123' });
    expect(parsed.success).toBe(true);
  });

  it('rejects invalid typed metadata', () => {
    const schema = metadataSchemaFor('vehicle');
    const parsed = schema.safeParse({ vin: 'too-short' });
    expect(parsed.success).toBe(false);
  });

  it('falls back to a freeform record schema for unknown categories', () => {
    const schema = metadataSchemaFor('pool-equipment');
    const parsed = schema.safeParse({ gallons: 10000, chemical: 'chlorine' });
    expect(parsed.success).toBe(true);
  });

  it('freeform fallback rejects deeply-nested values', () => {
    const schema = metadataSchemaFor('pool-equipment');
    const parsed = schema.safeParse({ nested: { obj: 'value' } });
    expect(parsed.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect failure; then implement `lib/categories.ts`:**

```ts
import { z } from 'zod';

const freeformMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

export const categoryMetadataSchemas: Record<string, z.ZodTypeAny> = {
  appliance: z.object({
    btu: z.number().nonnegative().optional(),
    capacity: z.string().optional(),
    fuelType: z.enum(['electric', 'gas', 'propane', 'oil']).optional(),
  }),
  hvac: z.object({
    btu: z.number().nonnegative().optional(),
    seer: z.number().positive().optional(),
    fuelType: z.enum(['electric', 'gas', 'propane', 'oil', 'heat-pump']).optional(),
    filterSize: z.string().optional(),
  }),
  plumbing: z.object({
    capacityGallons: z.number().nonnegative().optional(),
    fuelType: z.enum(['electric', 'gas']).optional(),
  }),
  electrical: z.object({
    panelBrand: z.string().optional(),
    amps: z.number().positive().optional(),
  }),
  exterior: z.object({
    material: z.string().optional(),
    squareFootage: z.number().nonnegative().optional(),
  }),
  vehicle: z.object({
    vin: z.string().length(17).optional(),
    licensePlate: z.string().optional(),
    mileage: z.number().nonnegative().optional(),
    fuelType: z.enum(['gasoline', 'diesel', 'electric', 'hybrid']).optional(),
  }),
  tool: z.object({
    powerSource: z.enum(['battery', 'corded', 'gas', 'manual']).optional(),
    voltage: z.number().positive().optional(),
  }),
  landscaping: z.object({
    type: z.string().optional(),
    coverageArea: z.string().optional(),
  }),
  other: freeformMetadataSchema,
};

export function metadataSchemaFor(slug: string): z.ZodTypeAny {
  return categoryMetadataSchemas[slug] ?? freeformMetadataSchema;
}
```

- [ ] **Step 3: Run tests — expect 11 passing total**; verify; commit:

```bash
pnpm verify
git add -A
git commit -m "feat: add per-category Zod metadata schemas"
```

---

## Task 4: Vendors — schema, queries, actions, integration tests

**Files:**
- Create: `lib/vendors/{schema,queries,actions,schema.test}.ts`
- Create: `tests/integration/vendors.test.ts`
- Create: `tests/integration/helpers.ts` — shared helper for spinning up Postgres + applying migrations (extracted now to avoid repetition across entities)

- [ ] **Step 1: Create `tests/integration/helpers.ts`** (shared by all entity integration tests)

```ts
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { startStack, stopStack, type TestStack } from './setup';

export type IntegrationContext = { stack: TestStack; prisma: PrismaClient };

export async function setupIntegration(): Promise<IntegrationContext> {
  const stack = await startStack();
  process.env.DATABASE_URL = stack.databaseUrl;
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: stack.databaseUrl },
    stdio: 'inherit',
  });
  const prisma = new PrismaClient({ datasourceUrl: stack.databaseUrl });
  return { stack, prisma };
}

export async function teardownIntegration(ctx: IntegrationContext) {
  await ctx.prisma.$disconnect();
  await stopStack(ctx.stack);
}
```

> **Why `execFileSync` not `execSync`**: avoids shell parsing entirely. Arguments are passed as an array, no shell interpretation, no injection surface. The codebase's security hook flags `execSync` for this reason.

- [ ] **Step 2: Write Vendor schema tests** (`lib/vendors/schema.test.ts` — see prior version of this plan for the test cases). Implement `schema.ts`:

```ts
import { z } from 'zod';

export const createVendorSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  kind: z.string().max(100).optional(),
  phone: z.string().max(50).optional(),
  email: z.string().email().optional().or(z.literal('')),
  website: z.string().url().optional().or(z.literal('')),
  address: z.string().max(500).optional(),
  notes: z.string().max(20_000).optional(),
  tags: z.array(z.string().min(1).max(50)).default([]),
});

export const updateVendorSchema = createVendorSchema.partial().extend({ id: z.string().min(1) });

export type CreateVendorInput = z.infer<typeof createVendorSchema>;
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;
```

- [ ] **Step 3: Implement `lib/vendors/queries.ts`**

```ts
import { prisma } from '@/lib/db';
import type { ListParams } from '@/lib/url-params';

export async function listVendors(params: ListParams) {
  const where = {
    AND: [
      params.q
        ? { OR: [
            { name: { contains: params.q, mode: 'insensitive' as const } },
            { kind: { contains: params.q, mode: 'insensitive' as const } },
          ] }
        : {},
      params.filters.kind?.length ? { kind: { in: params.filters.kind } } : {},
      params.filters.tag?.length ? { tags: { hasSome: params.filters.tag } } : {},
    ],
  };

  const [vendors, total] = await Promise.all([
    prisma.vendor.findMany({
      where,
      orderBy: { name: 'asc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      include: { _count: { select: { serviceRecords: true } } },
    }),
    prisma.vendor.count({ where }),
  ]);

  return { vendors, total };
}

export async function getVendor(id: string) {
  return prisma.vendor.findUnique({
    where: { id },
    include: {
      serviceRecords: {
        orderBy: { performedOn: 'desc' },
        include: { item: { select: { id: true, name: true } } },
        take: 50,
      },
    },
  });
}

export async function listAllVendorKinds() {
  const result = await prisma.vendor.findMany({
    select: { kind: true },
    where: { kind: { not: null } },
    distinct: ['kind'],
  });
  return result.map((r) => r.kind!).sort();
}
```

- [ ] **Step 4: Implement `lib/vendors/actions.ts`**

```ts
'use server';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import type { ActionResult } from '@/lib/result';
import { createVendorSchema, updateVendorSchema } from './schema';

function emptyToUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v === '' ? undefined : v;
  return out as T;
}

export async function createVendor(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = createVendorSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]> };
  }

  const vendor = await prisma.vendor.create({ data: emptyToUndefined(parsed.data) });
  revalidatePath('/vendors');
  return { ok: true, data: { id: vendor.id } };
}

export async function updateVendor(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = updateVendorSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]> };
  }

  const { id, ...rest } = parsed.data;
  await prisma.vendor.update({ where: { id }, data: emptyToUndefined(rest) });

  revalidatePath('/vendors');
  revalidatePath(`/vendors/${id}`);
  return { ok: true, data: { id } };
}

export async function deleteVendor(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  await prisma.vendor.delete({ where: { id } });
  revalidatePath('/vendors');
  return { ok: true, data: undefined };
}
```

- [ ] **Step 5: Write `tests/integration/vendors.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupIntegration, teardownIntegration, type IntegrationContext } from './helpers';

let ctx: IntegrationContext;

beforeAll(async () => { ctx = await setupIntegration(); }, 180_000);
afterAll(async () => { await teardownIntegration(ctx); });

beforeEach(async () => {
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.vendor.deleteMany();
});

describe('Vendor CRUD', () => {
  it('creates and reads a vendor', async () => {
    const v = await ctx.prisma.vendor.create({
      data: { name: 'Plumber Pete', kind: 'plumber', tags: ['emergency'] },
    });
    const read = await ctx.prisma.vendor.findUnique({ where: { id: v.id } });
    expect(read?.name).toBe('Plumber Pete');
    expect(read?.tags).toEqual(['emergency']);
  });

  it('updates a vendor', async () => {
    const v = await ctx.prisma.vendor.create({ data: { name: 'Original' } });
    await ctx.prisma.vendor.update({ where: { id: v.id }, data: { name: 'Updated' } });
    const read = await ctx.prisma.vendor.findUnique({ where: { id: v.id } });
    expect(read?.name).toBe('Updated');
  });

  it('hard-deletes vendor and SetNulls related ServiceRecord.vendorId', async () => {
    const v = await ctx.prisma.vendor.create({ data: { name: 'Doomed' } });
    const sr = await ctx.prisma.serviceRecord.create({
      data: { vendorId: v.id, performedOn: new Date(), summary: 'tune-up' },
    });
    await ctx.prisma.vendor.delete({ where: { id: v.id } });
    const orphaned = await ctx.prisma.serviceRecord.findUnique({ where: { id: sr.id } });
    expect(orphaned).not.toBeNull();
    expect(orphaned?.vendorId).toBeNull();
  });
});
```

- [ ] **Step 6: Run integration tests**

```bash
pnpm test:integration
```

Expected: 3 new + 2 from health = 5 passing.

- [ ] **Step 7: Verify and commit**

```bash
pnpm verify
git add -A
git commit -m "feat(vendors): add schema, queries, actions, and integration tests"
```

---

## Task 5: Vendors — list, detail, new, edit pages

**Files:**
- Create: `components/vendors/VendorForm.tsx`, `VendorTable.tsx`
- Create: `app/(app)/vendors/{page,new/page,[id]/page,[id]/edit/page}.tsx`

- [ ] **Step 1: Implement `components/vendors/VendorTable.tsx`** (Server Component)

```tsx
import Link from 'next/link';
import type { Vendor } from '@prisma/client';

type VendorWithCount = Vendor & { _count: { serviceRecords: number } };

export function VendorTable({ vendors }: { vendors: VendorWithCount[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ borderBottom: '1px solid #ddd', textAlign: 'left' }}>
          <th style={{ padding: '0.5rem' }}>Name</th>
          <th style={{ padding: '0.5rem' }}>Kind</th>
          <th style={{ padding: '0.5rem' }}>Tags</th>
          <th style={{ padding: '0.5rem' }}>Service records</th>
        </tr>
      </thead>
      <tbody>
        {vendors.map((v) => (
          <tr key={v.id} style={{ borderBottom: '1px solid #eee' }}>
            <td style={{ padding: '0.5rem' }}>
              <Link href={`/vendors/${v.id}`}>{v.name}</Link>
            </td>
            <td style={{ padding: '0.5rem' }}>{v.kind ?? '—'}</td>
            <td style={{ padding: '0.5rem' }}>
              {v.tags.map((t) => (
                <span key={t} style={{ padding: '0.1rem 0.4rem', background: '#eee', borderRadius: '4px', marginRight: '0.25rem', fontSize: '0.85rem' }}>
                  {t}
                </span>
              ))}
            </td>
            <td style={{ padding: '0.5rem' }}>{v._count.serviceRecords}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 2: Implement `components/vendors/VendorForm.tsx`** (Client Component, RHF + Zod resolver)

```tsx
'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { Controller, useForm } from 'react-hook-form';
import { useTransition } from 'react';
import { ErrorBanner } from '@/components/forms/ErrorBanner';
import { FormField } from '@/components/forms/FormField';
import { SubmitButton } from '@/components/forms/SubmitButton';
import { createVendorSchema, type CreateVendorInput } from '@/lib/vendors/schema';
import type { ActionResult } from '@/lib/result';

type Props = {
  defaultValues?: Partial<CreateVendorInput & { id: string }>;
  action: (input: CreateVendorInput | (CreateVendorInput & { id: string })) => Promise<ActionResult<{ id: string }>>;
  submitLabel: string;
};

export function VendorForm({ defaultValues, action, submitLabel }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { register, control, handleSubmit, setError, formState: { errors } } = useForm<CreateVendorInput>({
    resolver: zodResolver(createVendorSchema),
    defaultValues: { tags: [], ...defaultValues },
  });
  const formError = (errors.root as { message?: string } | undefined)?.message;

  const onSubmit = handleSubmit((data) => {
    startTransition(async () => {
      const payload = defaultValues?.id ? { ...data, id: defaultValues.id } : data;
      const result = await action(payload as CreateVendorInput);
      if (!result.ok) {
        if (result.formError) setError('root', { message: result.formError });
        if (result.fieldErrors) {
          for (const [field, msgs] of Object.entries(result.fieldErrors)) {
            setError(field as keyof CreateVendorInput, { message: msgs?.[0] });
          }
        }
        return;
      }
      router.push(`/vendors/${result.data.id}`);
    });
  });

  return (
    <form onSubmit={onSubmit} style={{ maxWidth: 600 }}>
      <ErrorBanner message={formError} />
      <FormField label="Name" htmlFor="name" error={errors.name?.message}>
        <input id="name" {...register('name')} required />
      </FormField>
      <FormField label="Kind" htmlFor="kind" error={errors.kind?.message} hint="e.g. plumber, hvac tech">
        <input id="kind" {...register('kind')} />
      </FormField>
      <FormField label="Phone" htmlFor="phone" error={errors.phone?.message}>
        <input id="phone" {...register('phone')} />
      </FormField>
      <FormField label="Email" htmlFor="email" error={errors.email?.message}>
        <input id="email" type="email" {...register('email')} />
      </FormField>
      <FormField label="Website" htmlFor="website" error={errors.website?.message}>
        <input id="website" type="url" {...register('website')} />
      </FormField>
      <FormField label="Address" htmlFor="address" error={errors.address?.message}>
        <input id="address" {...register('address')} />
      </FormField>
      <FormField label="Notes (markdown)" htmlFor="notes" error={errors.notes?.message}>
        <textarea id="notes" rows={6} {...register('notes')} />
      </FormField>
      <FormField label="Tags (comma-separated)" htmlFor="tags" error={errors.tags?.message}>
        <Controller
          control={control}
          name="tags"
          render={({ field }) => (
            <input
              id="tags"
              defaultValue={(field.value ?? []).join(', ')}
              onChange={(e) => field.onChange(e.target.value.split(',').map((t) => t.trim()).filter(Boolean))}
            />
          )}
        />
      </FormField>
      <SubmitButton>{pending ? 'Saving…' : submitLabel}</SubmitButton>
    </form>
  );
}
```

- [ ] **Step 3: Create `app/(app)/vendors/page.tsx`**, `new/page.tsx`, `[id]/page.tsx`, `[id]/edit/page.tsx`

(Reference: each one is a Server Component fetching via the queries module. Use the same pattern shown in the spec's UX section. Pre-fill the edit form from `getVendor(id)`.)

- [ ] **Step 4: Verify, build, commit**

```bash
pnpm verify
pnpm build
git add -A
git commit -m "feat(vendors): add list, detail, new, and edit pages"
```

---

## Task 6: Items — schema, queries, actions, integration tests

**Files:**
- Create: `lib/items/{schema,queries,actions,schema.test}.ts`
- Create: `tests/integration/items.test.ts`

- [ ] **Step 1: Implement `lib/items/schema.ts`**

```ts
import { z } from 'zod';

export const createItemSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  categorySlug: z.string().min(1, 'Category is required'),
  location: z.string().max(200).optional(),
  manufacturer: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  serialNumber: z.string().max(200).optional(),
  purchaseDate: z.coerce.date().optional(),
  purchasePrice: z.coerce.number().nonnegative().optional(),
  metadata: z.unknown().default({}),
  notes: z.string().max(20_000).optional(),
});

export const updateItemSchema = createItemSchema.partial().extend({ id: z.string().min(1) });

export type CreateItemInput = z.infer<typeof createItemSchema>;
export type UpdateItemInput = z.infer<typeof updateItemSchema>;
```

- [ ] **Step 2: Schema tests** (`lib/items/schema.test.ts`)

Cases: minimal valid input; missing name → fail; missing categorySlug → fail; coerces purchaseDate from ISO string to Date; coerces purchasePrice from string to number; updateItemSchema requires id.

- [ ] **Step 3: Implement `lib/items/queries.ts`**

(Follow the vendors pattern. Filter by `archivedAt: null` unless `archived=true` filter is set. Sort by `name` asc by default, `createdAt` desc when `sort=createdAt`. Include `category` and `_count` of children.)

```ts
import { prisma } from '@/lib/db';
import type { ListParams } from '@/lib/url-params';

export async function listItems(params: ListParams) {
  const includeArchived = params.filters.archived?.includes('true') ?? false;
  const where = {
    AND: [
      includeArchived ? {} : { archivedAt: null },
      params.q ? {
        OR: [
          { name: { contains: params.q, mode: 'insensitive' as const } },
          { manufacturer: { contains: params.q, mode: 'insensitive' as const } },
          { model: { contains: params.q, mode: 'insensitive' as const } },
        ],
      } : {},
      params.filters.category?.length ? { category: { slug: { in: params.filters.category } } } : {},
      params.filters.location?.length ? { location: { in: params.filters.location } } : {},
    ],
  };
  const orderBy = params.sort === 'createdAt' ? { createdAt: 'desc' as const } : { name: 'asc' as const };

  const [items, total] = await Promise.all([
    prisma.item.findMany({
      where, orderBy,
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      include: { category: true, _count: { select: { warranties: true, serviceRecords: true, itemNotes: true } } },
    }),
    prisma.item.count({ where }),
  ]);
  return { items, total };
}

export async function getItem(id: string) {
  return prisma.item.findUnique({
    where: { id },
    include: {
      category: true,
      warranties: { orderBy: { endsOn: 'desc' } },
      serviceRecords: {
        orderBy: { performedOn: 'desc' },
        include: { vendor: { select: { id: true, name: true } } },
      },
      itemNotes: { orderBy: { updatedAt: 'desc' } },
    },
  });
}

export async function listAllCategories() {
  return prisma.category.findMany({ orderBy: { sortOrder: 'asc' } });
}
```

- [ ] **Step 4: Implement `lib/items/actions.ts`**

(Follows the vendor pattern, with the addition of metadata validation via `metadataSchemaFor(categorySlug)` and category lookup by slug. Include `archiveItem(id)` and `restoreItem(id)` as separate actions.)

- [ ] **Step 5: Write `tests/integration/items.test.ts`** using `setupIntegration` / `teardownIntegration` helper

Cover:
- Create with metadata round-trips.
- `archivedAt` set/cleared via update.
- Hard-delete cascade: Warranty disappears with Item.
- Hard-delete SetNull: ServiceRecord.itemId becomes null when Item is deleted.

- [ ] **Step 6: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "feat(items): add schema, queries, actions, and integration tests"
```

---

## Task 7: Items — list page with table/cards toggle

**Files:**
- Create: `components/items/{ItemTable,ItemCardGrid,ItemListView}.tsx`
- Create: `app/(app)/items/page.tsx`

(Implementation per the design spec. ItemListView is a Client Component reading `?view=` and falling back to localStorage and viewport. Filters stay as a simple `<form method="get">` for v1.)

- [ ] Verify, commit:
```bash
pnpm verify
pnpm build
git add -A
git commit -m "feat(items): add list page with table/cards toggle"
```

---

## Task 8: Items — new and edit forms with dynamic metadata

**Files:**
- Create: `components/items/{ItemMetadataFields,ItemForm}.tsx`
- Create: `app/(app)/items/new/page.tsx`, `app/(app)/items/[id]/edit/page.tsx`

The metadata renderer reads the schema from `categoryMetadataSchemas[slug]` and renders one labeled input per shape key. Unknown categories get a JSON textarea with `setValueAs: JSON.parse`.

- [ ] Verify, commit:
```bash
pnpm verify
git add -A
git commit -m "feat(items): add new and edit forms with dynamic metadata"
```

---

## Task 9: Items — detail page with tabs (Overview only; tabs scaffolded)

**Files:**
- Create: `components/items/ItemTabs.tsx`
- Create: `app/(app)/items/[id]/page.tsx`

The detail page reads `?tab=overview|warranties|service|notes` (default overview). The Server Component fetches once via `getItem(id)`, then conditionally renders the active tab's contents. The other three tabs are placeholder components for now ("Warranties tab is wired up in a later task.").

- [ ] Verify, commit:
```bash
pnpm verify
git add -A
git commit -m "feat(items): add tabbed detail page with Overview tab"
```

---

## Task 10: ServiceRecords — full vertical

**Files:**
- Create: `lib/service-records/{schema,queries,actions,schema.test}.ts`
- Create: `components/service-records/{ServiceRecordForm,ServiceRecordTable,ItemAutocomplete,VendorAutocomplete}.tsx`
- Create: `app/(app)/service/{page,new/page,[id]/page,[id]/edit/page}.tsx`
- Create: `tests/integration/service-records.test.ts`

### Schema

`createServiceRecordSchema`: `itemId?`, `vendorId?`, `performedOn` (coerced date), `cost` (coerced number, optional), `summary` (required, max 200), `notes` (markdown, optional).

### Autocompletes

For v1, the Item and Vendor autocompletes are simple `<datalist>`-backed inputs. The page fetches the full item/vendor list at render time (household scale is small) and passes it to the form. A debounced server-search version is a Plan 5 polish.

### Form

Accepts `?itemId=` and `?vendorId=` query params for prefill (used by the per-item and per-vendor "Log service" buttons).

### Pages

- `/service` — list with filters (item, vendor, date range, q on summary).
- `/service/new` — form with optional prefilled item/vendor.
- `/service/[id]` — read view with edit/delete buttons.
- `/service/[id]/edit` — edit form.

### Actions

`createServiceRecord`, `updateServiceRecord`, `deleteServiceRecord`. Revalidate `/service`, `/dashboard`, and any related `/items/[itemId]` and `/vendors/[vendorId]` paths.

### Tests

Integration test covers CRUD plus the "creates without item or vendor" case (both nullable).

- [ ] Verify, commit:
```bash
pnpm verify
git add -A
git commit -m "feat(service): add full vertical (schema, queries, actions, pages, tests)"
```

---

## Task 11: Items detail — wire Service tab to real data

**Files:**
- Modify: `app/(app)/items/[id]/page.tsx`

Replace `ServiceTabPlaceholder` with a real component that reads `item.serviceRecords` and renders rows with date, summary, vendor, cost. Include "+ Log service" link to `/service/new?itemId=${item.id}`.

- [ ] Verify, commit:
```bash
pnpm verify
git add -A
git commit -m "feat(items): wire Service tab to real ServiceRecord data"
```

---

## Task 12: Warranties — full vertical

**Files:**
- Create: `lib/warranties/{schema,queries,actions,schema.test}.ts`
- Create: `components/warranties/{WarrantyForm,WarrantyTable,WarrantyStatusBadge}.tsx`
- Create: `app/(app)/items/[id]/warranties/new/page.tsx` (no top-level `/warranties` listing — they live on the Item detail tab)
- Create: `tests/integration/warranties.test.ts`

`WarrantyStatusBadge` computes status from `endsOn`:

```tsx
export function WarrantyStatusBadge({ endsOn }: { endsOn: Date }) {
  const days = (endsOn.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (days < 0) return <span style={{ color: '#999' }}>expired</span>;
  if (days < 60) return <span style={{ color: '#c80' }}>expiring soon</span>;
  return <span style={{ color: '#080' }}>active</span>;
}
```

Actions: `createWarranty`, `updateWarranty`, `deleteWarranty`. The form is reachable from the Item detail's Warranties tab via "+ Add warranty".

- [ ] Verify, commit:
```bash
pnpm verify
git add -A
git commit -m "feat(warranties): add schema, queries, actions, form, and tests"
```

---

## Task 13: Items detail — wire Warranties tab

Replace `WarrantiesTabPlaceholder` with a real component reading `item.warranties` and rendering each with a `WarrantyStatusBadge`.

- [ ] Verify, commit:
```bash
pnpm verify
git add -A
git commit -m "feat(items): wire Warranties tab to real data"
```

---

## Task 14: Notes — full vertical

**Files:**
- Create: `lib/notes/{schema,queries,actions,schema.test}.ts`
- Create: `components/notes/{NoteForm,NoteTable,NoteEditor}.tsx`
- Create: `app/(app)/notes/{page,new/page,[id]/page,[id]/edit/page}.tsx`
- Create: `tests/integration/notes.test.ts`

`NoteEditor` is a Client Component with a markdown textarea + live preview using the `<Markdown>` primitive. The `/notes` list shows item-attached notes with a "📎 ItemName" badge linking to the item.

`/notes/new` accepts `?itemId=` for prefill (used by the item detail Notes tab).

Note: actions revalidate `/notes`, `/dashboard`, and optionally `/items/[itemId]` if attached.

- [ ] Verify, commit:
```bash
pnpm verify
git add -A
git commit -m "feat(notes): add schema, queries, actions, pages, and tests"
```

---

## Task 15: Items detail — wire Notes tab

Replace `NotesTabPlaceholder` with a real component reading `item.itemNotes`.

- [ ] Verify, commit:
```bash
pnpm verify
git add -A
git commit -m "feat(items): wire Notes tab to real data"
```

---

## Task 16: Settings — HouseProfile editor

**Files:**
- Create: `lib/house-profile/{schema,actions}.ts`
- Create: `app/(app)/settings/page.tsx`
- Create: `tests/integration/house-profile.test.ts`

### Schema

```ts
import { z } from 'zod';

export const houseProfileSchema = z.object({
  location: z.string().max(200).optional().or(z.literal('')),
  climateZone: z.string().max(50).optional().or(z.literal('')),
  propertyType: z.enum(['single-family', 'townhome', 'condo', 'multi-family', 'other']).optional(),
});

export type HouseProfileInput = z.infer<typeof houseProfileSchema>;
```

### Actions

`saveHouseProfile(input)`: singleton — `findFirst()` then `update` if exists else `create`. `getHouseProfile()` returns the row or null.

### Page

Form prefilled from `getHouseProfile()`. On submit, calls `saveHouseProfile`. Three fields: location (text), climateZone (text or `<datalist>` of common IECC zones), propertyType (`<select>`).

### Test

Integration test verifies create-on-first-save and update-on-second-save behavior.

- [ ] Verify, commit:
```bash
pnpm verify
git add -A
git commit -m "feat(settings): add HouseProfile editor with singleton save action"
```

---

## Task 17: Dashboard rebuild

**Files:**
- Create: `lib/dashboard/queries.ts`
- Modify: `app/(app)/dashboard/page.tsx` (REPLACES Plan 1's "Hello, name")

### Queries

`recentActivity(limit = 10)`: parallel-fetches recent Items, ServiceRecords, Notes; merges into a single sorted list by occurredAt desc.

`quickStats()`: counts of active items (`archivedAt: null`), vendors, this-year service records.

### Page

Three sections: Quick stats (big-number cards), Quick actions (4 add buttons), Recent activity (10-row list). Greeting with `session.user.name` at top.

- [ ] Verify, commit:
```bash
pnpm verify
git add -A
git commit -m "feat(dashboard): replace stub with recent activity, quick stats, and quick actions"
```

---

## Task 18: E2E happy-path test

**Files:**
- Create: `tests/e2e/auth.ts` — extracted from `signin.spec.ts`
- Modify: `tests/e2e/signin.spec.ts` — refactor to use the helper
- Create: `tests/e2e/happy-path.spec.ts`

### Helper

```ts
// tests/e2e/auth.ts
import type { Page } from '@playwright/test';

export async function signIn(page: Page) {
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await Promise.all([
    page.waitForNavigation({ timeout: 30_000 }),
    page.getByRole('button', { name: 'Sign in with Authelia' }).click(),
  ]);
}
```

### Refactored signin.spec.ts

```ts
import { expect, test } from '@playwright/test';
import { signIn } from './auth';

test('signs in via mock OIDC and lands on dashboard', async ({ page, context }) => {
  await context.clearCookies();
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.locator('h1')).toContainText('Dashboard');
});
```

### Happy-path spec

```ts
import { expect, test } from '@playwright/test';
import { signIn } from './auth';

test('signs in, adds an item, logs service, sees activity on dashboard', async ({ page, context }) => {
  await context.clearCookies();
  await signIn(page);

  await page.goto('/items/new');
  await page.getByLabel('Name').fill('Furnace');
  await page.getByLabel('Category').selectOption('hvac');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page).toHaveURL(/\/items\/[^/]+$/);
  await expect(page.locator('h1')).toContainText('Furnace');

  await page.getByRole('link', { name: 'Service' }).click();
  await page.getByRole('link', { name: '+ Log service' }).click();
  await page.getByLabel('Performed on').fill('2026-04-15');
  await page.getByLabel('Summary').fill('Annual tune-up');
  await page.getByRole('button', { name: /Create|Save/ }).click();

  await page.goto('/dashboard');
  await expect(page.locator('text=Annual tune-up')).toBeVisible();
});
```

### Run locally

```bash
docker compose stop web worker
AUTH_SECRET="$(grep '^AUTH_SECRET=' .env | cut -d= -f2)" \
DATABASE_URL=postgresql://housemanager:devpassword@localhost:5432/housemanager \
AUTH_URL=http://localhost:3000 \
AUTH_OIDC_ISSUER=http://localhost:9999 \
AUTH_OIDC_CLIENT_ID=house-manager \
AUTH_OIDC_CLIENT_SECRET=test \
MEILI_HOST=http://localhost:7700 \
MEILI_KEY="$(grep '^MEILI_KEY=' .env | cut -d= -f2)" \
FILES_DIR=./data/files \
NODE_ENV=development \
pnpm test:e2e
```

Expected: 2 passing.

- [ ] Commit:
```bash
git add -A
git commit -m "test(e2e): add happy-path spec and extract sign-in helper"
```

---

## Done criteria

- [ ] `pnpm verify` (lint + typecheck + unit tests) passes from a fresh clone.
- [ ] `pnpm test:integration` passes (Items, Vendors, ServiceRecords, Warranties, Notes, HouseProfile, plus existing Plan 1 health test).
- [ ] `pnpm test:e2e` passes (signin + happy-path).
- [ ] `pnpm build` succeeds.
- [ ] CI passes on a PR (or push to main).
- [ ] Manual smoke (with Authelia configured): sign in → empty dashboard → add furnace → metadata fields render → log service with vendor → see activity on dashboard.

---

## Notes for the implementer

- **Lefthook pre-commit** runs Biome + tsc on every commit; expect ~3-5 second pause per commit.
- **Server Action signatures**: actions receive `unknown` from form posts. Always parse via Zod inside the action; never trust shape.
- **Decimal coercion**: Prisma's Decimal type stringifies; convert via `Number(item.purchasePrice)` for client display.
- **Search params in Next.js 15**: `searchParams` is a `Promise<...>` in App Router page props. Always `await` before reading.
- **react-hook-form + Zod resolver**: install both (`react-hook-form`, `@hookform/resolvers`). The resolver is `zodResolver`.
- **`execFileSync` not `execSync`** in test helpers — array args, no shell parsing. Codebase security hook flags `execSync`.
- **No new env vars**, no new Compose services. Plan 2a is a feature layer on Plan 1's infrastructure.
- **The Item form's metadata input is intentionally simple**. A type-aware metadata renderer (number inputs, enum dropdowns) is a Plan 5 polish.
- **Vendor inline-create from ServiceRecord form** can be deferred to a follow-up if it adds too much surface to Task 10. A "create vendor first, then come back" flow is acceptable for v1 — the autocomplete prevents typos but pre-existing vendors must be picked.
