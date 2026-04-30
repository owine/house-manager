# Plan 2b — Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement file attachments for Item, Warranty, ServiceRecord, and Note — including the data model, filesystem storage, authenticated download route, async thumbnail generation, and per-entity UI.

**Architecture:** A single polymorphic `Attachment` model with nullable FKs (CHECK constraint enforcing exactly-one parent). Files stored on a bind-mounted volume under `FILES_DIR` in per-attachment directories. Server Actions for upload/delete; a Route Handler streams downloads. pg-boss generates WebP thumbnails out-of-band. UI is a shared trio of components (Uploader, List, Card) mounted on each detail page.

**Tech Stack:** Prisma 7, Postgres + raw-SQL CHECK constraint, Next.js Server Actions + Route Handler, pg-boss (existing worker), `sharp` (new dep) + libvips/vips-heif (new Alpine packages), React 19, Zod, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-04-30-plan-2b-attachments-design.md`

---

## File Structure

### New files

**Data layer + helpers**
- `prisma/migrations/<timestamp>_add_attachments/migration.sql` — auto-generated, then manually appended with the CHECK constraint
- `lib/attachments/schema.ts` — Zod schemas for upload/delete actions
- `lib/attachments/schema.test.ts` — Zod unit tests
- `lib/attachments/queries.ts` — read functions (currently only `getAttachment`; list-by-parent is via the relation include on each parent's getter)
- `lib/attachments/actions.ts` — `uploadAttachment`, `deleteAttachment` server actions
- `lib/attachments/storage.ts` — filesystem helpers (resolve path under FILES_DIR with path-traversal guard, atomic write via temp + rename, atomic delete)
- `lib/attachments/storage.test.ts` — unit tests for storage helpers
- `lib/attachments/mime.ts` — magic-bytes verification + MIME → file-extension mapping
- `lib/attachments/mime.test.ts` — magic-bytes tests using small fixture buffers
- `tests/integration/attachments.test.ts` — Prisma-level integration tests (CHECK constraint, cascade behavior)
- `tests/fixtures/sample.jpg` — 50-KB-class JPEG fixture used by worker test + e2e
- `tests/fixtures/sample.pdf` — small PDF fixture used by integration test

**Worker**
- `worker/jobs/thumbnail.ts` — pg-boss handler that resizes images to WebP
- `worker/jobs/thumbnail.test.ts` — integration test that runs the handler against a temp FILES_DIR

**HTTP**
- `app/api/files/[id]/route.ts` — Route Handler streaming the original or thumbnail

**UI components**
- `components/attachments/AttachmentUploader.tsx` — Client Component, multi-file picker
- `components/attachments/AttachmentList.tsx` — Server Component, grid of cards
- `components/attachments/AttachmentCard.tsx` — Server Component, single cell with image/PDF branch + delete

**Pages**
- `app/(app)/warranties/[id]/page.tsx` — new Warranty detail page (Plan 2a didn't have one)

**E2E**
- `tests/e2e/attachments.spec.ts` — happy-path upload + view + delete on the Item Files tab

### Modified files

- `prisma/schema.prisma` — add `Attachment` model + relation arrays on Item, Warranty, ServiceRecord, Note, User
- `package.json` — add `sharp`, `file-type` dev deps; possibly bump engines
- `next.config.ts` — `experimental.serverActions.bodySizeLimit: '25mb'`
- `Dockerfile` — `apk add vips vips-heif` in the runtime stage (and matching in builder stage if `prisma generate` needs it)
- `worker/index.ts` — register the `thumbnail` job
- `lib/items/queries.ts` — `getItem` includes `attachments`
- `lib/service-records/queries.ts` — `getServiceRecord` includes `attachments`
- `lib/notes/queries.ts` — `getNote` includes `attachments`
- `lib/warranties/queries.ts` — `getWarranty` includes `attachments` (already exists for table use; extend the include)
- `lib/dashboard/queries.ts` — add `attachment-added` event in `recentActivity`
- `app/(app)/items/[id]/page.tsx` — add Files tab
- `components/items/ItemTabs.tsx` — add `'files'` to `VALID_TABS`
- `app/(app)/service/[id]/page.tsx` — append attachments section
- `app/(app)/notes/[id]/page.tsx` — append attachments section
- `components/warranties/WarrantyTable.tsx` — link rows to the new Warranty detail page

---

## Done criteria

- [ ] `pnpm verify` passes from a clean checkout (lint + typecheck + unit).
- [ ] `pnpm test:integration` passes (existing 49 + new attachments tests).
- [ ] `pnpm test:e2e` passes (signin + happy-path + new attachments spec).
- [ ] `pnpm build` succeeds.
- [ ] Manual smoke (with mock OIDC + dev server): sign in → /items/new → create item → Files tab → upload a JPEG → thumbnail appears within ~2s → delete succeeds. Repeat the upload step for a PDF; verify it renders as a card with the filename.
- [ ] CHECK constraint blocks invalid INSERTs (verified by integration test).
- [ ] No new lint warnings.

---

## Task 1: Schema + migration with CHECK constraint

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_attachments/migration.sql` (auto-generated, then edited)

- [ ] **Step 1: Add the `Attachment` model**

Add to `prisma/schema.prisma` (place after the `Note` model):

```prisma
model Attachment {
  id              String         @id @default(cuid())
  filename        String
  mimeType        String
  sizeBytes       Int
  storagePath     String         // relative to FILES_DIR; e.g. "<id>/original.pdf"

  // Exactly one of these four FKs is set; enforced by a DB CHECK constraint
  // added via raw SQL in the migration. See `Attachment_exactly_one_parent`.
  itemId          String?
  warrantyId      String?
  serviceRecordId String?
  noteId          String?
  item            Item?          @relation(fields: [itemId], references: [id], onDelete: Cascade)
  warranty        Warranty?      @relation(fields: [warrantyId], references: [id], onDelete: Cascade)
  serviceRecord   ServiceRecord? @relation(fields: [serviceRecordId], references: [id], onDelete: Cascade)
  note            Note?          @relation(fields: [noteId], references: [id], onDelete: Cascade)

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

- [ ] **Step 2: Add the inverse relation arrays**

In `prisma/schema.prisma`, add `attachments Attachment[]` to each of:
- `model Item` — alongside the existing `warranties`, `serviceRecords`, `itemNotes` arrays
- `model Warranty` — new array
- `model ServiceRecord` — new array
- `model Note` — new array
- `model User` — `attachmentsUploaded Attachment[]` (named to avoid clashing with any future `attachments` on User)

- [ ] **Step 3: Generate the migration**

```bash
docker compose up -d db
pnpm db:migrate -- --name add_attachments
```

Expected: a new directory under `prisma/migrations/` containing a `migration.sql` with the auto-generated `CREATE TABLE "Attachment"` and FK statements.

- [ ] **Step 4: Append the CHECK constraint**

Edit the freshly-generated `migration.sql` and append at the end:

```sql
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_exactly_one_parent"
  CHECK (
    ("itemId" IS NOT NULL)::int +
    ("warrantyId" IS NOT NULL)::int +
    ("serviceRecordId" IS NOT NULL)::int +
    ("noteId" IS NOT NULL)::int
    = 1
  );
```

- [ ] **Step 5: Re-apply the migration so the CHECK is in the DB**

```bash
pnpm db:migrate
```

Expected: "Already in sync, no schema change or pending migration was found." If Prisma complains about a checksum mismatch, run `pnpm exec prisma migrate resolve --applied <migration-name>` to mark it applied without re-running, then run `pnpm db:migrate` again to apply just the appended statement; alternatively `pnpm exec prisma migrate dev --create-only` first, edit, then `pnpm db:migrate`.

- [ ] **Step 6: Verify the constraint exists**

```bash
docker compose exec db psql -U housemanager -d housemanager -c "\d \"Attachment\""
```

Expected: output includes `Check constraints: "Attachment_exactly_one_parent" CHECK ((...) = 1)`.

- [ ] **Step 7: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "feat(attachments): add Attachment schema + CHECK constraint"
```

---

## Task 2: Add sharp + configure Server Action body-size limit

**Files:**
- Modify: `package.json`
- Modify: `next.config.ts`
- Modify: `Dockerfile`

- [ ] **Step 1: Add runtime dependencies**

```bash
pnpm add sharp@~0.34
pnpm add file-type@~21
```

(`file-type` is a small lib for magic-bytes verification.)

- [ ] **Step 2: Configure Server Action body-size limit**

Edit `next.config.ts` and add the experimental field:

```ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '25mb',
    },
  },
};

export default nextConfig;
```

If `next.config.ts` already has other config, merge — don't replace.

- [ ] **Step 3: Add libvips with HEIC support to the Dockerfile**

Edit `Dockerfile`. In the runtime stage (the final `FROM node:24.15.0-alpine ...`), add before `USER` or `CMD`:

```Dockerfile
RUN apk add --no-cache vips vips-heif
```

If the builder stage also runs `sharp` (it does during `pnpm install` because `sharp` builds a native binding), add the same line in the builder stage too.

- [ ] **Step 4: Verify `sharp` loads**

```bash
pnpm exec node -e "const s = require('sharp'); console.log(s.versions)"
```

Expected: an object with `vips`, `cairo`, etc. entries. No "missing libvips" error.

- [ ] **Step 5: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "build(attachments): add sharp + file-type, raise Server Action body limit, install libvips"
```

---

## Task 3: Storage helpers + MIME verification

**Files:**
- Create: `lib/attachments/storage.ts`
- Create: `lib/attachments/storage.test.ts`
- Create: `lib/attachments/mime.ts`
- Create: `lib/attachments/mime.test.ts`

- [ ] **Step 1: Write the failing test for `resolveStoragePath`**

Create `lib/attachments/storage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveStoragePath } from './storage';

describe('resolveStoragePath', () => {
  it('returns an absolute path under FILES_DIR for a normal storage path', () => {
    const abs = resolveStoragePath('/data/files', 'abc123/original.pdf');
    expect(abs).toBe('/data/files/abc123/original.pdf');
  });

  it('rejects paths that try to escape FILES_DIR', () => {
    expect(() => resolveStoragePath('/data/files', '../etc/passwd')).toThrow(/outside FILES_DIR/);
    expect(() => resolveStoragePath('/data/files', 'abc/../../../etc/passwd')).toThrow();
  });

  it('rejects absolute storage paths', () => {
    expect(() => resolveStoragePath('/data/files', '/etc/passwd')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test:unit lib/attachments/storage.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/attachments/storage.ts`**

```ts
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolve a storage path (relative, e.g. "abc123/original.pdf") against
 * FILES_DIR and verify the result stays under FILES_DIR. Throws on traversal.
 */
export function resolveStoragePath(filesDir: string, storagePath: string): string {
  if (path.isAbsolute(storagePath)) {
    throw new Error(`storagePath must be relative: ${storagePath}`);
  }
  const abs = path.resolve(filesDir, storagePath);
  const rel = path.relative(filesDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`storagePath resolves outside FILES_DIR: ${storagePath}`);
  }
  return abs;
}

/**
 * Atomically write bytes to FILES_DIR/<dir>/<name>: temp file in the same
 * directory then rename. The directory is created if missing.
 */
export async function atomicWrite(
  filesDir: string,
  dir: string,
  name: string,
  data: Buffer,
): Promise<string> {
  const dirAbs = resolveStoragePath(filesDir, dir);
  await mkdir(dirAbs, { recursive: true });
  const finalAbs = path.join(dirAbs, name);
  const tempAbs = path.join(dirAbs, `.${name}.tmp-${process.pid}`);
  await writeFile(tempAbs, data);
  await rename(tempAbs, finalAbs);
  return path.relative(filesDir, finalAbs);
}

/** Recursive remove of FILES_DIR/<dir>. Idempotent. */
export async function removeDir(filesDir: string, dir: string): Promise<void> {
  const abs = resolveStoragePath(filesDir, dir);
  await rm(abs, { recursive: true, force: true });
}

/** Open a read stream for downloads. Caller resolves the path first. */
export function openReadStream(absPath: string) {
  return createReadStream(absPath);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test:unit lib/attachments/storage.test.ts
```

Expected: PASS (3/3).

- [ ] **Step 5: Add round-trip test for atomicWrite + removeDir**

Append to `lib/attachments/storage.test.ts`:

```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { atomicWrite, removeDir } from './storage';

describe('atomicWrite + removeDir', () => {
  it('writes a file and removes its directory', async () => {
    const root = await mkdtemp(`${tmpdir()}/storage-test-`);
    const rel = await atomicWrite(root, 'abc/', 'file.bin', Buffer.from('hello'));
    expect(rel).toBe('abc/file.bin');
    const content = await readFile(`${root}/abc/file.bin`);
    expect(content.toString()).toBe('hello');
    await removeDir(root, 'abc');
    await expect(readFile(`${root}/abc/file.bin`)).rejects.toThrow(/ENOENT/);
  });
});
```

Run: `pnpm test:unit lib/attachments/storage.test.ts` — expect 4/4 passing.

- [ ] **Step 6: Write the failing test for MIME verification**

Create `lib/attachments/mime.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ALLOWED_MIME, extensionFor, verifyMagicBytes } from './mime';

describe('ALLOWED_MIME', () => {
  it('contains exactly the five allowed types', () => {
    expect(ALLOWED_MIME).toEqual(
      new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']),
    );
  });
});

describe('extensionFor', () => {
  it.each([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
    ['image/heic', 'heic'],
    ['application/pdf', 'pdf'],
  ])('maps %s to %s', (mime, ext) => {
    expect(extensionFor(mime)).toBe(ext);
  });

  it('throws for unknown MIME', () => {
    expect(() => extensionFor('image/gif')).toThrow();
  });
});

describe('verifyMagicBytes', () => {
  it('accepts a JPEG buffer with claim image/jpeg', async () => {
    // SOI marker + minimal JFIF
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
    await expect(verifyMagicBytes(buf, 'image/jpeg')).resolves.toBe(true);
  });

  it('accepts a PNG buffer with claim image/png', async () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    await expect(verifyMagicBytes(buf, 'image/png')).resolves.toBe(true);
  });

  it('accepts a PDF buffer with claim application/pdf', async () => {
    const buf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    await expect(verifyMagicBytes(buf, 'application/pdf')).resolves.toBe(true);
  });

  it('rejects a JPEG buffer claiming PNG', async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    await expect(verifyMagicBytes(buf, 'image/png')).resolves.toBe(false);
  });

  it('rejects a totally unknown buffer', async () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]);
    await expect(verifyMagicBytes(buf, 'image/jpeg')).resolves.toBe(false);
  });
});
```

Run: `pnpm test:unit lib/attachments/mime.test.ts` — expect FAIL (module not found).

- [ ] **Step 7: Implement `lib/attachments/mime.ts`**

```ts
import { fileTypeFromBuffer } from 'file-type';

export const ALLOWED_MIME = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
]);

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

export function extensionFor(mime: string): string {
  const ext = EXT_BY_MIME[mime];
  if (!ext) throw new Error(`unsupported MIME: ${mime}`);
  return ext;
}

/**
 * Read the file-type signature from the first ~12 bytes and verify it
 * matches the claimed MIME. Returns true only if the magic bytes match.
 *
 * Note: HEIC magic bytes detect as `image/heic` in `file-type`. JPEGs
 * detected as `image/jpeg`. PDFs as `application/pdf`. file-type's MIME
 * strings already match our ALLOWED_MIME set — no aliasing needed.
 */
export async function verifyMagicBytes(buf: Buffer, claimedMime: string): Promise<boolean> {
  if (!ALLOWED_MIME.has(claimedMime)) return false;
  const detected = await fileTypeFromBuffer(buf);
  if (!detected) return false;
  return detected.mime === claimedMime;
}
```

- [ ] **Step 8: Run tests to verify they pass**

```bash
pnpm test:unit lib/attachments/mime.test.ts
```

Expected: PASS (8/8 — 1 ALLOWED_MIME + 6 extensionFor + 5 verifyMagicBytes).

- [ ] **Step 9: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "feat(attachments): add storage and MIME helpers"
```

---

## Task 4: Attachments data layer (Zod, queries, actions, integration tests)

**Files:**
- Create: `lib/attachments/schema.ts`
- Create: `lib/attachments/schema.test.ts`
- Create: `lib/attachments/queries.ts`
- Create: `lib/attachments/actions.ts`
- Create: `tests/integration/attachments.test.ts`
- Create: `tests/fixtures/sample.pdf` — small PDF (≤ 10 KB)

- [ ] **Step 1: Add a small PDF fixture**

Generate a tiny PDF at `tests/fixtures/sample.pdf`. The file should be a valid PDF; one option is to commit one made via `printf '%PDF-1.4\n%%EOF\n' > tests/fixtures/sample.pdf` but that's invalid; instead, use any small real PDF (e.g., a 1-page export from a text editor, or `pdfcpu` / `node` to generate). Aim for under 10 KB.

(If the implementer can't easily generate one, a Buffer-based round-trip in tests can substitute — the integration test in step 7 doesn't strictly require a file fixture; it inserts metadata only.)

- [ ] **Step 2: Write Zod schema**

Create `lib/attachments/schema.ts`:

```ts
import { z } from 'zod';

export const PARENT_TYPES = ['item', 'warranty', 'serviceRecord', 'note'] as const;
export type ParentType = (typeof PARENT_TYPES)[number];

export const uploadAttachmentSchema = z.object({
  parentType: z.enum(PARENT_TYPES),
  parentId: z.string().min(1),
});

export type UploadAttachmentInput = z.infer<typeof uploadAttachmentSchema>;
```

- [ ] **Step 3: Write Zod unit tests**

Create `lib/attachments/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { uploadAttachmentSchema } from './schema';

describe('uploadAttachmentSchema', () => {
  it.each(['item', 'warranty', 'serviceRecord', 'note'] as const)(
    'accepts parentType=%s with a non-empty parentId',
    (parentType) => {
      const r = uploadAttachmentSchema.safeParse({ parentType, parentId: 'cuid-123' });
      expect(r.success).toBe(true);
    },
  );

  it('rejects unknown parentType', () => {
    const r = uploadAttachmentSchema.safeParse({ parentType: 'vendor', parentId: 'x' });
    expect(r.success).toBe(false);
  });

  it('rejects empty parentId', () => {
    const r = uploadAttachmentSchema.safeParse({ parentType: 'item', parentId: '' });
    expect(r.success).toBe(false);
  });
});
```

Run: `pnpm test:unit lib/attachments/schema.test.ts` — expect 6/6 passing.

- [ ] **Step 4: Write the queries module**

Create `lib/attachments/queries.ts`:

```ts
import { prisma } from '@/lib/db';

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
    },
  });
}
```

- [ ] **Step 5: Write the upload action**

Create `lib/attachments/actions.ts`:

```ts
'use server';
import { createId } from '@paralleldrive/cuid2';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { queue } from '@/lib/queue';
import type { ActionResult } from '@/lib/result';
import { ALLOWED_MIME, extensionFor, verifyMagicBytes } from './mime';
import { uploadAttachmentSchema, type ParentType } from './schema';
import { atomicWrite, removeDir } from './storage';

const MAX_BYTES = 25_000_000;

const FK_FIELD: Record<ParentType, 'itemId' | 'warrantyId' | 'serviceRecordId' | 'noteId'> = {
  item: 'itemId',
  warranty: 'warrantyId',
  serviceRecord: 'serviceRecordId',
  note: 'noteId',
};

const REVALIDATE_PATH: Record<ParentType, (id: string) => string[]> = {
  item: (id) => [`/items/${id}`, '/dashboard'],
  warranty: (id) => [`/warranties/${id}`, '/dashboard'],
  serviceRecord: (id) => [`/service/${id}`, '/dashboard'],
  note: (id) => [`/notes/${id}`, '/dashboard'],
};

async function parentExists(parentType: ParentType, id: string): Promise<boolean> {
  switch (parentType) {
    case 'item':
      return !!(await prisma.item.findUnique({ where: { id }, select: { id: true } }));
    case 'warranty':
      return !!(await prisma.warranty.findUnique({ where: { id }, select: { id: true } }));
    case 'serviceRecord':
      return !!(await prisma.serviceRecord.findUnique({ where: { id }, select: { id: true } }));
    case 'note':
      return !!(await prisma.note.findUnique({ where: { id }, select: { id: true } }));
  }
}

export async function uploadAttachment(formData: FormData): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };
  const uploadedById = session.user.id;

  const parsed = uploadAttachmentSchema.safeParse({
    parentType: formData.get('parentType'),
    parentId: formData.get('parentId'),
  });
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { parentType, parentId } = parsed.data;

  const file = formData.get('file');
  if (!(file instanceof File)) return { ok: false, formError: 'No file provided' };
  if (file.size > MAX_BYTES) return { ok: false, formError: 'File exceeds 25 MB limit' };
  if (!ALLOWED_MIME.has(file.type)) return { ok: false, formError: 'Unsupported file type' };

  const buffer = Buffer.from(await file.arrayBuffer());
  if (!(await verifyMagicBytes(buffer, file.type))) {
    return { ok: false, formError: 'File contents do not match declared type' };
  }

  if (!(await parentExists(parentType, parentId))) {
    return { ok: false, formError: 'Parent not found' };
  }

  const id = createId();
  const ext = extensionFor(file.type);
  const storagePath = `${id}/original.${ext}`;

  try {
    await atomicWrite(env.FILES_DIR, id, `original.${ext}`, buffer);
  } catch (e) {
    return { ok: false, formError: `Storage error: ${(e as Error).message}` };
  }

  try {
    const created = await prisma.attachment.create({
      data: {
        id,
        filename: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        storagePath,
        uploadedById,
        [FK_FIELD[parentType]]: parentId,
      },
      select: { id: true },
    });

    if (file.type.startsWith('image/')) {
      try {
        await queue.send('thumbnail', { attachmentId: id });
      } catch (e) {
        // Queue failure is logged-but-not-fatal — the upload still succeeded.
        console.error('[attachments] failed to enqueue thumbnail job', e);
      }
    }

    for (const p of REVALIDATE_PATH[parentType](parentId)) revalidatePath(p);
    return { ok: true, data: { id: created.id } };
  } catch (e) {
    // DB write failed after the file landed on disk — clean up the directory.
    await removeDir(env.FILES_DIR, id).catch(() => {});
    return { ok: false, formError: `Database error: ${(e as Error).message}` };
  }
}

export async function deleteAttachment(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const row = await prisma.attachment.findUnique({
    where: { id },
    select: { itemId: true, warrantyId: true, serviceRecordId: true, noteId: true },
  });
  if (!row) return { ok: false, formError: 'Not found' };

  await prisma.attachment.delete({ where: { id } });
  await removeDir(env.FILES_DIR, id).catch((e) => {
    console.error('[attachments] failed to remove storage dir', e);
  });

  if (row.itemId) revalidatePath(`/items/${row.itemId}`);
  if (row.warrantyId) revalidatePath(`/warranties/${row.warrantyId}`);
  if (row.serviceRecordId) revalidatePath(`/service/${row.serviceRecordId}`);
  if (row.noteId) revalidatePath(`/notes/${row.noteId}`);
  revalidatePath('/dashboard');

  return { ok: true, data: undefined };
}
```

Notes:
- `queue` should be the existing pg-boss client at `lib/queue.ts` (Plan 1 set this up). If the export name is different, adjust.
- `env.FILES_DIR` is the existing env helper from `lib/env.ts`. Confirm the export shape.

- [ ] **Step 6: Write the integration test**

Create `tests/integration/attachments.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;
let categoryId: string;
let itemId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'hvac' },
    create: { slug: 'hvac', name: 'HVAC', sortOrder: 20 },
    update: {},
  });
  categoryId = cat.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.attachment.deleteMany();
  await ctx.prisma.warranty.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.note.deleteMany();
  await ctx.prisma.item.deleteMany();
  // A user record is required because Attachment.uploadedById FKs to User.
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({
    data: { id: 'test-user', email: 'test@example.com', name: 'Test User' },
  });
  const item = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId } });
  itemId = item.id;
});

describe('Attachment CHECK constraint', () => {
  it('rejects an INSERT with all four FKs null', async () => {
    await expect(
      ctx.prisma.$executeRaw`
        INSERT INTO "Attachment"
          (id, filename, "mimeType", "sizeBytes", "storagePath", "uploadedById", "createdAt", "aiIndexable")
        VALUES
          ('a-1', 'x.pdf', 'application/pdf', 1, 'a-1/original.pdf', 'test-user', NOW(), true);
      `,
    ).rejects.toThrow(/Attachment_exactly_one_parent/);
  });

  it('rejects an INSERT with two FKs set', async () => {
    const w = await ctx.prisma.warranty.create({
      data: {
        itemId,
        provider: 'Acme',
        startsOn: new Date(),
        endsOn: new Date(Date.now() + 86_400_000),
      },
    });
    await expect(
      ctx.prisma.$executeRaw`
        INSERT INTO "Attachment"
          (id, filename, "mimeType", "sizeBytes", "storagePath", "uploadedById",
           "itemId", "warrantyId", "createdAt", "aiIndexable")
        VALUES
          ('a-2', 'x.pdf', 'application/pdf', 1, 'a-2/original.pdf', 'test-user',
           ${itemId}, ${w.id}, NOW(), true);
      `,
    ).rejects.toThrow(/Attachment_exactly_one_parent/);
  });

  it('accepts an INSERT with exactly one FK set', async () => {
    const a = await ctx.prisma.attachment.create({
      data: {
        filename: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        storagePath: 'placeholder/original.pdf',
        uploadedById: 'test-user',
        itemId,
      },
    });
    expect(a.itemId).toBe(itemId);
  });
});

describe('Attachment cascade', () => {
  it('cascade-deletes when the parent Item is hard-deleted', async () => {
    const a = await ctx.prisma.attachment.create({
      data: {
        filename: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
        storagePath: 'a/original.pdf',
        uploadedById: 'test-user',
        itemId,
      },
    });
    await ctx.prisma.item.delete({ where: { id: itemId } });
    const orphan = await ctx.prisma.attachment.findUnique({ where: { id: a.id } });
    expect(orphan).toBeNull();
  });

  it('cascade-deletes when the parent ServiceRecord is hard-deleted', async () => {
    const sr = await ctx.prisma.serviceRecord.create({
      data: { itemId, performedOn: new Date(), summary: 'tune-up' },
    });
    const a = await ctx.prisma.attachment.create({
      data: {
        filename: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
        storagePath: 'b/original.pdf',
        uploadedById: 'test-user',
        serviceRecordId: sr.id,
      },
    });
    await ctx.prisma.serviceRecord.delete({ where: { id: sr.id } });
    const orphan = await ctx.prisma.attachment.findUnique({ where: { id: a.id } });
    expect(orphan).toBeNull();
  });
});
```

- [ ] **Step 7: Run integration tests**

```bash
docker compose up -d db meilisearch
pnpm test:integration tests/integration/attachments.test.ts
```

Expected: 5/5 passing (3 CHECK + 2 cascade).

- [ ] **Step 8: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "feat(attachments): add data layer (schema, queries, actions, integration tests)"
```

---

## Task 5: Thumbnail worker job

**Files:**
- Create: `worker/jobs/thumbnail.ts`
- Create: `worker/jobs/thumbnail.test.ts`
- Create: `tests/fixtures/sample.jpg`
- Modify: `worker/index.ts`

- [ ] **Step 1: Add a JPEG fixture**

Drop a small (≤ 50 KB) real JPEG at `tests/fixtures/sample.jpg`. A photo of anything with a 480-pixel max dimension is fine. Verify with `file tests/fixtures/sample.jpg` — should report `JPEG image data`.

- [ ] **Step 2: Write the worker handler**

Create `worker/jobs/thumbnail.ts`:

```ts
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { atomicWrite, resolveStoragePath } from '@/lib/attachments/storage';

export type ThumbnailJob = { attachmentId: string };

export async function handleThumbnail(payload: ThumbnailJob): Promise<void> {
  const { attachmentId } = payload;
  const row = await prisma.attachment.findUnique({
    where: { id: attachmentId },
    select: { mimeType: true, storagePath: true, thumbnailPath: true },
  });
  if (!row) return;
  if (row.thumbnailPath) return; // idempotent
  if (!row.mimeType.startsWith('image/')) return;

  let buffer: Buffer;
  try {
    const abs = resolveStoragePath(env.FILES_DIR, row.storagePath);
    buffer = await readFile(abs);
  } catch (e) {
    console.error('[thumbnail] cannot read source', { attachmentId, error: (e as Error).message });
    return;
  }

  let resized: Buffer;
  try {
    resized = await sharp(buffer)
      .resize(480, 480, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch (e) {
    // sharp/libvips can fail on HEIC + corrupt files; log and bail without
    // throwing so pg-boss treats the job as done (no retry).
    console.error('[thumbnail] resize failed', {
      attachmentId,
      mimeType: row.mimeType,
      error: (e as Error).message,
    });
    return;
  }

  const rel = await atomicWrite(env.FILES_DIR, attachmentId, 'thumb.webp', resized);
  await prisma.attachment.update({
    where: { id: attachmentId },
    data: { thumbnailPath: rel },
  });
}
```

- [ ] **Step 3: Write the worker test**

Create `worker/jobs/thumbnail.test.ts`:

```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from '@/tests/integration/helpers';
import { handleThumbnail } from './thumbnail';

let ctx: IntegrationContext;
let categoryId: string;
let itemId: string;
let filesDir: string;
const originalFilesDir = process.env.FILES_DIR;

beforeAll(async () => {
  ctx = await setupIntegration();
  filesDir = await mkdtemp(`${tmpdir()}/files-`);
  process.env.FILES_DIR = filesDir;
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'hvac' },
    create: { slug: 'hvac', name: 'HVAC', sortOrder: 20 },
    update: {},
  });
  categoryId = cat.id;
}, 180_000);

afterAll(async () => {
  process.env.FILES_DIR = originalFilesDir;
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.attachment.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@example.com', name: 'U1' } });
  const item = await ctx.prisma.item.create({ data: { name: 'X', categoryId } });
  itemId = item.id;
});

describe('handleThumbnail', () => {
  it('produces a thumb.webp and updates thumbnailPath', async () => {
    const fixture = await readFile('tests/fixtures/sample.jpg');
    const id = 'attach-1';
    // Place the source where the worker will look for it.
    const { atomicWrite } = await import('@/lib/attachments/storage');
    await atomicWrite(filesDir, id, 'original.jpg', fixture);
    await ctx.prisma.attachment.create({
      data: {
        id,
        filename: 'sample.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: fixture.length,
        storagePath: `${id}/original.jpg`,
        uploadedById: 'u1',
        itemId,
      },
    });

    await handleThumbnail({ attachmentId: id });

    const row = await ctx.prisma.attachment.findUnique({ where: { id } });
    expect(row?.thumbnailPath).toBe(`${id}/thumb.webp`);
    const thumb = await readFile(`${filesDir}/${id}/thumb.webp`);
    expect(thumb.length).toBeGreaterThan(0);
  });

  it('is idempotent — second call is a no-op', async () => {
    const fixture = await readFile('tests/fixtures/sample.jpg');
    const id = 'attach-2';
    const { atomicWrite } = await import('@/lib/attachments/storage');
    await atomicWrite(filesDir, id, 'original.jpg', fixture);
    await ctx.prisma.attachment.create({
      data: {
        id,
        filename: 'sample.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: fixture.length,
        storagePath: `${id}/original.jpg`,
        uploadedById: 'u1',
        itemId,
      },
    });
    await handleThumbnail({ attachmentId: id });
    await handleThumbnail({ attachmentId: id }); // should not throw, should not re-encode
    const row = await ctx.prisma.attachment.findUnique({ where: { id } });
    expect(row?.thumbnailPath).toBe(`${id}/thumb.webp`);
  });
});
```

Run: `pnpm test:integration worker/jobs/thumbnail.test.ts`. Expected: 2/2 pass.

- [ ] **Step 4: Register the job in the worker**

Edit `worker/index.ts` to add the registration:

```ts
import { handleThumbnail, type ThumbnailJob } from './jobs/thumbnail';

// ...inside the existing pg-boss start sequence...
await pgBoss.work<ThumbnailJob>('thumbnail', { teamSize: 2 }, async (jobs) => {
  for (const j of jobs) {
    await handleThumbnail(j.data);
  }
});
```

(Adjust to match the existing worker file's pg-boss usage. Plan 1 set this up; mimic the local style.)

- [ ] **Step 5: Verify, commit**

```bash
pnpm verify
pnpm test:integration worker/jobs/thumbnail.test.ts
git add -A
git commit -m "feat(attachments): add thumbnail worker job"
```

---

## Task 6: File serving Route Handler

**Files:**
- Create: `app/api/files/[id]/route.ts`

- [ ] **Step 1: Implement the GET handler**

Create `app/api/files/[id]/route.ts`:

```ts
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { auth } from '@/lib/auth';
import { resolveStoragePath, openReadStream } from '@/lib/attachments/storage';
import { getAttachment } from '@/lib/attachments/queries';
import { env } from '@/lib/env';

type Params = Promise<{ id: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const session = await auth();
  if (!session?.user) return new Response('Unauthorized', { status: 401 });

  const { id } = await params;
  const row = await getAttachment(id);
  if (!row) return new Response('Not found', { status: 404 });

  const url = new URL(req.url);
  const wantThumb = url.searchParams.get('thumb') === '1';
  const relPath = wantThumb ? row.thumbnailPath : row.storagePath;
  if (!relPath) return new Response('Not found', { status: 404 });

  let absPath: string;
  try {
    absPath = resolveStoragePath(env.FILES_DIR, relPath);
  } catch {
    return new Response('Bad path', { status: 500 });
  }

  let size: number;
  try {
    const s = await stat(absPath);
    size = s.size;
  } catch {
    return new Response('Not found', { status: 404 });
  }

  const stream = openReadStream(absPath);
  const body = Readable.toWeb(stream) as ReadableStream;
  const headers = new Headers();
  headers.set('Content-Type', wantThumb ? 'image/webp' : row.mimeType);
  headers.set('Content-Length', String(size));
  // Percent-encode the user-supplied filename to prevent header injection.
  const safeName = encodeURIComponent(row.filename);
  headers.set('Content-Disposition', `inline; filename="${safeName}"`);
  headers.set('Cache-Control', 'private, max-age=300');

  return new Response(body, { status: 200, headers });
}
```

- [ ] **Step 2: Manual smoke (no automated test)**

Automated testing of streaming handlers in Next is awkward; rely on the e2e (Task 13) plus manual smoke:

```bash
# Assumes dev server running with mock OIDC (see Plan 2a Task 18 invocation).
# 1. Sign in via the browser.
# 2. Hit /api/files/<some-attachment-id> after Task 8 has wired the upload UI.
```

If you want an inline smoke test now: stand up the dev server, use the existing `signIn` helper from `tests/e2e/auth.ts` to log in, upload a file via Task 8's UI, then `curl --cookie ...` the `/api/files/<id>` endpoint and verify the bytes match.

- [ ] **Step 3: Verify, commit**

```bash
pnpm verify
pnpm build  # ensure the new route is registered
git add -A
git commit -m "feat(attachments): add authenticated file serving route"
```

---

## Task 7: Shared attachment components

**Files:**
- Create: `components/attachments/AttachmentUploader.tsx`
- Create: `components/attachments/AttachmentList.tsx`
- Create: `components/attachments/AttachmentCard.tsx`

This task is UI; no TDD — implement, then visually verify in Task 8.

- [ ] **Step 1: Implement `AttachmentCard.tsx`**

```tsx
import Link from 'next/link';
import { deleteAttachment } from '@/lib/attachments/actions';

export type AttachmentRow = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  thumbnailPath: string | null;
};

function AttachmentDeleteForm({ id }: { id: string }) {
  async function doDelete() {
    'use server';
    await deleteAttachment(id);
  }
  return (
    <form action={doDelete}>
      <button
        type="submit"
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          color: 'var(--danger)',
          font: 'inherit',
          fontSize: '0.85rem',
        }}
      >
        Delete
      </button>
    </form>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentCard({ a }: { a: AttachmentRow }) {
  const isImage = a.mimeType.startsWith('image/');
  const href = `/api/files/${a.id}`;
  const thumbHref = a.thumbnailPath ? `/api/files/${a.id}?thumb=1` : href;

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: '4px',
        padding: '0.5rem',
        background: 'var(--bg-elevated)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.4rem',
      }}
    >
      {isImage ? (
        <Link href={href} target="_blank">
          <img
            src={thumbHref}
            alt={a.filename}
            loading="lazy"
            style={{ width: '100%', height: 'auto', borderRadius: '3px' }}
          />
        </Link>
      ) : (
        <Link href={href} target="_blank" style={{ textDecoration: 'none' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '1rem 0',
            }}
          >
            <span style={{ fontSize: '1.5rem' }}>📄</span>
            <span style={{ wordBreak: 'break-word' }}>{a.filename}</span>
          </div>
        </Link>
      )}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: '0.8rem',
          color: 'var(--fg-muted)',
        }}
      >
        <span>{formatSize(a.sizeBytes)}</span>
        <AttachmentDeleteForm id={a.id} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Implement `AttachmentList.tsx`**

```tsx
import { AttachmentCard, type AttachmentRow } from './AttachmentCard';

export function AttachmentList({ attachments }: { attachments: AttachmentRow[] }) {
  if (attachments.length === 0) {
    return <p style={{ color: 'var(--fg-muted)' }}>No files yet.</p>;
  }
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
        gap: '0.75rem',
      }}
    >
      {attachments.map((a) => (
        <AttachmentCard key={a.id} a={a} />
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Implement `AttachmentUploader.tsx`**

```tsx
'use client';
import { useRef, useState, useTransition } from 'react';
import { uploadAttachment } from '@/lib/attachments/actions';
import type { ParentType } from '@/lib/attachments/schema';

type Status = { name: string; state: 'pending' | 'ok' | 'error'; error?: string };

type Props = {
  parentType: ParentType;
  parentId: string;
};

export function AttachmentUploader({ parentType, parentId }: Props) {
  const [pending, startTransition] = useTransition();
  const [items, setItems] = useState<Status[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setItems(files.map((f) => ({ name: f.name, state: 'pending' as const })));
    startTransition(async () => {
      const next: Status[] = [];
      for (const f of files) {
        const fd = new FormData();
        fd.set('parentType', parentType);
        fd.set('parentId', parentId);
        fd.set('file', f);
        const result = await uploadAttachment(fd);
        if (result.ok) {
          next.push({ name: f.name, state: 'ok' });
        } else {
          next.push({ name: f.name, state: 'error', error: result.formError ?? 'Upload failed' });
        }
        setItems([...next, ...files.slice(next.length).map((rest) => ({
          name: rest.name,
          state: 'pending' as const,
        }))]);
      }
      if (inputRef.current) inputRef.current.value = '';
    });
  }

  return (
    <div style={{ marginTop: '0.75rem' }}>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
        onChange={onChange}
        disabled={pending}
      />
      {items.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: '0.5rem' }}>
          {items.map((it) => (
            <li
              key={it.name}
              style={{
                fontSize: '0.85rem',
                color: it.state === 'error' ? 'var(--danger)' : 'var(--fg-muted)',
              }}
            >
              {it.state === 'pending' && '⏳ '}
              {it.state === 'ok' && '✓ '}
              {it.state === 'error' && '✗ '}
              {it.name}
              {it.error ? ` — ${it.error}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "feat(attachments): add shared Uploader, List, and Card components"
```

---

## Task 8: Item Files tab

**Files:**
- Modify: `components/items/ItemTabs.tsx`
- Modify: `lib/items/queries.ts`
- Modify: `app/(app)/items/[id]/page.tsx`

- [ ] **Step 1: Add `'files'` to `VALID_TABS`**

In `components/items/ItemTabs.tsx`, extend the `TabSlug` type and the tabs array to include `'files'` with label `Files`. Pattern matches the existing entries.

- [ ] **Step 2: Include attachments in `getItem`**

In `lib/items/queries.ts`, extend the `getItem` `include` to add:

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

- [ ] **Step 3: Render the Files tab**

In `app/(app)/items/[id]/page.tsx`, after the existing `tab === 'notes'` block, add:

```tsx
{tab === 'files' && (
  <div>
    <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
      <h2 style={{ fontSize: '1rem', margin: 0 }}>Files</h2>
    </header>
    <AttachmentList attachments={item.attachments} />
    <AttachmentUploader parentType="item" parentId={item.id} />
  </div>
)}
```

Add the necessary imports at the top of the file:

```tsx
import { AttachmentList } from '@/components/attachments/AttachmentList';
import { AttachmentUploader } from '@/components/attachments/AttachmentUploader';
```

Update the `VALID_TABS` constant in the page if it duplicates the one in `ItemTabs.tsx` (Plan 2a's Task 9 had it locally as well — match whatever shape currently exists).

- [ ] **Step 4: Verify, commit**

```bash
pnpm verify
pnpm build
git add -A
git commit -m "feat(items): add Files tab with attachment uploader and list"
```

---

## Task 9: Warranty detail page

**Files:**
- Create: `app/(app)/warranties/[id]/page.tsx`
- Modify: `lib/warranties/queries.ts` — `getWarranty` includes attachments + parent item info
- Modify: `components/warranties/WarrantyTable.tsx` — link rows to the new detail page

- [ ] **Step 1: Extend `getWarranty`**

In `lib/warranties/queries.ts`, ensure `getWarranty(id)` returns the warranty with `item: { select: { id, name } }` and `attachments` (same select shape as in Task 8).

- [ ] **Step 2: Implement the detail page**

Create `app/(app)/warranties/[id]/page.tsx`:

```tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AttachmentList } from '@/components/attachments/AttachmentList';
import { AttachmentUploader } from '@/components/attachments/AttachmentUploader';
import { WarrantyStatusBadge } from '@/components/warranties/WarrantyStatusBadge';
import { getWarranty } from '@/lib/warranties/queries';

const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

type Params = Promise<{ id: string }>;

export default async function WarrantyDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const warranty = await getWarranty(id);
  if (!warranty) notFound();

  return (
    <div>
      <header style={{ marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>{warranty.provider}</h1>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginTop: '0.25rem' }}>
          <WarrantyStatusBadge endsOn={warranty.endsOn} />
          {warranty.item && (
            <span style={{ fontSize: '0.85rem' }}>
              for <Link href={`/items/${warranty.item.id}`}>{warranty.item.name}</Link>
            </span>
          )}
        </div>
      </header>

      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.4rem 1.5rem', marginBottom: '1.5rem' }}>
        {warranty.policyNumber && (
          <>
            <dt style={{ fontWeight: 600 }}>Policy #</dt>
            <dd style={{ margin: 0 }}>{warranty.policyNumber}</dd>
          </>
        )}
        <dt style={{ fontWeight: 600 }}>Starts on</dt>
        <dd style={{ margin: 0 }}>{warranty.startsOn.toISOString().slice(0, 10)}</dd>
        <dt style={{ fontWeight: 600 }}>Ends on</dt>
        <dd style={{ margin: 0 }}>{warranty.endsOn.toISOString().slice(0, 10)}</dd>
        {warranty.cost != null && (
          <>
            <dt style={{ fontWeight: 600 }}>Cost</dt>
            <dd style={{ margin: 0 }}>{currencyFmt.format(warranty.cost.toNumber())}</dd>
          </>
        )}
      </dl>

      {warranty.coverage && (
        <section style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Coverage</h2>
          <p style={{ whiteSpace: 'pre-wrap' }}>{warranty.coverage}</p>
        </section>
      )}

      <section>
        <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Files</h2>
        <AttachmentList attachments={warranty.attachments} />
        <AttachmentUploader parentType="warranty" parentId={warranty.id} />
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Link rows from `WarrantyTable`**

In `components/warranties/WarrantyTable.tsx`, wrap the `provider` cell text in a `<Link href={`/warranties/${warranty.id}`}>` so users can navigate to the detail page.

- [ ] **Step 4: Verify, commit**

```bash
pnpm verify
pnpm build
git add -A
git commit -m "feat(warranties): add detail page with attachments"
```

---

## Task 10: ServiceRecord attachments section

**Files:**
- Modify: `lib/service-records/queries.ts` — `getServiceRecord` includes attachments
- Modify: `app/(app)/service/[id]/page.tsx` — append attachments section

- [ ] **Step 1: Extend `getServiceRecord`**

In `lib/service-records/queries.ts`, add `attachments` (same select shape as Task 8) to the `include` in `getServiceRecord`.

- [ ] **Step 2: Render the section**

In `app/(app)/service/[id]/page.tsx`, after the existing fields and before the closing `</div>`, add:

```tsx
import { AttachmentList } from '@/components/attachments/AttachmentList';
import { AttachmentUploader } from '@/components/attachments/AttachmentUploader';

// ...inside the page component, after the existing sections:
<section style={{ marginTop: '1.5rem' }}>
  <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Files</h2>
  <AttachmentList attachments={record.attachments} />
  <AttachmentUploader parentType="serviceRecord" parentId={record.id} />
</section>
```

- [ ] **Step 3: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "feat(service): add attachments section to detail page"
```

---

## Task 11: Note attachments section

**Files:**
- Modify: `lib/notes/queries.ts` — `getNote` includes attachments
- Modify: `app/(app)/notes/[id]/page.tsx` — append attachments section

- [ ] **Step 1: Extend `getNote`**

In `lib/notes/queries.ts`, add `attachments` (same select shape) to the `include`.

- [ ] **Step 2: Render the section**

In `app/(app)/notes/[id]/page.tsx`, after the markdown body, add:

```tsx
import { AttachmentList } from '@/components/attachments/AttachmentList';
import { AttachmentUploader } from '@/components/attachments/AttachmentUploader';

// ...after the existing rendered body:
<section style={{ marginTop: '1.5rem' }}>
  <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Files</h2>
  <AttachmentList attachments={note.attachments} />
  <AttachmentUploader parentType="note" parentId={note.id} />
</section>
```

- [ ] **Step 3: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "feat(notes): add attachments section to detail page"
```

---

## Task 12: Dashboard activity feed

**Files:**
- Modify: `lib/dashboard/queries.ts` — add `attachment-added` event type

- [ ] **Step 1: Extend `recentActivity`**

In `lib/dashboard/queries.ts`, extend the `ActivityEvent` union to include `'attachment-added'`. Add a fifth parallel query to `Promise.all` inside `recentActivity`:

```ts
prisma.attachment.findMany({
  orderBy: { createdAt: 'desc' },
  take: limit,
  select: {
    id: true,
    filename: true,
    createdAt: true,
    item: { select: { id: true, name: true } },
    warranty: { select: { id: true, provider: true } },
    serviceRecord: { select: { id: true, summary: true } },
    note: { select: { id: true, title: true } },
  },
}),
```

Then map each to an event:

```ts
...attachments.flatMap((a) => {
  if (a.item) {
    return [{
      kind: 'attachment-added' as const,
      occurredAt: a.createdAt,
      label: `Added ${a.filename} to ${a.item.name}`,
      href: `/items/${a.item.id}?tab=files`,
      icon: '📎',
    }];
  }
  if (a.warranty) {
    return [{
      kind: 'attachment-added' as const,
      occurredAt: a.createdAt,
      label: `Added ${a.filename} to warranty (${a.warranty.provider})`,
      href: `/warranties/${a.warranty.id}`,
      icon: '📎',
    }];
  }
  if (a.serviceRecord) {
    return [{
      kind: 'attachment-added' as const,
      occurredAt: a.createdAt,
      label: `Added ${a.filename} to service: ${a.serviceRecord.summary}`,
      href: `/service/${a.serviceRecord.id}`,
      icon: '📎',
    }];
  }
  if (a.note) {
    return [{
      kind: 'attachment-added' as const,
      occurredAt: a.createdAt,
      label: `Added ${a.filename} to note: ${a.note.title}`,
      href: `/notes/${a.note.id}`,
      icon: '📎',
    }];
  }
  return [];
}),
```

The CHECK constraint guarantees one of the four parents is set; the trailing `return []` is defensive only.

- [ ] **Step 2: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "feat(dashboard): show attachment-added events in recent activity"
```

---

## Task 13: E2E happy-path

**Files:**
- Create: `tests/e2e/attachments.spec.ts`

- [ ] **Step 1: Write the spec**

Create `tests/e2e/attachments.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { resetAuth, signIn } from './auth';

test.beforeEach(async () => {
  await resetAuth();
});

test('uploads a JPEG to an item, sees the thumbnail, deletes it', async ({ page, context }) => {
  await context.clearCookies();
  await signIn(page);

  // Create a fresh item (the JPEG fixture works against an empty DB).
  await page.goto('/items/new');
  await page.getByLabel('Name').fill('Furnace');
  await page.getByLabel('Category').selectOption('hvac');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+$/);

  // Switch to the Files tab.
  await page.getByRole('link', { name: 'Files' }).click();
  await expect(page.locator('text=No files yet')).toBeVisible();

  // Upload the fixture.
  await page.setInputFiles('input[type=file]', 'tests/fixtures/sample.jpg');
  await expect(page.locator('text=✓ sample.jpg')).toBeVisible({ timeout: 10_000 });

  // The thumbnail is generated by the worker. The dev server doesn't run
  // the worker; the test verifies the original loads even without a thumb.
  // (Image rendered via /api/files/<id>?thumb=1, which 404s, the <img>
  // onerror falls back to /api/files/<id>.)
  // We just confirm the page reflects the upload via the visible "Delete"
  // button on the new card.
  await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();

  // Delete the attachment.
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('text=No files yet')).toBeVisible();
});
```

- [ ] **Step 2: Run the spec locally**

```bash
# Mock OIDC + dev server already configured by globalSetup.
pnpm test:e2e tests/e2e/attachments.spec.ts
```

Expected: 1/1 passing.

- [ ] **Step 3: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "test(e2e): add attachments happy-path"
```

---

## Notes for the implementer

- **Lefthook pre-commit** runs Biome + tsc on every commit; expect ~3-5 second pause per commit.
- **Server Action signatures**: actions receive `unknown` (or `FormData`) from form posts. Always parse via Zod inside the action; never trust shape.
- **Decimal coercion**: this plan introduces no new Decimal columns, but Plan 2a's pattern (Server Component `.toNumber()` on render, explicit conversion at any Server→Client prop boundary) still applies if attachments later reference cost fields.
- **Search params in Next.js 15**: `searchParams` and `params` are Promises in App Router. Always `await`.
- **react-hook-form is not used here** — the uploader is a small Client Component with `useState` + `useTransition`; forms+RHF would be overkill for a single-input multi-file flow.
- **`execFileSync` not `execSync`** in test helpers — array args, no shell parsing.
- **No new env vars**, no new Compose services. `FILES_DIR` is already wired through `.env`, `docker-compose.yml`, and the runtime image.
- **Migration ordering**: Task 1's manually-edited migration is a one-time concern. After it's committed, downstream `prisma migrate deploy` runs in CI just replay the file as-is; no follow-up needed.
- **Worker test isolation**: `worker/jobs/thumbnail.test.ts` mutates `process.env.FILES_DIR`. Restore in `afterAll` to avoid bleeding into other test files run in the same Vitest worker.
- **Image element**: the project doesn't use `next/image`; native `<img>` is the convention (see ItemCardGrid). Stick with it for cards.
