# Attachment links — Plan 2b extension

**Date:** 2026-04-30
**Status:** Draft for review
**Authors:** Oliver Wine (with Claude)
**Parent spec:** `docs/superpowers/specs/2026-04-30-plan-2b-attachments-design.md`
**Builds on:** Plan 2b (attachments) shipped 2026-04-30

## Overview

Extend the `Attachment` model so a row can be either an uploaded file (Plan 2b's only mode) **or** an external link (a URL pointing to a resource the user already stores elsewhere — Proton Drive, Google Drive, a manufacturer website, etc.). Same per-entity surfaces, same activity feed, same delete behavior; just a second authoring path that doesn't duplicate storage.

Use case: the user has a PDF manual on Proton Drive and wants to reference it from a Furnace item without uploading a copy. Today they have to upload (and pay storage twice). After this plan, they paste the share URL plus an optional label and the card shows up next to their uploaded files.

This plan is small (a single PR off main). It's a focused extension of Plan 2b; not its own multi-week initiative.

## Goals

1. Let users attach an external URL to any of the four parent entities (Item, Warranty, ServiceRecord, Note) with a single small form alongside the existing file picker.
2. Render link rows in the same `AttachmentList` grid as files, with a visual distinct enough that the user can tell at a glance which is which.
3. Forward-compatible with a future "Drive picker" (Proton Drive OAuth) integration: schema columns are in place so when the picker ships, no DB migration is needed.
4. Don't regress any Plan 2b behavior: file uploads, downloads, thumbnails, CHECK enforcement, cascade — all unchanged.

## Non-goals

- The Drive picker UX itself (separate plan; this plan just preps the schema).
- Favicon fetching, Open Graph image preview, or any third-party network call from our app to the linked resource.
- Click-tracking or visit count.
- Validating the URL is reachable. We trust the user; if the URL 404s, that's their problem.
- Migrating existing file attachments to link form (no use case).
- Renaming attachments. Same write-once policy as Plan 2b.

## User-resolved design choices

1. **Display label** — optional. If absent, render the URL's hostname (`drive.proton.me`).
2. **URL validation** — `http://` and `https://` only. Block `javascript:`, `data:`, `ftp:`, and other schemes.
3. **Card rendering** — plain text card with `🔗` icon + label-or-hostname + small URL line beneath. No favicon fetch, no OG-image preview.

## Schema

`prisma/schema.prisma` — modify `Attachment`:

```prisma
model Attachment {
  id              String         @id @default(cuid())

  // file-only columns; nullable now so link rows can omit them
  filename        String?
  mimeType        String?
  sizeBytes       Int?
  storagePath     String?

  // link-only columns; nullable; populated when externalUrl is set
  externalUrl        String?
  externalProvider   String?      // null for raw paste; future: "proton-drive", "google-drive", etc.
  externalProviderId String?      // null for raw paste; future: provider's file id (for refresh / re-auth)
  displayLabel       String?

  // unchanged from Plan 2b
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

`prisma/migrations/<timestamp>_add_attachment_links/migration.sql` — auto-generated, then manually appended:

```sql
ALTER TABLE "attachments" ALTER COLUMN "filename"    DROP NOT NULL;
ALTER TABLE "attachments" ALTER COLUMN "mimeType"    DROP NOT NULL;
ALTER TABLE "attachments" ALTER COLUMN "sizeBytes"   DROP NOT NULL;
ALTER TABLE "attachments" ALTER COLUMN "storagePath" DROP NOT NULL;

ALTER TABLE "attachments" ADD COLUMN "externalUrl"        TEXT;
ALTER TABLE "attachments" ADD COLUMN "externalProvider"   TEXT;
ALTER TABLE "attachments" ADD COLUMN "externalProviderId" TEXT;
ALTER TABLE "attachments" ADD COLUMN "displayLabel"       TEXT;

-- Existing CHECK on parent FKs is unchanged.

-- Exactly one of (storagePath, externalUrl) must be set.
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

**Existing rows** all have `storagePath` set; the new constraints hold for them. No data migration needed.

## Server actions

`lib/attachments/actions.ts` — adds one new action; existing `uploadAttachment` and `deleteAttachment` unchanged.

### `addAttachmentLink(formData: FormData): Promise<ActionResult<{ id: string }>>`

```
1. auth() → return { ok: false, formError: 'Unauthorized' } on miss.
2. Zod-parse with addAttachmentLinkSchema (parentType, parentId, externalUrl,
   displayLabel?, externalProvider?, externalProviderId?). The URL field uses
   .refine() to enforce http(s)-only.
3. Validate parent exists.
4. createId() for the new attachment row.
5. prisma.attachment.create({ data: {
     id, externalUrl, displayLabel: label || null, externalProvider: provider || null,
     externalProviderId: providerId || null, uploadedById, [parentFk]: parentId
   } })
6. Revalidate parent path + /dashboard.
7. Return { ok: true, data: { id } }.
```

No file write, no thumbnail enqueue. The `removeDir` call inside `deleteAttachment` operates with `force: true` and a non-existent dir is a no-op, so link deletion works without modification.

### Validation schema (`lib/attachments/schema.ts`)

```ts
const httpUrl = z
  .string()
  .url()
  .refine((s) => /^https?:\/\//i.test(s), 'URL must use http:// or https://');

export const addAttachmentLinkSchema = z.object({
  parentType: z.enum(PARENT_TYPES),
  parentId: z.string().min(1),
  externalUrl: httpUrl,
  displayLabel: z.string().max(200).optional().or(z.literal('')),
  externalProvider: z.string().max(50).optional(),
  externalProviderId: z.string().max(200).optional(),
});
```

The empty-string-to-null pattern at the action boundary mirrors HouseProfile's pattern from Plan 2a.

## File serving

The route handler at `app/api/files/[id]/route.ts` is **not modified**. Link rows have `storagePath: null`, so a request for `/api/files/<linkId>` will fall through to a 404 — appropriate, since there's nothing on our disk to serve. Clicking a link card uses `target="_blank"` directly to the `externalUrl`, bypassing our server entirely.

## UI changes

### `components/attachments/AttachmentLinkForm.tsx` (new, Client Component)

Compact two-input form:

```
[ Label (optional) ]   [ URL (required) ]   [ Add link ]
```

Calls `addAttachmentLink` action via `useTransition`. On success, resets the inputs. On failure, shows the action's `formError` inline.

### `components/attachments/AttachmentUploader.tsx` (modified)

Render the existing file-input UI, then a thin separator, then `<AttachmentLinkForm>`. Both pieces share the `parentType` + `parentId` props passed in by parent pages.

### `components/attachments/AttachmentCard.tsx` (modified)

Add a link branch ahead of the existing image/PDF branches. The `AttachmentRow` type expands to expose the new columns:

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

Branch logic:

```tsx
const isLink = a.externalUrl != null;
if (isLink) {
  return (
    <a href={a.externalUrl!} target="_blank" rel="noopener noreferrer" className="...">
      🔗 {a.displayLabel || new URL(a.externalUrl!).hostname}
      <span className="...">{a.externalUrl}</span>
      <DeleteForm id={a.id} />
    </a>
  );
}
// existing image/PDF logic unchanged
```

Same delete affordance as file rows; same card framing.

### Per-parent query updates

Each parent's `getXxx` query selects new fields on the `attachments` include:

```ts
attachments: {
  orderBy: { createdAt: 'desc' },
  select: {
    id: true,
    filename: true,
    mimeType: true,
    sizeBytes: true,
    storagePath: true,        // NEW — exposed for kind-detection
    thumbnailPath: true,
    externalUrl: true,        // NEW
    displayLabel: true,       // NEW
  },
},
```

Files modified: `lib/items/queries.ts` (`getItem`), `lib/warranties/queries.ts` (`getWarranty`), `lib/service-records/queries.ts` (`getServiceRecord`), `lib/notes/queries.ts` (`getNote`).

## Activity feed

`lib/dashboard/queries.ts` — `recentActivity` already maps the `attachment-added` event. Extend the event-construction so link rows produce a different label and icon while keeping the same `kind`:

```ts
const isLink = a.externalUrl != null;
const label = isLink
  ? `Linked ${a.displayLabel || new URL(a.externalUrl!).hostname} to ${parentName}`
  : `Added ${a.filename} to ${parentName}`;
const icon = isLink ? '🔗' : '📎';
```

The select shape on the parallel attachment query inside `recentActivity` adds `externalUrl, displayLabel` to the select.

## Security

- **`http(s)://` enforcement** prevents `javascript:` URI XSS. The `<a>` tag with a `javascript:` href would execute on click; the schema refuses to accept such a value.
- **`rel="noopener noreferrer"` + `target="_blank"`** prevents `window.opener` tabnabbing and stops Referer leakage to the external host.
- **Auth gate** — `addAttachmentLink` requires a session (same as `uploadAttachment`).
- **No SSRF surface** — our app never fetches the URL on the user's behalf in this plan. The link only crosses the wire when the user's browser navigates to it.

## Testing

### Unit (`lib/attachments/schema.test.ts`)

Extend with cases for `addAttachmentLinkSchema`:
- Accept `https://example.com/doc.pdf`
- Accept `http://192.168.1.10:8080/file.pdf` (self-hosted NAS use case)
- Reject `javascript:alert(1)`
- Reject `data:text/html,<script>`
- Reject `ftp://example.com/`
- Reject empty string
- Accept omitted `displayLabel`, `externalProvider`, `externalProviderId`

About 7 cases.

### Integration (`tests/integration/attachments.test.ts`)

Extend the existing CHECK constraint suite with:
- Reject INSERT with both `storagePath` AND `externalUrl` set.
- Reject INSERT with neither `storagePath` nor `externalUrl`.
- Accept INSERT with only `externalUrl` set (link row).
- Reject INSERT with `storagePath` set but `filename` NULL.
- Accept INSERT with `externalUrl` set and `filename` non-null (the future Drive picker scenario).
- Cascade test: insert a link row attached to an Item, delete the Item, link row gone.

About 6 cases.

### E2E (`tests/e2e/attachments.spec.ts`)

Extend the existing happy-path: after the file upload + delete sequence, add a link round-trip:
- Type a label and URL into the link form.
- Click "Add link".
- Assert a card appears with the label.
- Click Delete.
- Assert the empty state returns.

Single new test in the same spec file.

## Risks

- **Future Drive integration drifts the schema** — adding `externalProvider`/`externalProviderId` now anticipates one specific shape (provider name + provider's file id). If Proton Drive's API gives us a richer object (e.g. workspace id, share scope, expiry), we might wish we'd used a JSON column. Mitigation: easy to add later via a `externalMetadata Json?` column without affecting existing rows.
- **`new URL(externalUrl).hostname` throws** — if a malformed URL somehow lands in the DB (CHECK doesn't validate URL syntax, only schema in TS does), the AttachmentCard render would throw. Mitigation: the Zod schema rejects malformed URLs before insert; defense-in-depth would wrap the `new URL()` call in a try/catch and fall back to the raw URL string.
- **CHECK constraint replacement** — the migration adds two new CHECKs; if the migration is applied to a DB with existing pre-Plan-2b data (none in production, but worth noting), they could fail. We don't have prod data yet, so this is theoretical.
