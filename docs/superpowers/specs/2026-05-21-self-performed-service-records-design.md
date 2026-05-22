# Vendorless / self-performed service records — Design

**Date:** 2026-05-21
**Status:** Approved (design)
**Branch:** `feat/self-performed-service-records` (off `main`)
**Scope:** Let users log self-performed work (no vendor) with a "Self-performed" marker, allow records with neither vendor nor target, and stage links + files inline during creation.

## Problem

A user wants to record work they did themselves — e.g. "washed the deck with product X" — keeping reference links/attachments for later. Today:
- `ServiceRecord.vendorId` is already optional, but the validity rule requires **vendor OR at least one target**, so a record with *neither* (the thing isn't a tracked item) is impossible.
- There's no way to mark a record as **self-performed** — the vendor column just shows a dash, indistinguishable from "forgot to set a vendor".
- Attachments + links are fully supported but only on the **detail page after creation**, so logging "did X + here's the product link" is a two-step flow.

## Decisions (from brainstorming)

- **Self-performed = a simple boolean toggle** (not freeform "performed by" text). Mutually exclusive with vendor.
- **Inline during creation: links AND files** (not links-only).
- **Minimum content rule: vendor OR target OR self-performed** (no fully bare records).
- No freeform performer text, no Products/Materials entity (product references are links/attachments).

## Data model

Add one column to `ServiceRecord` (prisma/schema.prisma):
```prisma
selfPerformed Boolean @default(false)
```
Single additive migration. (Eyeball the generated migration for unintended DROPs of manual pgvector indexes / XOR CHECK constraints, per the project's migration-drift caution — this one should be purely additive.)

## Schema + action (`lib/service-records/`)

`createServiceRecordSchema` / update schema:
- Add `selfPerformed: z.boolean().default(false)`.
- Replace the existing "vendor OR targets" refine with **"vendor OR at least one target OR selfPerformed"**.
- Add a refine: **`selfPerformed` and `vendorId` are mutually exclusive** (a self-performed record has no vendor). Message e.g. "A self-performed record can't also have a vendor."

`createServiceRecord` / `updateServiceRecord` actions: pass `selfPerformed` through to the Prisma create/update (it's part of the validated `...rest`). No redirect change — `createServiceRecord` already returns `{ ok: true, data: { id } }`, which the inline-attachment flow depends on.

**Partial-update caveat:** `updateServiceRecordSchema` is `.partial()`. Attach the two new refines (3-way minimum, and selfPerformed-XOR-vendor) *after* the `.partial()`/extend, and make the mutual-exclusivity refine fire **only when both `selfPerformed === true` and a non-empty `vendorId` are present** so partial edits that omit one field aren't wrongly rejected.

## Form (`components/service-records/ServiceRecordForm.tsx`)

### Self-performed toggle
- A **"Self-performed" `Switch`** adjacent to the vendor field. When **on**: clear `vendorId` and disable the `VendorAutocomplete` (visually communicate "no vendor — you did this"). When **off**: vendor autocomplete is enabled as today.
- The form's existing pre-flight "vendor or target" guard becomes "vendor or target or self-performed", mirroring the schema. Read `selfPerformed` from the **same form source** the schema validates (form state), not a divergent value, to avoid client/server mismatch.
- Edit forms hydrate `selfPerformed` from `defaultValues`. Add `selfPerformed?: boolean` to the form's `FormDefaults` type and pass it from the edit page's `defaultValues`.

### Inline attachment staging
- A new client field component **`PendingAttachmentsField`** (`components/service-records/PendingAttachmentsField.tsx`) that holds, in local state:
  - **files**: `File[]` (same limits as the existing uploader: 25 MB each; `image/jpeg,png,webp,heic` + `application/pdf`; client-side validates type/size before staging so obvious rejects are caught pre-submit),
  - **links**: `{ url: string; label?: string }[]` (URL must be http/https).
  - A removable pending list (files show name/size; links show label/host). **Nothing is uploaded yet** — there's no parent id during creation.
- The field exposes its staged data to the form's submit handler (via a ref/callback or controlled state owned by `ServiceRecordForm`).

### Submit flow (create path)
1. `createServiceRecord(payload)` → on success get `newId`.
2. For each staged **file**: build FormData (`parentType:'serviceRecord'`, `parentId:newId`, `file`) → `uploadAttachment(fd)`.
3. For each staged **link**: build FormData (`parentType:'serviceRecord'`, `parentId:newId`, `externalUrl`, optional `displayLabel`) → `addAttachmentLink(fd)`.
4. Collect failures. Then `router.push('/service/{newId}')`.
   - **Non-atomic by design:** the record is created before attachments. If any attachment call fails (bad magic bytes, >25 MB, transient), toast: "Record created — N attachment(s) failed; add them from the record page." and still navigate. The record is never lost; the detail page's existing `AttachmentUploader`/`AttachmentLinkForm` let the user retry. This is the accepted tradeoff for "files during creation" without temp-file staging.
- **Edit path:** `PendingAttachmentsField` is create-only (the edit/detail page already has the live uploader). On edit, staging is hidden; existing attachments are managed on the detail page as today.

These reuse the existing `uploadAttachment` / `addAttachmentLink` actions verbatim (both already accept `parentType:'serviceRecord'`).

## Display

- **List table** (`ServiceRecordTable.tsx`) vendor column: when `selfPerformed`, render a **"Self-performed" badge** instead of the vendor link / dash.
- **Detail page** (`app/(app)/service/[id]/page.tsx`) vendor area: same — show "Self-performed" where the vendor would render. Keep cost/notes/targets/attachments as-is.
- Queries: both `listServiceRecords` and `getServiceRecord` use Prisma `include` (no scalar `select`), so `selfPerformed` is returned automatically once the column exists — **no query edit needed**. The real change is **type-level**: add `selfPerformed: boolean` to the hand-written `ServiceRecordRow` type in `ServiceRecordTable.tsx` and pass it through from the `/service` list page. The detail page reads the inferred query type, so it picks up the field automatically.

## Surfacing / discoverability

- The "Self-performed" toggle next to "Vendor (optional)" makes vendorless logging obvious. Add brief helper text (e.g. under the toggle: "Logging work you did yourself? Turn this on and skip the vendor.").
- No nav changes.

## Testing

- **Schema** (`lib/service-records/schema.test.ts` or equivalent): vendor-only ✓, target-only ✓, self-performed-only ✓, none-of-the-three ✗, self-performed + vendor ✗, self-performed + target ✓.
- **Action** (integration): create a self-performed record with no vendor and no target; assert it persists with `selfPerformed: true`, `vendorId: null`.
- **PendingAttachmentsField** (component, jsdom): staging add/remove for links and files; client-side rejects an oversized/wrong-type file; exposes staged data.
- **e2e** (`tests/e2e/`): toggle Self-performed → vendor autocomplete clears/disables; create a self-performed record (no vendor/target) with one staged link → lands on detail page showing the **Self-performed badge** + the link. (File-upload e2e optional — magic-byte validation needs a real fixture; at minimum assert a staged link round-trips.)

## Out of scope (YAGNI)

- No freeform "performed by" text; no Products/Materials entity.
- No temp-file staging / atomic create+attach (accepted non-atomic flow with partial-failure toast).
- No change to the detail-page attachment UI (kept for post-create adds/edits).
