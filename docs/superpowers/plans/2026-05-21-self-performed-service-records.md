# Vendorless / Self-Performed Service Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users log self-performed work (no vendor) with a "Self-performed" marker, allow a record with neither vendor nor target, and stage links + files inline during creation.

**Architecture:** Add a `selfPerformed` boolean to `ServiceRecord` (one additive migration); relax the validity rule to "vendor OR target OR self-performed" and make self-performed mutually exclusive with vendor. The create form gains a Self-performed toggle and an inline attachment-staging field; on submit it creates the record (the action already returns the id), then associates staged files/links via the existing `uploadAttachment`/`addAttachmentLink` actions (non-atomic, with a partial-failure toast). Display shows a "Self-performed" badge in the table + detail page.

**Tech Stack:** Prisma, Zod, React Hook Form, Next.js server actions, Vitest + Testing Library (jsdom), Playwright e2e, Base UI / shadcn (`Switch`, `Badge`).

**Spec:** `docs/superpowers/specs/2026-05-21-self-performed-service-records-design.md`

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `prisma/schema.prisma` | add `selfPerformed Boolean @default(false)` to `ServiceRecord` | Modify |
| `prisma/migrations/<ts>_service_record_self_performed/` | generated migration | Create |
| `lib/service-records/schema.ts` | `selfPerformed` field + 3-way + XOR refines | Modify |
| `lib/service-records/schema.test.ts` | refine tests | Create/Modify |
| `lib/service-records/actions.ts` | pass `selfPerformed` through (mostly automatic via `...rest`) | Verify/Modify |
| `components/service-records/VendorAutocomplete.tsx` | add `disabled` prop (disable + clear) | Modify |
| `components/service-records/ServiceRecordForm.tsx` | Self-performed toggle, pre-flight guard, inline-attach submit | Modify |
| `components/service-records/PendingAttachmentsField.tsx` | stage files + links pre-create | Create |
| `components/service-records/PendingAttachmentsField.test.tsx` | staging behavior | Create |
| `components/service-records/ServiceRecordTable.tsx` | `ServiceRecordRow.selfPerformed` + badge | Modify |
| `app/(app)/service/page.tsx` | pass `selfPerformed` into table rows | Modify |
| `app/(app)/service/[id]/page.tsx` | Self-performed badge in vendor area | Modify |
| `app/(app)/service/[id]/edit/page.tsx` | pass `selfPerformed` in `defaultValues` | Modify |
| `tests/e2e/service-records.spec.ts` (or new) | self-performed + staged link e2e | Modify/Create |

Each task is a self-contained commit that compiles on its own.

---

## Task 1: Migration + schema refines

**Files:** `prisma/schema.prisma`, `lib/service-records/schema.ts`, `lib/service-records/schema.test.ts`

- [ ] **Step 1: Add the column to `prisma/schema.prisma`**

In the `ServiceRecord` model (near `cost`/`summary`), add:
```prisma
  selfPerformed   Boolean   @default(false)
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm prisma migrate dev --name service_record_self_performed`
(Requires `DATABASE_URL` in `.env` pointing at the dev DB; `migrate dev` also runs `prisma generate`.)
**Eyeball the generated SQL** in `prisma/migrations/<ts>_service_record_self_performed/migration.sql` — it MUST be a single additive `ALTER TABLE "service_records" ADD COLUMN "selfPerformed" BOOLEAN NOT NULL DEFAULT false;` with **no** DROP of manual pgvector indexes or XOR CHECK constraints (per the project's migration-drift caution). If it contains anything else, stop and report.

- [ ] **Step 3: Write failing schema tests**

In `lib/service-records/schema.test.ts` (create if absent; mirror other Zod test files):
```ts
import { describe, expect, it } from 'vitest';
import { createServiceRecordSchema, updateServiceRecordSchema } from './schema';

const base = { performedOn: '2026-05-01', summary: 'Washed deck' };

describe('createServiceRecordSchema — self-performed', () => {
  it.each([
    [{ ...base, targets: [], vendorId: 'v1' }, true], // vendor only
    [{ ...base, targets: [{ itemId: 'i1' }] }, true], // target only
    [{ ...base, targets: [], selfPerformed: true }, true], // self-performed only
    [{ ...base, targets: [] }, false], // none of the three
    [{ ...base, targets: [], selfPerformed: false }, false], // explicit none
    [{ ...base, targets: [], selfPerformed: true, vendorId: 'v1' }, false], // XOR violation
    [{ ...base, targets: [{ itemId: 'i1' }], selfPerformed: true }, true], // self + target ok
  ])('parses %j → success=%s', (input, ok) => {
    expect(createServiceRecordSchema.safeParse(input).success).toBe(ok);
  });

  it('defaults selfPerformed to false', () => {
    const r = createServiceRecordSchema.parse({ ...base, targets: [], vendorId: 'v1' });
    expect(r.selfPerformed).toBe(false);
  });
});

describe('updateServiceRecordSchema — partial tolerates omitted fields', () => {
  it('accepts a partial update that omits selfPerformed and vendor', () => {
    expect(
      updateServiceRecordSchema.safeParse({ id: 'sr1', summary: 'Edited' }).success,
    ).toBe(true);
  });
  it('rejects self-performed + vendor when both present in an update', () => {
    expect(
      updateServiceRecordSchema.safeParse({ id: 'sr1', selfPerformed: true, vendorId: 'v1' })
        .success,
    ).toBe(false);
  });
});
```

- [ ] **Step 4: Run, verify fail**

Run: `pnpm vitest run lib/service-records/schema.test.ts`
Expected: FAIL (`selfPerformed` unknown / refines absent).

- [ ] **Step 5: Implement schema changes in `lib/service-records/schema.ts`**

Add `selfPerformed` to the base object and replace the single refine. Note the XOR refine must only fire when **both** are truthy (so `.partial()` updates that omit one field pass):
```ts
const baseServiceRecordSchema = z.object({
  targets: serviceRecordTargetsSchema,
  vendorId: z.string().min(1).optional(),
  selfPerformed: z.boolean().default(false),
  performedOn: z.coerce.date(),
  cost: z.coerce.number().nonnegative().optional(),
  summary: z.string().min(1, 'Summary is required').max(200),
  notes: z.string().max(20_000).optional(),
});

function requireAnchor(
  v: {
    vendorId?: string;
    selfPerformed?: boolean;
    targets?: { itemId?: string | null; systemId?: string | null }[];
  },
  ctx: z.RefinementCtx,
) {
  const hasVendor = Boolean(v.vendorId);
  const hasTargets = Array.isArray(v.targets) && v.targets.length > 0;
  const isSelf = v.selfPerformed === true;
  if (!hasVendor && !hasTargets && !isSelf) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Pick a vendor, a self-performed marker, or at least one item/system',
      path: ['targets'],
    });
  }
  // Mutually exclusive — only when BOTH are explicitly present (partial-update safe).
  if (isSelf && hasVendor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A self-performed record can't also have a vendor",
      path: ['vendorId'],
    });
  }
}

export const createServiceRecordSchema = baseServiceRecordSchema.superRefine(requireAnchor);

export const updateServiceRecordSchema = baseServiceRecordSchema
  .partial()
  .extend({ id: z.string().min(1) })
  .superRefine((v, ctx) => {
    // On partial updates the "must have an anchor" rule can't be enforced (fields
    // may be omitted), but the XOR rule still applies when both are present.
    if (v.selfPerformed === true && Boolean(v.vendorId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A self-performed record can't also have a vendor",
        path: ['vendorId'],
      });
    }
  });
```

- [ ] **Step 6: Run, verify pass**

Run: `pnpm vitest run lib/service-records/schema.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm typecheck`
```bash
git add prisma/schema.prisma prisma/migrations lib/service-records/schema.ts lib/service-records/schema.test.ts
git commit -m "feat(service-records): selfPerformed column + vendor/target/self-performed validity rule"
```

---

## Task 2: Action pass-through + display badge

**Files:** `lib/service-records/actions.ts`, `components/service-records/ServiceRecordTable.tsx`, `app/(app)/service/page.tsx`, `app/(app)/service/[id]/page.tsx`

- [ ] **Step 1: Verify the create/update actions pass `selfPerformed`**

Read `lib/service-records/actions.ts`. The create action does `const { targets, ...rest } = data;` then `prisma.serviceRecord.create({ data: { ...rest, … } })` — so `selfPerformed` flows automatically once it's in the validated schema (Task 1). Confirm the same for the update action's spread. **No code change expected**; if either action explicitly enumerates fields (rather than `...rest`), add `selfPerformed`. Report what you found.

- [ ] **Step 2: Add `selfPerformed` to the table row type + badge**

In `components/service-records/ServiceRecordTable.tsx`:
- Add `selfPerformed: boolean;` to the `ServiceRecordRow` type.
- In the Vendor cell, render a badge when self-performed (takes priority over vendor/dash):
```tsx
<TableCell>
  {record.selfPerformed ? (
    <Badge variant="secondary">Self-performed</Badge>
  ) : record.vendor ? (
    <Link href={`/vendors/${record.vendor.id}`} className="underline underline-offset-2">
      {record.vendor.name}
    </Link>
  ) : (
    <span className="text-muted-foreground">—</span>
  )}
</TableCell>
```
Import `Badge` from `@/components/ui/badge`.

- [ ] **Step 3: Pass `selfPerformed` from the list page**

In `app/(app)/service/page.tsx`, find where it maps query rows into the `records` prop for `ServiceRecordTable`. The query uses Prisma `include` (no scalar `select`), so `selfPerformed` is present on the row — just include it in the mapped object (e.g. `selfPerformed: r.selfPerformed`). Read the file to find the exact mapping site.

- [ ] **Step 4: Detail-page badge**

In `app/(app)/service/[id]/page.tsx`, the vendor area currently renders `record.vendor && (…)`. Add a self-performed branch where the vendor would show:
```tsx
{record.selfPerformed ? (
  <Badge variant="secondary">Self-performed</Badge>
) : record.vendor ? (
  /* existing vendor link block */
) : null}
```
Match the existing label/layout around the vendor field (read the file; keep the existing "Vendor" label semantics — show the badge in that row). Import `Badge`.

- [ ] **Step 5: Typecheck + verify render**

Run: `pnpm typecheck`
Expected: clean. (No unit test for pure render here; covered by e2e in Task 5.)

- [ ] **Step 6: Commit**

```bash
git add lib/service-records/actions.ts components/service-records/ServiceRecordTable.tsx "app/(app)/service/page.tsx" "app/(app)/service/[id]/page.tsx"
git commit -m "feat(service-records): show Self-performed badge in list + detail"
```

---

## Task 3: Self-performed toggle in the form

**Files:** `components/service-records/VendorAutocomplete.tsx`, `components/service-records/ServiceRecordForm.tsx`, `app/(app)/service/[id]/edit/page.tsx`

- [ ] **Step 1: Add a `disabled` prop to `VendorAutocomplete`**

`VendorAutocomplete` manages its own `text` state via `useController`. Add an optional `disabled?: boolean` prop. When `disabled` is true: pass `disabled` to the `<Input>` and render empty text (the parent clears `vendorId` form value). Implementation: add `disabled` to `Props`, `disabled={disabled}` on `<Input>`, and `value={disabled ? '' : text}`.

- [ ] **Step 2: Add `selfPerformed` to the form**

In `ServiceRecordForm.tsx`:
- Add to the client `formSchema`: `selfPerformed: z.boolean().default(false),`.
- Add `selfPerformed?: boolean` to `FormDefaults`; set `selfPerformed: defaultValues?.selfPerformed ?? false` in `useForm` defaults.
- Render a `Switch` (from `@/components/ui/switch`) bound to the `selfPerformed` field, above or beside the vendor field, with a label "Self-performed" and helper text "Logging work you did yourself? Turn this on and skip the vendor." When toggled **on**, call `form.setValue('vendorId', undefined)`.
- Pass `disabled={form.watch('selfPerformed')}` to `<VendorAutocomplete .../>` and label the vendor field area so it reads as disabled when self-performed.
- Update the pre-flight guard:
```ts
const hasVendor = Boolean((formData as { vendorId?: string }).vendorId);
const isSelf = Boolean((formData as { selfPerformed?: boolean }).selfPerformed);
if (!hasVendor && !isSelf && targets.length === 0) {
  setTargetsError('Pick a vendor, a self-performed marker, or at least one item/system');
  return;
}
```
- The `payload` already spreads `formData`, so `selfPerformed` is included automatically.

- [ ] **Step 3: Pass `selfPerformed` in the edit page defaults**

In `app/(app)/service/[id]/edit/page.tsx`, add `selfPerformed: record.selfPerformed` to the `defaultValues` passed to `ServiceRecordForm`.

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm typecheck && pnpm exec biome check components/service-records/VendorAutocomplete.tsx components/service-records/ServiceRecordForm.tsx`
```bash
git add components/service-records/VendorAutocomplete.tsx components/service-records/ServiceRecordForm.tsx "app/(app)/service/[id]/edit/page.tsx"
git commit -m "feat(service-records): Self-performed toggle clears/disables vendor"
```

> No unit test here (form wiring is exercised by the Task 5 e2e). Keep the change minimal and idiomatic.

---

## Task 4: Inline attachment staging (links + files)

**Files:** `components/service-records/PendingAttachmentsField.tsx` (+ test), `components/service-records/ServiceRecordForm.tsx`

**Context:** During creation there's no parent id, so attachments can't be uploaded yet. `PendingAttachmentsField` stages files (`File[]`) and links (`{url, label?}[]`) in state and exposes them; after `createServiceRecord` returns the new id, the form loops them through the existing `uploadAttachment` / `addAttachmentLink` actions (FormData: `parentType:'serviceRecord'`, `parentId`, `file` / `externalUrl`+`displayLabel`). Limits mirror the live uploader: 25 MB; `image/jpeg,image/png,image/webp,image/heic,application/pdf`; http/https URLs.

- [ ] **Step 1: Write the failing component test `PendingAttachmentsField.test.tsx`**

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PendingAttachmentsField, type StagedAttachments } from './PendingAttachmentsField';

afterEach(() => cleanup());

function Harness() {
  let staged: StagedAttachments = { files: [], links: [] };
  return <PendingAttachmentsField onChange={(s) => { staged = s; }} expose={() => staged} />;
}

describe('PendingAttachmentsField', () => {
  it('adds and removes a link', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PendingAttachmentsField onChange={onChange} />);
    await user.type(screen.getByLabelText(/link url/i), 'https://example.com/paint');
    await user.type(screen.getByLabelText(/link label/i), 'Behr paint');
    await user.click(screen.getByRole('button', { name: /add link/i }));
    expect(screen.getByText('Behr paint')).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ links: [{ url: 'https://example.com/paint', label: 'Behr paint' }] }),
    );
    await user.click(screen.getByRole('button', { name: /remove behr paint/i }));
    expect(screen.queryByText('Behr paint')).not.toBeInTheDocument();
  });

  it('rejects a non-http link', async () => {
    const user = userEvent.setup();
    render(<PendingAttachmentsField onChange={vi.fn()} />);
    await user.type(screen.getByLabelText(/link url/i), 'ftp://nope');
    await user.click(screen.getByRole('button', { name: /add link/i }));
    expect(screen.getByText(/must start with http/i)).toBeInTheDocument();
    expect(screen.queryByText('ftp://nope')).not.toBeInTheDocument();
  });

  it('rejects an over-size or wrong-type file', async () => {
    const user = userEvent.setup();
    render(<PendingAttachmentsField onChange={vi.fn()} />);
    const bad = new File(['x'], 'note.txt', { type: 'text/plain' });
    await user.upload(screen.getByLabelText(/add files/i), bad);
    expect(screen.getByText(/unsupported file type/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm vitest run components/service-records/PendingAttachmentsField.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Implement `PendingAttachmentsField.tsx`**

A client component. Exports `type StagedAttachments = { files: File[]; links: { url: string; label?: string }[] }` and `PendingAttachmentsField({ onChange }: { onChange: (s: StagedAttachments) => void })`. It owns `files`/`links` state, validates on add (file: type in the allowed set + size ≤ 25_000_000; link: `/^https?:\/\//i`), shows inline errors, renders a removable pending list (file name+size, link label/url with a "Remove {label}" button), a file `<input type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,application/pdf">` labeled "Add files", and URL+label inputs with an "Add link" button. Calls `onChange` with the new state after every mutation. Use the constants from the existing uploader (`MAX_BYTES = 25_000_000`, the accept list) — define them locally to avoid importing server-only modules.

- [ ] **Step 4: Run, verify pass** — `pnpm vitest run components/service-records/PendingAttachmentsField.test.tsx` → PASS.

- [ ] **Step 5: Wire into `ServiceRecordForm` (create path only)**

- Import `uploadAttachment`, `addAttachmentLink` from `@/lib/attachments/actions` and `PendingAttachmentsField` + `StagedAttachments`.
- Hold `const [staged, setStaged] = useState<StagedAttachments>({ files: [], links: [] });`.
- Render `<PendingAttachmentsField onChange={setStaged} />` (only when NOT editing: `{!defaultValues?.id && …}` — the detail page handles attachments post-create for edits).
- In the submit success branch, **before** `router.push`, associate staged items against `result.data.id`:
```ts
const newId = result.data.id;
let failures = 0;
for (const file of staged.files) {
  const fd = new FormData();
  fd.set('parentType', 'serviceRecord');
  fd.set('parentId', newId);
  fd.set('file', file);
  const r = await uploadAttachment(fd);
  if (!r.ok) failures++;
}
for (const link of staged.links) {
  const fd = new FormData();
  fd.set('parentType', 'serviceRecord');
  fd.set('parentId', newId);
  fd.set('externalUrl', link.url);
  if (link.label) fd.set('displayLabel', link.label);
  const r = await addAttachmentLink(fd);
  if (!r.ok) failures++;
}
toast.success(isEdit ? 'Service record updated' : 'Service record created');
if (failures > 0) {
  toast.error(`${failures} attachment(s) failed — add them from the record page.`);
}
router.push(`/service/${newId}`);
```

- [ ] **Step 6: Typecheck + lint + commit**

Run: `pnpm typecheck && pnpm exec biome check components/service-records`
```bash
git add components/service-records/PendingAttachmentsField.tsx components/service-records/PendingAttachmentsField.test.tsx components/service-records/ServiceRecordForm.tsx
git commit -m "feat(service-records): stage links + files inline during create"
```

---

## Task 5: e2e + full-suite verification

**Files:** `tests/e2e/service-records.spec.ts` (extend; create if absent)

- [ ] **Step 1: Add a self-performed e2e**

Following the harness pattern in `tests/e2e/systems.spec.ts` / `service-records.spec.ts` (`resetAuth`, `signIn`):
```ts
test('self-performed record with a staged link: badge + link on detail', async ({ page, context }) => {
  await context.clearCookies();
  await signIn(page);
  await page.goto('/service/new');
  await page.getByLabel('Performed on').fill('2026-05-01');
  await page.getByLabel('Performed on').press('Tab');
  await page.getByLabel('Summary').fill('Washed the deck');
  // Self-performed: no vendor, no target.
  await page.getByLabel('Self-performed').click();
  // Stage a product link inline.
  await page.getByLabel(/link url/i).fill('https://example.com/deck-cleaner');
  await page.getByLabel(/link label/i).fill('Deck cleaner');
  await page.getByRole('button', { name: /add link/i }).click();
  await Promise.all([
    page.waitForURL(/\/service\/c[a-z0-9]+$/, { timeout: 60_000 }),
    page.getByRole('button', { name: 'Save record' }).click(),
  ]);
  await expect(page.getByText('Self-performed')).toBeVisible();
  await expect(page.getByText('Deck cleaner')).toBeVisible();
});
```
> Note: the targets picker is now collapsed-by-default (from #162). This test selects no targets, so no expand is needed. If you add a variant that selects a target, expand the Items section first (`page.getByRole('button', { name: /^Items/ }).click()`).

- [ ] **Step 2: Run the new e2e**

Run: `pnpm test:e2e:local tests/e2e/service-records.spec.ts`
Expected: PASS (incl. the new test and any pre-existing ones in the file).

- [ ] **Step 3: Full gate**

Run: `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration`
Expected: green. Integration is occasionally flaky under parallel testcontainer load — re-run any single failed file in isolation to confirm it's infra, not a regression.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/service-records.spec.ts
git commit -m "test(service-records): e2e for self-performed record + staged link"
```

---

## Notes & Risks

- **Migration:** must be a single additive column; eyeball for drift before committing. `migrate dev` needs a reachable dev DB via `.env`.
- **Non-atomic create-then-attach:** accepted tradeoff — the record commits before attachments; partial failures surface a toast and the user retries on the detail page. Never lose the record.
- **VendorAutocomplete clear:** its `useController` text doesn't auto-clear on `field.value = undefined`; the new `disabled` prop forces empty display. Verify the cleared vendor actually submits as undefined (so the XOR rule passes).
- **Edit path:** `PendingAttachmentsField` is create-only; editing uses the detail page's existing uploader. Don't render staging on edit.
- **Per-task commits are safe** — each task compiles independently.
