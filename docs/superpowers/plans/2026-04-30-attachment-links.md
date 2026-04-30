# Attachment Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Plan 2b's `Attachment` model so each row can be either an uploaded file (existing behavior) OR an external link (new). One small form alongside the file picker; same activity feed; same delete UX.

**Architecture:** Make file-only columns nullable, add `externalUrl` + `displayLabel` + the two future-Drive-picker columns (`externalProvider`, `externalProviderId`). Two new CHECK constraints enforce exactly-one-of (storagePath xor externalUrl) and "files have full metadata." A new `addAttachmentLink` server action plus a small Client form mounts alongside the existing uploader. AttachmentCard branches on whether `externalUrl` is set.

**Tech Stack:** Same as Plan 2b — Prisma 7, Postgres CHECK constraints via raw SQL append, Next.js Server Actions, Zod, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-04-30-attachment-links-design.md`

---

## File structure

### Modified

- `prisma/schema.prisma` — `Attachment` columns (filename/mimeType/sizeBytes/storagePath now nullable; new columns added)
- `prisma/migrations/<timestamp>_add_attachment_links/migration.sql` — generated then manually appended
- `lib/attachments/schema.ts` — add `addAttachmentLinkSchema` and the `httpUrl` Zod refinement
- `lib/attachments/schema.test.ts` — extend with link-validation cases
- `lib/attachments/actions.ts` — add `addAttachmentLink`
- `lib/attachments/queries.ts` — `getAttachment` selects new columns (so future direct lookups have them)
- `tests/integration/attachments.test.ts` — extend with the new CHECK and cascade cases
- `lib/items/queries.ts` — `getItem` include selects `storagePath`, `externalUrl`, `displayLabel`
- `lib/warranties/queries.ts` — `getWarranty` same
- `lib/service-records/queries.ts` — `getServiceRecord` same
- `lib/notes/queries.ts` — `getNote` same
- `components/attachments/AttachmentCard.tsx` — `AttachmentRow` type expanded; new link branch; type narrowing on file branches
- `components/attachments/AttachmentUploader.tsx` — mounts `<AttachmentLinkForm>` below the file input
- `lib/dashboard/queries.ts` — link rows produce a different label/icon in the activity feed
- `tests/e2e/attachments.spec.ts` — add link round-trip to the existing happy-path

### Created

- `components/attachments/AttachmentLinkForm.tsx` — Client Component with two inputs + button

---

## Done criteria

- [ ] `pnpm verify` clean (lint + typecheck + unit).
- [ ] `pnpm test:integration` passes (existing + new attachment cases).
- [ ] `pnpm test:e2e` passes (signin + happy-path + extended attachments).
- [ ] `pnpm build` succeeds.
- [ ] Manual smoke (mock OIDC + dev): sign in → /items/<id>/files → paste a URL with a label → card renders with `🔗` icon → click opens in new tab → delete works.
- [ ] CHECK constraints reject bad combinations (verified by integration tests).

---

## Task 1: Schema migration with two new CHECKs

**Files:**
- Modify: `prisma/schema.prisma` — Attachment columns
- Create: `prisma/migrations/<timestamp>_add_attachment_links/migration.sql` (generated, then appended)

- [ ] **Step 1: Edit `prisma/schema.prisma`**

Find the existing `model Attachment { ... }`. Make four columns nullable and add four new columns. The full updated model:

```prisma
model Attachment {
  id              String         @id @default(cuid())

  filename        String?
  mimeType        String?
  sizeBytes       Int?
  storagePath     String?

  externalUrl        String?
  externalProvider   String?
  externalProviderId String?
  displayLabel       String?

  itemId          String?
  warrantyId      String?
  serviceRecordId String?
  noteId          String?
  item            Item?          @relation(fields: [itemId],          references: [id], onDelete: Cascade)
  warranty        Warranty?      @relation(fields: [warrantyId],      references: [id], onDelete: Cascade)
  serviceRecord   ServiceRecord? @relation(fields: [serviceRecordId], references: [id], onDelete: Cascade)
  note            Note?          @relation(fields: [noteId],          references: [id], onDelete: Cascade)

  uploadedById    String
  uploadedBy      User           @relation(fields: [uploadedById], references: [id])

  thumbnailPath   String?
  extractedText   String?        @db.Text
  indexedAt       DateTime?
  aiIndexable     Boolean        @default(true)

  createdAt       DateTime       @default(now())

  @@index([itemId])
  @@index([warrantyId])
  @@index([serviceRecordId])
  @@index([noteId])
}
```

Only the four `String -> String?` / `Int -> Int?` changes plus the four new lines. Don't reorder or rename.

- [ ] **Step 2: Generate the migration in `--create-only` mode so we can append CHECKs before applying**

```bash
docker compose up -d db   # already up usually
pnpm exec prisma migrate dev --create-only --name add_attachment_links
```

Expected: a new directory `prisma/migrations/<timestamp>_add_attachment_links/` with `migration.sql` containing only the `ALTER COLUMN ... DROP NOT NULL` and `ADD COLUMN` statements. NOT applied to the DB yet.

- [ ] **Step 3: Append the two new CHECKs to the generated `migration.sql`**

Open the file (path is `prisma/migrations/<timestamp>_add_attachment_links/migration.sql`) and add at the end:

```sql
-- Exactly one of (storagePath, externalUrl) must be set on each attachment row.
ALTER TABLE "attachments" ADD CONSTRAINT "Attachment_storage_xor_link"
  CHECK (
    (("storagePath" IS NOT NULL)::int + ("externalUrl" IS NOT NULL)::int) = 1
  );

-- File rows must have filename + mimeType + sizeBytes; link rows MAY have
-- them too (the future Drive picker will populate them) but aren't required to.
ALTER TABLE "attachments" ADD CONSTRAINT "Attachment_file_metadata_required"
  CHECK (
    "storagePath" IS NULL OR (
      "filename" IS NOT NULL AND "mimeType" IS NOT NULL AND "sizeBytes" IS NOT NULL
    )
  );
```

- [ ] **Step 4: Apply the migration**

```bash
pnpm db:migrate
```

Expected: `Applying migration: <timestamp>_add_attachment_links` and a clean exit. If the dev DB has any rows already (it shouldn't since Plan 2b's e2e test cleans up), the new CHECKs validate against existing rows — every existing row has `storagePath` set so they hold.

- [ ] **Step 5: Verify the constraints exist in the DB**

```bash
docker compose exec db psql -U housemanager -d housemanager -c "\d \"attachments\"" | grep -A 1 "Check constraints"
```

Expected: output shows three CHECK constraints — `Attachment_exactly_one_parent` (existing), `Attachment_storage_xor_link` (new), `Attachment_file_metadata_required` (new).

- [ ] **Step 6: Regenerate the Prisma client**

```bash
pnpm db:generate
```

Expected: completes without warnings. Plan 2b had a hiccup where running `prisma migrate deploy` doesn't regenerate the client; if the same hiccup happens here, this explicit step covers it.

- [ ] **Step 7: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "feat(attachments): make file columns nullable; add link columns + CHECKs"
```

Don't push.

---

## Task 2: Zod schema for `addAttachmentLink`

**Files:**
- Modify: `lib/attachments/schema.ts`
- Modify: `lib/attachments/schema.test.ts`

This is TDD: extend tests first, then add the schema.

- [ ] **Step 1: Add failing tests in `lib/attachments/schema.test.ts`**

Append to the existing file:

```ts
import { addAttachmentLinkSchema } from './schema';

describe('addAttachmentLinkSchema', () => {
  it('accepts a valid https URL with all fields', () => {
    const r = addAttachmentLinkSchema.safeParse({
      parentType: 'item',
      parentId: 'cuid-1',
      externalUrl: 'https://drive.proton.me/urls/W6X9',
      displayLabel: 'Furnace Manual',
      externalProvider: 'proton-drive',
      externalProviderId: 'abc123',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a valid http URL (self-hosted NAS use case)', () => {
    const r = addAttachmentLinkSchema.safeParse({
      parentType: 'item',
      parentId: 'cuid-1',
      externalUrl: 'http://192.168.1.10:8080/manual.pdf',
    });
    expect(r.success).toBe(true);
  });

  it('accepts an empty displayLabel', () => {
    const r = addAttachmentLinkSchema.safeParse({
      parentType: 'item',
      parentId: 'cuid-1',
      externalUrl: 'https://example.com/x',
      displayLabel: '',
    });
    expect(r.success).toBe(true);
  });

  it('rejects javascript: URLs (XSS hole)', () => {
    const r = addAttachmentLinkSchema.safeParse({
      parentType: 'item',
      parentId: 'cuid-1',
      externalUrl: 'javascript:alert(1)',
    });
    expect(r.success).toBe(false);
  });

  it('rejects data: URLs', () => {
    const r = addAttachmentLinkSchema.safeParse({
      parentType: 'item',
      parentId: 'cuid-1',
      externalUrl: 'data:text/html,<script>alert(1)</script>',
    });
    expect(r.success).toBe(false);
  });

  it('rejects ftp: URLs', () => {
    const r = addAttachmentLinkSchema.safeParse({
      parentType: 'item',
      parentId: 'cuid-1',
      externalUrl: 'ftp://example.com/file.pdf',
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty externalUrl', () => {
    const r = addAttachmentLinkSchema.safeParse({
      parentType: 'item',
      parentId: 'cuid-1',
      externalUrl: '',
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown parentType', () => {
    const r = addAttachmentLinkSchema.safeParse({
      parentType: 'vendor',
      parentId: 'cuid-1',
      externalUrl: 'https://example.com',
    });
    expect(r.success).toBe(false);
  });
});
```

Note the existing import at the top of the file is `import { uploadAttachmentSchema } from './schema';` — extend the same import line to include `addAttachmentLinkSchema`, OR add a new import. Match whichever style is cleaner.

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test:unit lib/attachments/schema.test.ts
```

Expected: FAIL — `addAttachmentLinkSchema` is not exported.

- [ ] **Step 3: Add the schema in `lib/attachments/schema.ts`**

Append (after the existing exports):

```ts
const httpUrl = z
  .string()
  .url()
  .refine(
    (s) => /^https?:\/\//i.test(s),
    'URL must use http:// or https://'
  );

export const addAttachmentLinkSchema = z.object({
  parentType: z.enum(PARENT_TYPES),
  parentId: z.string().min(1),
  externalUrl: httpUrl,
  displayLabel: z.string().max(200).optional().or(z.literal('')),
  externalProvider: z.string().max(50).optional(),
  externalProviderId: z.string().max(200).optional(),
});

export type AddAttachmentLinkInput = z.infer<typeof addAttachmentLinkSchema>;
```

`PARENT_TYPES` is already exported from this file by Task 4 of Plan 2b.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test:unit lib/attachments/schema.test.ts
```

Expected: PASS — 8 new cases plus the 6 existing.

- [ ] **Step 5: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "feat(attachments): add addAttachmentLinkSchema with http(s)-only URL"
```

---

## Task 3: `addAttachmentLink` server action + integration tests

**Files:**
- Modify: `lib/attachments/actions.ts`
- Modify: `lib/attachments/queries.ts`
- Modify: `tests/integration/attachments.test.ts`

- [ ] **Step 1: Add `addAttachmentLink` to `lib/attachments/actions.ts`**

Append after the existing `deleteAttachment` function:

```ts
export async function addAttachmentLink(
  formData: FormData
): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };
  const uploadedById = session.user.id;
  if (!uploadedById) return { ok: false, formError: 'Unauthorized' };

  const parsed = addAttachmentLinkSchema.safeParse({
    parentType: formData.get('parentType'),
    parentId: formData.get('parentId'),
    externalUrl: formData.get('externalUrl'),
    displayLabel: formData.get('displayLabel') ?? undefined,
    externalProvider: formData.get('externalProvider') ?? undefined,
    externalProviderId: formData.get('externalProviderId') ?? undefined,
  });
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { parentType, parentId, externalUrl, displayLabel, externalProvider, externalProviderId } =
    parsed.data;

  if (!(await parentExists(parentType, parentId))) {
    return { ok: false, formError: 'Parent not found' };
  }

  const id = createId();
  try {
    const created = await prisma.attachment.create({
      data: {
        id,
        externalUrl,
        displayLabel: displayLabel || null,
        externalProvider: externalProvider || null,
        externalProviderId: externalProviderId || null,
        uploadedById,
        [FK_FIELD[parentType]]: parentId,
      },
      select: { id: true },
    });
    for (const p of REVALIDATE_PATH[parentType](parentId)) revalidatePath(p);
    return { ok: true, data: { id: created.id } };
  } catch (e) {
    return { ok: false, formError: `Database error: ${(e as Error).message}` };
  }
}
```

Update the import at the top of the file to include `addAttachmentLinkSchema`:

```ts
import {
  addAttachmentLinkSchema,
  uploadAttachmentSchema,
  type ParentType,
} from './schema';
```

`parentExists`, `FK_FIELD`, and `REVALIDATE_PATH` are already defined in the file (Plan 2b) and reused as-is.

- [ ] **Step 2: Update `lib/attachments/queries.ts`**

Extend `getAttachment` to select the new columns (defensive — direct lookups should see them):

```ts
export async function getAttachment(id: string) {
  return prisma.attachment.findUnique({
    where: { id },
    select: {
      id: true,
      filename: true,
      mimeType: true,
      sizeBytes: true,
      storagePath: true,
      thumbnailPath: true,
      externalUrl: true,
      displayLabel: true,
    },
  });
}
```

- [ ] **Step 3: Add integration tests for the new CHECKs in `tests/integration/attachments.test.ts`**

Append to the existing `describe('Attachment CHECK constraint', ...)` block (or add a new sibling block):

```ts
describe('Attachment storage xor link CHECK', () => {
  it('rejects an INSERT with neither storagePath nor externalUrl', async () => {
    await expect(
      ctx.prisma.$executeRaw`
        INSERT INTO "attachments"
          (id, "uploadedById", "itemId", "createdAt", "aiIndexable")
        VALUES
          ('xor-1', 'test-user', ${itemId}, NOW(), true);
      `,
    ).rejects.toThrow(/Attachment_storage_xor_link/);
  });

  it('rejects an INSERT with both storagePath AND externalUrl', async () => {
    await expect(
      ctx.prisma.$executeRaw`
        INSERT INTO "attachments"
          (id, filename, "mimeType", "sizeBytes", "storagePath", "externalUrl",
           "uploadedById", "itemId", "createdAt", "aiIndexable")
        VALUES
          ('xor-2', 'x.pdf', 'application/pdf', 1, 'xor-2/original.pdf',
           'https://example.com/x', 'test-user', ${itemId}, NOW(), true);
      `,
    ).rejects.toThrow(/Attachment_storage_xor_link/);
  });

  it('accepts an INSERT with only externalUrl set (link row)', async () => {
    const a = await ctx.prisma.attachment.create({
      data: {
        externalUrl: 'https://example.com/manual.pdf',
        displayLabel: 'Manual',
        uploadedById: 'test-user',
        itemId,
      },
    });
    expect(a.externalUrl).toBe('https://example.com/manual.pdf');
    expect(a.storagePath).toBeNull();
  });
});

describe('Attachment file metadata required CHECK', () => {
  it('rejects an INSERT with storagePath set but filename NULL', async () => {
    await expect(
      ctx.prisma.$executeRaw`
        INSERT INTO "attachments"
          (id, "mimeType", "sizeBytes", "storagePath", "uploadedById",
           "itemId", "createdAt", "aiIndexable")
        VALUES
          ('meta-1', 'application/pdf', 1, 'meta-1/original.pdf',
           'test-user', ${itemId}, NOW(), true);
      `,
    ).rejects.toThrow(/Attachment_file_metadata_required/);
  });

  it('accepts a link row with filename populated (future Drive picker)', async () => {
    const a = await ctx.prisma.attachment.create({
      data: {
        externalUrl: 'https://drive.example/x',
        filename: 'Future Drive File.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 12345,
        uploadedById: 'test-user',
        itemId,
      },
    });
    expect(a.filename).toBe('Future Drive File.pdf');
    expect(a.storagePath).toBeNull();
  });
});

describe('Link row cascade', () => {
  it('cascade-deletes a link row when its parent Item is hard-deleted', async () => {
    const a = await ctx.prisma.attachment.create({
      data: {
        externalUrl: 'https://example.com/x',
        uploadedById: 'test-user',
        itemId,
      },
    });
    await ctx.prisma.item.delete({ where: { id: itemId } });
    const orphan = await ctx.prisma.attachment.findUnique({ where: { id: a.id } });
    expect(orphan).toBeNull();
  });
});
```

- [ ] **Step 4: Run integration tests**

```bash
pnpm test:integration tests/integration/attachments.test.ts
```

Expected: 6 new cases pass (3 xor + 2 metadata + 1 cascade) plus the existing 5. Total 11 in this file.

- [ ] **Step 5: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "feat(attachments): add addAttachmentLink action + integration tests"
```

---

## Task 4: UI components — Card branch + LinkForm + Uploader integration

**Files:**
- Create: `components/attachments/AttachmentLinkForm.tsx`
- Modify: `components/attachments/AttachmentCard.tsx`
- Modify: `components/attachments/AttachmentUploader.tsx`

This task is UI; no TDD. Visual validation comes from Task 6 e2e.

- [ ] **Step 1: Expand `AttachmentRow` and add link branch in `AttachmentCard.tsx`**

Edit `components/attachments/AttachmentCard.tsx`:

(a) Update the `AttachmentRow` type:

```ts
export type AttachmentRow = {
  id: string;
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  storagePath: string | null;
  externalUrl: string | null;
  displayLabel: string | null;
  thumbnailPath: string | null;
};
```

(b) Replace the existing branch logic in the component body. The rendering split:

```tsx
export function AttachmentCard({ a }: { a: AttachmentRow }) {
  const isLink = a.externalUrl != null;
  const isImage = !isLink && (a.mimeType ?? '').startsWith('image/');
  const cardStyle: React.CSSProperties = {
    border: '1px solid var(--border)',
    borderRadius: '4px',
    padding: '0.5rem',
    background: 'var(--bg-elevated)',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.4rem',
  };

  if (isLink) {
    let hostname: string;
    try {
      hostname = new URL(a.externalUrl!).hostname;
    } catch {
      hostname = a.externalUrl!;
    }
    return (
      <div style={cardStyle}>
        <a
          href={a.externalUrl!}
          target="_blank"
          rel="noopener noreferrer"
          style={{ textDecoration: 'none', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '1.5rem' }}>🔗</span>
            <span style={{ wordBreak: 'break-word' }}>
              {a.displayLabel || hostname}
            </span>
          </div>
          <span
            style={{
              fontSize: '0.75rem',
              color: 'var(--fg-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {a.externalUrl}
          </span>
        </a>
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            fontSize: '0.8rem',
            color: 'var(--fg-muted)',
          }}
        >
          <AttachmentDeleteForm id={a.id} />
        </div>
      </div>
    );
  }

  // existing file branches (image vs PDF) unchanged from Plan 2b — keep as-is.
  // ...
}
```

Keep the existing `formatSize`, `AttachmentDeleteForm`, and image/PDF branches exactly as they were in Plan 2b. Just add the link branch in front and tweak the type. Read the current file first and splice carefully.

- [ ] **Step 2: Create `components/attachments/AttachmentLinkForm.tsx`**

```tsx
'use client';
import type React from 'react';
import { useState, useTransition } from 'react';
import { addAttachmentLink } from '@/lib/attachments/actions';
import type { ParentType } from '@/lib/attachments/schema';

type Props = {
  parentType: ParentType;
  parentId: string;
};

export function AttachmentLinkForm({ parentType, parentId }: Props) {
  const [pending, startTransition] = useTransition();
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set('parentType', parentType);
      fd.set('parentId', parentId);
      fd.set('externalUrl', url);
      if (label) fd.set('displayLabel', label);
      const result = await addAttachmentLink(fd);
      if (result.ok) {
        setUrl('');
        setLabel('');
      } else {
        setError(result.formError ?? 'Could not add link');
      }
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0.5rem',
        marginTop: '0.75rem',
        paddingTop: '0.75rem',
        borderTop: '1px solid var(--border)',
        alignItems: 'flex-end',
      }}
    >
      <label style={{ display: 'flex', flexDirection: 'column', flex: '1 1 200px', fontSize: '0.85rem' }}>
        Label (optional)
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={200}
          disabled={pending}
          style={{ padding: '0.25rem 0.4rem', marginTop: '0.15rem' }}
        />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', flex: '2 1 320px', fontSize: '0.85rem' }}>
        URL (https or http)
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
          placeholder="https://drive.proton.me/..."
          disabled={pending}
          style={{ padding: '0.25rem 0.4rem', marginTop: '0.15rem' }}
        />
      </label>
      <button
        type="submit"
        disabled={pending || url === ''}
        style={{ padding: '0.4rem 0.75rem', cursor: 'pointer' }}
      >
        {pending ? 'Adding…' : 'Add link'}
      </button>
      {error && (
        <p style={{ flex: '1 1 100%', fontSize: '0.85rem', color: 'var(--danger)', margin: 0 }}>
          {error}
        </p>
      )}
    </form>
  );
}
```

- [ ] **Step 3: Mount the form in `AttachmentUploader.tsx`**

Open `components/attachments/AttachmentUploader.tsx`. At the top, add:

```tsx
import { AttachmentLinkForm } from './AttachmentLinkForm';
```

In the JSX, after the existing `<input type="file">` + per-file status list, add `<AttachmentLinkForm parentType={parentType} parentId={parentId} />` so it renders just below. The wrapping `<div style={{ marginTop: '0.75rem' }}>` already exists; the link form goes inside it after the conditional `<ul>`.

Result is a single uploader surface that holds both the file input AND the link form, separated by the link form's own `borderTop`.

- [ ] **Step 4: Verify, commit**

```bash
pnpm verify
pnpm build
git add -A
git commit -m "feat(attachments): add link form + Card link branch"
```

---

## Task 5: Wire link columns through every parent query + dashboard activity

**Files:**
- Modify: `lib/items/queries.ts`
- Modify: `lib/warranties/queries.ts`
- Modify: `lib/service-records/queries.ts`
- Modify: `lib/notes/queries.ts`
- Modify: `lib/dashboard/queries.ts`

This task is mechanical — same select-list change in five files plus the dashboard label switch.

- [ ] **Step 1: Update each parent's `attachments` include**

In `lib/items/queries.ts`, `lib/warranties/queries.ts`, `lib/service-records/queries.ts`, `lib/notes/queries.ts`, find the `attachments` block inside the `include` of the get-by-id function. The current select shape (from Plan 2b) is:

```ts
attachments: {
  orderBy: { createdAt: 'desc' },
  select: {
    id: true,
    filename: true,
    mimeType: true,
    sizeBytes: true,
    thumbnailPath: true,
  },
},
```

Add three more fields:

```ts
attachments: {
  orderBy: { createdAt: 'desc' },
  select: {
    id: true,
    filename: true,
    mimeType: true,
    sizeBytes: true,
    storagePath: true,
    thumbnailPath: true,
    externalUrl: true,
    displayLabel: true,
  },
},
```

Apply this exact change in all four files.

- [ ] **Step 2: Update the dashboard activity feed**

Open `lib/dashboard/queries.ts`. Find the section that maps attachment rows to events (added in Plan 2b Task 12 — uses `flatMap` with item/warranty/serviceRecord/note branches).

(a) Update the attachment select inside `Promise.all` to add `externalUrl` and `displayLabel`:

```ts
prisma.attachment.findMany({
  orderBy: { createdAt: 'desc' },
  take: limit,
  select: {
    id: true,
    filename: true,
    externalUrl: true,
    displayLabel: true,
    createdAt: true,
    item:          { select: { id: true, name: true } },
    warranty:      { select: { id: true, provider: true } },
    serviceRecord: { select: { id: true, summary: true } },
    note:          { select: { id: true, title: true } },
  },
}),
```

(b) Update the label/icon construction. The current code looks something like:

```ts
return [
  {
    kind: 'attachment-added' as const,
    occurredAt: a.createdAt,
    label: `Added ${a.filename} to ${a.item.name}`,
    href: `/items/${a.item.id}?tab=files`,
    icon: '📎',
  },
];
```

Replace each of the four parent branches so the label and icon adapt for link rows. A small helper at the top of the function avoids duplication:

```ts
function attachmentLabelText(a: { filename: string | null; externalUrl: string | null; displayLabel: string | null }): { verb: string; name: string; icon: string } {
  if (a.externalUrl) {
    let hostname: string;
    try { hostname = new URL(a.externalUrl).hostname; } catch { hostname = a.externalUrl; }
    return { verb: 'Linked', name: a.displayLabel || hostname, icon: '🔗' };
  }
  return { verb: 'Added', name: a.filename ?? '(file)', icon: '📎' };
}
```

Then in each branch, use the helper:

```ts
if (a.item) {
  const { verb, name, icon } = attachmentLabelText(a);
  return [
    {
      kind: 'attachment-added' as const,
      occurredAt: a.createdAt,
      label: `${verb} ${name} to ${a.item.name}`,
      href: `/items/${a.item.id}?tab=files`,
      icon,
    },
  ];
}
// repeat the pattern for warranty/serviceRecord/note branches
```

The other three branches follow the same shape; just change the parent name reference and the href.

- [ ] **Step 3: Verify, commit**

```bash
pnpm verify
pnpm build
git add -A
git commit -m "feat(attachments): include link columns in parent queries + dashboard activity"
```

---

## Task 6: E2E happy-path extension

**Files:**
- Modify: `tests/e2e/attachments.spec.ts`

- [ ] **Step 1: Extend the existing test**

Open `tests/e2e/attachments.spec.ts`. The current test does sign-in → create item → upload → delete. After the file-delete assertion (`await expect(page.locator('text=No files yet')).toBeVisible();`), append link round-trip:

```ts
// Add an external link via the form below the file picker.
await page.getByLabel('Label (optional)').fill('Furnace manual on Proton');
await page.getByLabel('URL (https or http)').fill('https://drive.proton.me/urls/EXAMPLE');
await page.getByRole('button', { name: 'Add link' }).click();
await expect(page.locator('text=Furnace manual on Proton')).toBeVisible({ timeout: 10_000 });

// Delete the link.
await page.getByRole('button', { name: 'Delete' }).click();
await expect(page.locator('text=No files yet')).toBeVisible();
```

- [ ] **Step 2: Run the spec**

```bash
pnpm test:e2e tests/e2e/attachments.spec.ts
```

Expected: 1 spec passes (the existing test, now with the link round-trip appended).

If the spec fails because two separate test runs (file then link) interact via DB state, restructure the spec into TWO `test()` blocks that share `test.beforeEach(resetAuth())` — but the simpler single-test-extended path should work since both file and link use the same item.

- [ ] **Step 3: Run full e2e suite**

```bash
pnpm test:e2e
```

Expected: 3 specs pass (signin + happy-path + attachments).

- [ ] **Step 4: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "test(e2e): add link round-trip to attachments happy-path"
```

---

## Notes for the implementer

- **Lefthook pre-commit** runs Biome + tsc on every commit; expect ~3-5 seconds per commit.
- **Server actions** receive `FormData`; always parse via Zod and never trust shape.
- **Search params + params** are Promises in Next 15. Already handled in existing code; no new reason to touch them.
- **`new URL(...)` can throw**. Both the AttachmentCard render and the dashboard activity helper wrap the call in try/catch with the raw URL as fallback. Don't drop those guards.
- **Existing dev DB** has no rows in the attachments table after Plan 2b's e2e cleanup; the migration applies cleanly. If a developer's local DB has stale rows from manual testing, the migration may need a quick `delete from "attachments"` first — surface it as DONE_WITH_CONCERNS if you hit it.
- **Prisma client regen** after the migration: `pnpm db:generate` is the explicit step. Plan 2b had a hiccup where Prisma's client cache was stale; running `db:generate` after `db:migrate` avoids the same issue here.
- **Patch-pin discipline + no new deps**. This plan adds zero new packages — everything is already installed.
