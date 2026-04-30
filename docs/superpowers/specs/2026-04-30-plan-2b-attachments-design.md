# Plan 2b — Attachments

**Date:** 2026-04-30
**Status:** Draft for review
**Authors:** Oliver Wine (with Claude)
**Parent spec:** `docs/superpowers/specs/2026-04-26-house-manager-design.md`
**Builds on:** Plan 2a (CRUD) shipped 2026-04-29

## Overview

Plan 2b adds file attachments to the four entities that the original design earmarked: Item, Warranty, ServiceRecord, and Note. Users can upload images (jpg, png, webp, heic) and PDFs up to 25 MB per file, view them on the relevant detail page, download them through an authenticated route, and delete them. Image attachments get a WebP thumbnail generated asynchronously by the existing pg-boss worker so list views stay fast.

Plan 2b deliberately stops short of the AI-related processing (OCR, text extraction, Meilisearch sync) which is Plan 4 territory. The schema includes the forward-looking columns (`extractedText`, `indexedAt`, `aiIndexable`) so Plan 4 doesn't need a follow-up migration that touches every existing row.

## Goals

1. Make uploads work end-to-end on all four parent entities so the household can attach photos of serial plates, scanned manuals, service-call invoices, and policy documents.
2. Establish the post-upload background-processing pipeline (thumbnail today; OCR/embeddings later) without re-architecting it for Plan 4.
3. Keep the security floor solid: authenticated download, MIME magic-bytes verification, path-traversal guards, no plaintext filenames on disk.
4. Stay within the existing Plan 1 + 2a infrastructure: one new dependency (`sharp`) and an `apk add libvips` line in the Dockerfile.

## Non-goals

- OCR, PDF text extraction, embeddings, RAG — Plan 4.
- Meilisearch indexing of attachment text — Plan 4.
- Per-row ACLs (single-household app; any signed-in user can download any attachment).
- Inline PDF viewer — use the browser's built-in PDF rendering via download/`target="_blank"`.
- Versioning, rename, or move-to-different-parent — write-once, delete-replace if needed.
- Drag-and-drop upload — `<input type="file" multiple>` is enough for v1; drag-drop is Plan 5 polish.
- Office documents (`.docx`, `.xlsx`), text files, archives — strict allowlist.
- Antivirus scanning — out of scope for v1; revisit if multi-household sharing ever ships.
- Resumable / chunked uploads — single-shot `multipart/form-data` is fine at the 25 MB ceiling.

## Architecture

Inherits Plan 1's stack and Plan 2a's patterns:

- **Storage**: bind-mounted local volume at `FILES_DIR` (`/data/files` in production, `./data/files` in dev). Already in `docker-compose.yml` and `.env`.
- **Server**: Next.js Route Handler (`app/api/files/[id]/route.ts`) for streaming downloads; Server Actions for upload and delete.
- **Background**: pg-boss worker (already running for Plan 1) gets a new `thumbnail` job type.
- **Schema**: Prisma 7 + a single migration adding the `Attachment` model and a CHECK constraint via raw SQL.

New runtime dependency: **`sharp`** (image resizing). Native binary; multi-arch image builds already in CI.

New OS dependency in the Docker runtime stage: **`libvips`** with HEIC support (`apk add vips vips-heif` on Alpine).

## Data model

```prisma
model Attachment {
  id              String           @id @default(cuid())
  filename        String                                 // user-visible original name
  mimeType        String
  sizeBytes       Int
  storagePath     String                                 // relative to FILES_DIR; e.g. "<id>/original.pdf"

  // Exactly one of these four FKs is set; enforced by a DB CHECK constraint
  // added via raw SQL in the migration. See `Attachment_exactly_one_parent`.
  itemId          String?
  warrantyId      String?
  serviceRecordId String?
  noteId          String?
  item            Item?            @relation(fields: [itemId], references: [id], onDelete: Cascade)
  warranty        Warranty?        @relation(fields: [warrantyId], references: [id], onDelete: Cascade)
  serviceRecord   ServiceRecord?   @relation(fields: [serviceRecordId], references: [id], onDelete: Cascade)
  note            Note?            @relation(fields: [noteId], references: [id], onDelete: Cascade)

  uploadedById    String
  uploadedBy      User             @relation(fields: [uploadedById], references: [id])

  // Forward-looking — populated by Plan 4 (AI). Plan 2b leaves these null.
  thumbnailPath   String?                                // "<id>/thumb.webp" once worker generates it
  extractedText   String?          @db.Text              // OCR/PDF text; Plan 4
  indexedAt       DateTime?                              // Meilisearch sync timestamp; Plan 4
  aiIndexable     Boolean          @default(true)        // privacy escape hatch; Plan 4 honors

  createdAt       DateTime         @default(now())

  @@index([itemId])
  @@index([warrantyId])
  @@index([serviceRecordId])
  @@index([noteId])
}
```

CHECK constraint added in raw SQL after the Prisma-generated `CREATE TABLE`:

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

**Cascade choices**: all four parents use `onDelete: Cascade`. The file is meaningless without its parent, and `Cascade` is the only choice that preserves the CHECK invariant — `SetNull` on any one of the four would leave the row with all FKs null, violating `Attachment_exactly_one_parent`.

This diverges from the Plan 2a precedent on `ServiceRecord` (whose `itemId` / `vendorId` are `SetNull`). The audit/recovery story for orphaned-from-deleted-service-record attachments is weaker than vendor-side service history, and CHECK consistency wins.

## Storage layout

```
$FILES_DIR/
  <attachment-id>/
    original.<ext>      # the uploaded file; ext from validated MIME
    thumb.webp          # only after the worker runs (images only)
```

One directory per attachment lets us colocate the original, thumbnail, and any future Plan 4 artifacts (`extracted-text.txt`) without filename collisions, and lets us delete an attachment as a single `fs.rm(dir, { recursive: true })`.

The user-supplied filename is stored in the DB (`Attachment.filename`) and used in the `Content-Disposition` header on download. It never touches the filesystem — only `original.<ext>` does.

**Path safety**: `storagePath` is always relative; the serving code resolves it against `FILES_DIR` and verifies the resolved path stays under `FILES_DIR` (`path.relative(FILES_DIR, resolved)` must not start with `..`). Defense against any future bug that lets user input touch the path.

**Volume**: already provisioned (`docker-compose.yml`: `files:/data/files`). Backup is the existing `tar` of the volume in the original Operations section.

## Server actions

`lib/attachments/actions.ts`:

### `uploadAttachment(formData: FormData): Promise<ActionResult<{ id: string }>>`

One call per file (the multi-file uploader loops client-side).

1. `auth()` → `formError: 'Unauthorized'` on miss. Capture `uploadedById = session.user.id`.
2. Read `parentType` ∈ `{'item','warranty','serviceRecord','note'}` and `parentId` (cuid) from the form.
3. Read the `File`. Check `size <= 25_000_000` and `mimeType ∈ ALLOWED_MIME` (`image/jpeg`, `image/png`, `image/webp`, `image/heic`, `application/pdf`) — return `formError` on miss.
4. **Magic-bytes check**: read first ~12 bytes; verify the file's signature matches the claimed MIME. Use `file-type` package or a small inline check covering the five allowed types. Don't trust browser-provided `Content-Type`.
5. Validate the parent row exists (`prisma.<parent>.findUnique({ select: { id: true } })`) — `formError: 'Parent not found'` if missing.
6. `id = createId()` (cuid).
7. `await fs.mkdir(<FILES_DIR>/<id>, { recursive: true })`. Write the file via temp-file + atomic rename so a partial write doesn't leave a corrupt blob under a valid attachment row.
8. `prisma.attachment.create({ data: { id, ...meta, [parentFkName]: parentId, uploadedById } })`. If this fails, `await fs.rm(<FILES_DIR>/<id>, { recursive: true, force: true })` — leave no stray dirs.
9. If `mimeType` starts with `image/`: `await pgBoss.send('thumbnail', { attachmentId: id })`.
10. `revalidatePath` for the parent's detail page (and `/dashboard` so the activity feed refreshes).
11. Return `{ ok: true, data: { id } }`.

### `deleteAttachment(id: string): Promise<ActionResult>`

1. `auth()` check.
2. `prisma.attachment.findUnique({ where: { id } })` — `formError: 'Not found'` if missing. Capture parent type/id for revalidation.
3. `prisma.attachment.delete({ where: { id } })` — DB row first.
4. `await fs.rm(<FILES_DIR>/<id>, { recursive: true, force: true })`. If this fails, log; the periodic cleanup job (later, not in 2b) sweeps stray dirs.
5. `revalidatePath` for the parent's detail page.

### Why no `updateAttachment`

Filename and metadata are write-once. If a user wants different content, they delete and re-upload.

### Schema (`lib/attachments/schema.ts`)

Zod `uploadAttachmentSchema` validates `parentType` (enum) and `parentId` (cuid). The `File` blob is checked imperatively in the action — Zod doesn't model `File` naturally and we want explicit error paths for size / MIME / magic-bytes.

## File serving

Authenticated streaming via `app/api/files/[id]/route.ts` (Route Handler).

```
GET /api/files/<id>            → original
GET /api/files/<id>?thumb=1    → thumbnail (404 if not yet generated)
```

1. `await auth()` → 401 if no session. Single-household app: any signed-in user can download any attachment.
2. `prisma.attachment.findUnique({ where: { id }, select: { storagePath, mimeType, filename, thumbnailPath } })` → 404 if missing.
3. Resolve `path.resolve(FILES_DIR, isThumb ? row.thumbnailPath : row.storagePath)`. Verify it stays under `FILES_DIR` (`path.relative` not starting with `..`). 500 on miss.
4. `fs.stat` for `Content-Length`. If thumb requested but `thumbnailPath` is null OR file missing, 404 (UI falls back to the original).
5. Stream via `fs.createReadStream` wrapped in a `Response` body. Headers:
   - `Content-Type` = row.mimeType (or `image/webp` for thumb).
   - `Content-Length` = stat size.
   - `Content-Disposition: inline; filename="<encoded>"` — user-supplied `filename` percent-encoded to prevent header injection.
   - `Cache-Control: private, max-age=300` — short cache; signed-in pages re-validate.

### Why a Route Handler

Server Actions return data to React. We need to stream binary back with response headers — that's HTTP-level work the Route Handler is the right primitive for.

## Background processing

Worker job `thumbnail`, payload `{ attachmentId: string }`. Handler in `worker/jobs/thumbnail.ts`.

1. `prisma.attachment.findUnique` — no-op if missing or `thumbnailPath` already set (idempotent: same job firing twice is safe).
2. Skip if `mimeType` doesn't start with `image/`.
3. Read `<FILES_DIR>/<storagePath>` into a buffer.
4. `sharp(buffer).resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer()`.
5. Write to `<FILES_DIR>/<id>/thumb.webp` with the temp-file + atomic-rename pattern.
6. `prisma.attachment.update({ where: { id }, data: { thumbnailPath: '<id>/thumb.webp' } })`.

### pg-boss config

`pgBoss.work('thumbnail', { teamSize: 2 }, handleThumbnail)` in `worker/index.ts`. Default retry policy (3 retries, exponential backoff, dead-letter) is fine.

### Failure handling in the handler

The handler wraps the `sharp` resize in `try/catch`. On error:
1. Log with `attachmentId`, `mimeType`, and the underlying error message.
2. **Do not throw** — returning normally tells pg-boss the job succeeded so it doesn't retry indefinitely on a malformed file. The attachment row keeps `thumbnailPath = null`; the UI falls back to the original.
3. The job is "successful" from pg-boss's perspective but logged as a thumbnail failure — operators can grep logs to find broken HEIC files later.

This treats thumbnail failure as a degraded-but-acceptable outcome, not an upload failure. The user already has the file.

### HEIC handling

`sharp` v0.34 supports HEIC read via libvips when libvips is built with HEIC support. Alpine package `vips-heif` provides this. Add to the Dockerfile runtime stage. If HEIC turns out to be fragile in practice, the failure-handling path above kicks in: HEIC uploads succeed (file stored, original served), the thumbnail job logs and gives up. Documented as a known limitation; revisit in Plan 4 if it bites.

## UI integration

### Shared components (`components/attachments/`)

- **`AttachmentUploader.tsx`** (Client) — `<input type="file" multiple accept="image/*,.pdf">`, per-file progress list. Loops the file array client-side; calls `uploadAttachment` per file via `useTransition`. Per-file success/error inline.
  - Props: `parentType`, `parentId`.
- **`AttachmentList.tsx`** (Server) — grid of `<AttachmentCard>`s. Empty state CTA.
  - Props: `attachments`.
- **`AttachmentCard.tsx`** (Server) — single cell. Image vs PDF branch. Per-card delete `<form action={inlineDelete}>` (the `'use server'` wrapper pattern from Tasks 9 and 10 of Plan 2a).

### Per-entity surfaces

- **Item detail** (`app/(app)/items/[id]/page.tsx`): adds a fifth tab `Files`. Extend `VALID_TABS` and `ItemTabs`. `getItem()` query includes `attachments` (sorted `createdAt desc`).
- **Warranty detail** — Plan 2a doesn't have a Warranty detail page (only the table inside the Item detail's Warranties tab). Plan 2b adds `app/(app)/warranties/[id]/page.tsx` so attachments have a surface. Linked from the WarrantyTable. Includes the warranty fields, the attachment list, and the uploader.
- **ServiceRecord detail** (`app/(app)/service/[id]/page.tsx`): adds an attachment section after the existing fields. `getServiceRecord()` includes attachments.
- **Note detail** (`app/(app)/notes/[id]/page.tsx`): adds an attachment section after the markdown body. `getNote()` includes attachments.

### Empty / error states

- Empty list: "No files yet — drop a photo or PDF above" with the uploader rendered below.
- Per-file upload error inline next to the failed file ("Image too large", "Unsupported file type"); other files in the batch keep their state.

### Image rendering

`<img src={`/api/files/${id}?thumb=1`} loading="lazy">` with `onerror={...fallback to original at lower CSS size}`. PDFs render as a card with a `📄` icon, filename, and size; clicking opens `/api/files/${id}` in a new tab.

### Activity-feed integration

Dashboard `recentActivity` (in `lib/dashboard/queries.ts`) gets a fifth event type `attachment-added`. Query: top N most-recent attachments by `createdAt desc`, including a small parent join. Label: "Added <filename> to <parentName>" — link target is the parent's detail page (not the file directly), so clicks land on context.

**Known cardinality issue**: bulk uploads (e.g. 8 photos in one session) generate 8 events that can swamp the 10-row feed. Deduplication is deferred to Plan 5 (see "Open questions"). Plan 2b ships the simple per-attachment event; the existing "show last 10" cap self-throttles in the meantime.

## Security

- **AuthN**: every server action and route handler calls `auth()`; no anonymous access.
- **AuthZ**: single-household app — any signed-in user can read/write any attachment. Per-row ACLs deferred.
- **MIME**: strict allowlist + magic-bytes verification (don't trust browser).
- **Size**: 25 MB hard ceiling, checked before reading the full body into memory. Next.js Server Actions default to a 1 MB body limit; we raise it via `next.config.ts`'s `experimental.serverActions.bodySizeLimit: '25mb'` so the action accepts the upload, then enforce 25 MB explicitly in the action (defense in depth — the Next.js limit is a soft suggestion). The Route Handler (`app/api/files/[id]/route.ts`) is download-only and doesn't need a body-size config.
- **Path traversal**: storage paths are relative + verified-under-`FILES_DIR` on every read.
- **Header injection**: filename in `Content-Disposition` is percent-encoded.
- **CSRF**: Server Actions and same-origin Route Handler benefit from Next.js's built-in same-site cookie protection.
- **No execution**: served `Content-Type` is the validated MIME; the browser will not execute uploaded content. We do not serve `text/html`.

## Testing

### Unit tests (`lib/attachments/schema.test.ts`)

- Zod accepts valid `parentType` + `parentId`; rejects invalid combinations.

### Integration tests (`tests/integration/attachments.test.ts`)

- Round-trip via Prisma directly (matches Plan 2a convention of testing the data layer, not actions):
  - Insert with each parent type; confirm correct FK column populated.
  - **CHECK constraint**: insert with all four FK columns null → should reject (raw `prisma.$executeRaw` since the schema-typed insert won't allow it).
  - **CHECK constraint**: insert with two FK columns set → should reject.
  - Cascade: delete the parent Item / Warranty / Note → attachment row gone.
  - Cascade: delete the parent ServiceRecord → attachment row also gone (per the design refinement).
- File-system integration is exercised via a small isolated test that writes a known buffer to a temp `FILES_DIR` and reads it back through the storage helper. Don't try to exercise the full action (auth context isn't available in test harness).

### E2E (`tests/e2e/`)

**Required**, matching the Plan 2a Task 18 precedent. Add `tests/e2e/attachments.spec.ts` covering the upload + view + delete flow on the Item Files tab. Use a small (≤ 50 KB) JPEG fixture under `tests/fixtures/`. Sign-in uses the existing `signIn` helper; `resetAuth` runs in `beforeEach`. The test runs with `workers: 1` (already set in Plan 2a's `playwright.config.ts`) so it doesn't race the existing happy-path spec on shared DB state.

A separate per-entity E2E (Warranty, Note) is overkill for v1 — exercising the path on Item is enough regression coverage; the per-entity wiring is mostly identical and unit + integration tests cover the data layer.

### Worker test

`worker/jobs/thumbnail.test.ts` — given a fixture JPEG, run the handler against a temp `FILES_DIR`, verify a `thumb.webp` is produced and the DB row is updated. Use a small (50 KB) fixture JPEG checked into the repo under `tests/fixtures/`.

## Open questions

1. **HEIC robustness** — the library matrix (sharp + libvips + vips-heif on Alpine) has historically been quirky. We assume HEIC works; if the worker job consistently fails on HEIC payloads in CI, fallback is "skip thumbnail" with a logged warning and revisit in Plan 4.
2. **`extractedText` cap** — the column is `TEXT` (unbounded). For Plan 4 we may want a soft cap to avoid 50-page-PDF text blobs sitting in row data; not Plan 2b scope.
3. **Activity-feed cardinality** — adding `attachment-added` to the recent-activity feed could swamp it on bulk uploads. Mitigation: in the merge step, dedupe consecutive uploads to the same parent within a 5-minute window into a single "Added 8 files to Furnace" event. Defer this polish to Plan 5; current "show last 10" already self-throttles.

## Risks

- **Disk space**: 25 MB × N attachments grows quickly. Operations doc already covers `tar` backup; growth-monitoring is Plan 5 polish.
- **CHECK constraint + cascade interaction**: caught during design (see "Cascade choices" — all four use `Cascade` so the CHECK invariant is preserved across deletes). Worth re-verifying the migration includes both the FK constraints and the CHECK in the right order.
- **`sharp` native binary**: any future Node major upgrade requires an updated `sharp` build. Renovate already tracks it.
- **Worker availability**: if `pgBoss.send('thumbnail', ...)` fails (queue down), the upload action should still succeed — the user has uploaded the file. Treat queue failures as a logged warning, not a hard error. The `thumbnail` job will eventually retry from the durable queue once it's back.
