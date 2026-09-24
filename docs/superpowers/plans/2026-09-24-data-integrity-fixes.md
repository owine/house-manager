# Data Integrity Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop four silent data-loss paths from the 2026-09 full review: deleting a drafted service record (or its attachment) destroys the inbound email's original invoice (Q-H4); `deleteAttachment` removes the wrong directory for inbound files (Q-M6); deleting a system silently orphans reminders, warranties and service records, with no confirmation (Q-H5); and AI-captured items/parts can't be saved from the edit form and lose `_provenance` on every edit (Q-H3).

**Architecture:** No schema change and no migration. Each fix lives at the one server-side choke point for its data, plus the UI that feeds it. (1) Attachment directories are derived from the stored paths, never recomputed from the id. (2) Email ownership: an attachment with `incomingEmailId` set belongs to the email and its `serviceRecordId` is only a link, so SR deletion detaches it first (the helper sits next to the existing shared hand-off helper) and `deleteAttachment` unlinks it instead of deleting it. (3) System delete runs as one transaction: it refuses when a REMINDER, warranty or unanchored service record would be left with zero targets, and it converts a sole-target CHORE to the standalone shape in place. A shadcn AlertDialog confirms every delete and shows the blocking list. (4) Reserved metadata keys are server-owned: forms strip them from their defaults, and `updateItem`/`updatePart` merge the stored ones back.

**Tech Stack:** TypeScript 7, Next.js 16 App Router (server actions, RSC pages), Prisma 7 / Postgres 18, Zod, react-hook-form, shadcn `base-nova` on `@base-ui/react` 1.8.0, Vitest 4 (+ Testcontainers, jsdom, Testing Library, axe), Playwright.

**Source findings:** `.full-review/01-quality-architecture.md` (Q-H3, Q-H4, Q-H5, Q-M6), with detail in `.full-review/01a-code-quality.md` (H3–H5) and `.full-review/01b-architecture.md` (H2, H4).

---

## Background the implementer needs

**Sequencing.** This is PR **C** of three.
- **PR A** (inbound-email security) merges first. It owns `app/api/files/[id]/route.ts`, `next.config.ts`, `lib/incoming-email/ingest.ts` (MIME sniffing, null filename/contentType), and the DMARC auto-stub gate. **Do not touch those files.**
- **PR B** (embeddings) merges after this one. It adds embedding tombstones to `deleteAttachment` and to the parent deletes. Keep the `deleteAttachment` edits here small, and don't restructure that function.
- You can start work before PR A lands, because no files overlap. Task 7 rebases onto `main` after PR A merges and re-checks one assumption about `ingest.ts` (see Task 7 Step 2).

**Findings verified against the code (2026-09-24, `main` @ `b7a87cd`):**
- **Q-H4 is correct.** `createServiceRecordForEmail` (`lib/incoming-email/create-service-record.ts:72-75`) sets `serviceRecordId` on rows that keep `incomingEmailId`. `Attachment.serviceRecord` and `Attachment.incomingEmail` are both `onDelete: Cascade` (`prisma/schema.prisma:522,524`). Both creation paths already go through this one helper: `createServiceRecordFromEmail` (`lib/incoming-email/actions.ts:265`) and `autoStub` (`worker/jobs/classify-incoming-email.ts:271`). Creation is therefore consistent, and the fix belongs on the **delete** side. There is **exactly one** code path that deletes a `ServiceRecord` (`lib/service-records/actions.ts:229`; grep `serviceRecord.delete`/`deleteMany` in `lib app worker` finds nothing else). No parent cascades a `ServiceRecord` row: `vendor` is `SetNull`, `ServiceRecordTarget` cascades only the *target rows*, and `IncomingEmail.createdServiceRecord` and `ReminderCompletion.createdServiceRecord` are `SetNull`. Nothing deletes an `IncomingEmail` either (no `incomingEmail.delete*` anywhere), so the reverse cascade (email delete wipes the SR's copy) can't happen today.
- **Q-M6 is correct, but narrower after Q-H4.** Uploads store `<attachmentId>/original.<ext>` (`lib/attachments/actions.ts:88`). The thumbnail worker writes `<attachmentId>/thumb.webp` (`worker/jobs/thumbnail.ts:54`). Inbound email stores `inbound/<xx>/<unrelatedCuid>/<name>` (`ingest.ts:66-73`). `deleteAttachment` runs `removeDir(FILES_DIR, id)` (`actions.ts:160`), which misses the inbound directory. After Task 2 no UI path fully deletes an inbound attachment: the inbox page has no delete button, and the SR page now unlinks. So the fix is mostly about robustness. **Latent hazard found:** `resolveStoragePath(dir, '')` resolves to `FILES_DIR` itself, so any "derive from dirname" fix has to refuse the root. Otherwise a directory-less `storagePath` would `rm -rf` every file.
- **Q-H5 is correct.** There are **two** system delete paths, `tryDeleteSystem` (`lib/systems/actions.ts:141-158`) and `deleteSystemWithParts` (`:194-263`). Both need the guard. The target tables cascade from `System` (`schema.prisma:267, 310, 581`, and `IncomingEmailTarget` at `:473`). `ReminderCompletion.target` is also `Cascade` (`:603`), so a deleted target row takes its completion history with it. No code path hard-deletes an `Item` or a `Part`, so a system is the only parent this can happen through.
- **Q-H5 edit-page fallback is correct.** `withDerivedNextDueOn` returns `null` only for a reminder with zero targets (`lib/reminders/queries.ts:22-30`). `ReminderForm` passes a `Date` default straight through `z.coerce.date()`, so the untouched `new Date()` instant reaches `updateReminder` and seeds new target rows (`lib/reminders/actions.ts:336-352`). The calendar-date guard then throws. The right fallback is today's **house day**: `startOfDayUtc(new Date(), await getHouseTimezone())`. That is what `updateReminder` itself uses as `houseToday`.
- **Q-H3 is correct, and it also loses data.** `_provenance` is written only by chat apply (`lib/chat/actions.ts:726-733, 1199, 1283`), and chat already preserves it on its own writes. The two edit forms carry it in the RHF value because only the uncontrolled textarea's `defaultValue` is filtered. The reviewer reproduced two failures: freeform items fail server-side, and freeform parts fail client-side (`createPartSchema.superRefine(refineMetadata)` via `zodResolver`). **Additional finding:** every *structured* category or kind schema is a plain `z.object` (e.g. `lib/categories.ts:34`, `lib/parts/kinds.ts:34`), which strips unknown keys. So `updateItem`/`updatePart` silently **drop** `_provenance` on every structured edit today. The server-side merge fixes both.

**Design decisions (double-check these):**
1. **Q-H4: unlink, not copy.** Copying would need a disk copy, new rows, and duplicated thumbnail/OCR/search/embedding work, and it would still leave an ownership rule to enforce. Unlinking is transactional, keeps one file on disk, and makes "re-draft after deleting the draft" work for free: `createServiceRecordForEmail` relinks every row with `serviceRecordId: null`. The FK stays `Cascade`. Changing it to `SetNull` would leave SR-only uploads as parentless rows.
2. **Q-H5 blocking rule for service records:** block only when the record would be left **unanchored**, meaning zero targets, no vendor, and `selfPerformed = false`. That is the app's own validity rule (`requireAnchor`, `lib/service-records/schema.ts:22-41`). Vendor-only records stay listed on `/service` and on the vendor page. REMINDERs and warranties block whenever this system is their only target (both schemas require `.min(1)` targets, and there is no `/warranties` list page).
3. **Q-H5 ordering:** blockers are checked **before** the parts prompt, so the user is never asked to archive parts only to be refused afterwards.
4. **Q-H5 chores:** a CHORE whose only target is the system becomes standalone **in place** (`systemId → NULL` on its one target row). This keeps `nextDueOn`, `lastCompletedOn` and the completion history, which a cascade-then-recreate would lose.
5. **Q-H5 UI:** every delete now opens the AlertDialog first, so a system with parts goes through two dialogs (confirm, then the archive/keep prompt). The vendor flow uses `Dialog`, not `AlertDialog`. `AlertDialog` is used here as instructed, and because `role="alertdialog"` with no outside-click dismiss suits an irreversible delete.
6. **Q-H3: strip in the forms, not the edit pages.** Both edit pages hand stored metadata to `ItemForm`/`PartForm`, and stripping there covers both pages plus any future caller. It is also testable with the existing "assert the SUBMITTED payload" harness (`ItemForm.test.tsx`, `PartForm.test.tsx`). The edit pages stay unchanged.

**Repo rules that apply to every task:**
- `pnpm`, never `npx`/`npm`. Run a single file with `pnpm exec vitest run <path>`. Integration tests need `docker compose up -d db meilisearch` running (Testcontainers starts its own Postgres and Meili, but the Docker daemon must be up).
- Never `--no-verify`. After **every** `git commit`, run `git log --oneline -1` and confirm HEAD moved. The Biome pre-commit hook can fail silently.
- Stage explicit paths only (`git add <paths>`), never `-A` or `.`.
- Run `pnpm lint:fix` before any commit that adds or changes an import. Biome enforces import and specifier ordering (e.g. `import { prisma, type TransactionClient } from '@/lib/db'`), and a hand-written order may be rejected.
- Server actions follow the skeleton in `CLAUDE.md`: `auth()` first, never throw, return `ActionResult` or a bespoke union. Enqueues are never fatal.
- Calendar dates vs instants: `nextDueOn`, `performedOn`, `startsOn`, `endsOn` are `@db.Date`. Never write `new Date()` into one. In tests use `todayCal()`/`calDaysOut()` from `tests/integration/helpers.ts`.
- Integration tests dynamic-import the module under test **after** `setupIntegration()`, because `lib/db` builds its Prisma singleton from `DATABASE_URL` at import time.
- Don't use git worktrees in this repo (knip hangs on pre-push, and there is no `.env`). Work in the main checkout.

## File structure

| File | Responsibility |
|---|---|
| `lib/attachments/storage.ts` *(modify)* | New `attachmentStorageDirs()` derives the directories from the stored paths. `removeDir` refuses `FILES_DIR` itself. |
| `lib/attachments/storage.test.ts` *(modify)* | Unit tests for both. |
| `lib/attachments/actions.ts` *(modify)* | `deleteAttachment`: removes the derived dirs (Q-M6), and unlinks email-owned SR-linked rows instead of deleting them (Q-H4). |
| `lib/incoming-email/create-service-record.ts` *(modify)* | New `detachEmailOwnedAttachments(tx, srId)`, the inverse of the existing hand-off. |
| `lib/service-records/actions.ts` *(modify)* | `deleteServiceRecord` detaches email-owned attachments in the same transaction as the delete. |
| `tests/integration/attachment-ownership.test.ts` *(create)* | Q-M6 + Q-H4 end to end against real Postgres and a temp `FILES_DIR`. |
| `tests/unit/lib/search-index-drift.test.ts` *(modify)* | Correct the stale exemption reason for `create-service-record.ts`. |
| `lib/systems/actions.ts` *(modify)* | `findSystemDeleteBlockers`, `detachSoleTargetChores`, `SystemDependentSummary`, and a new `hasDependents` arm on both delete results. |
| `tests/integration/system-delete-dependents.test.ts` *(create)* | Q-H5 server behavior. |
| `components/ui/alert-dialog.tsx` *(create via shadcn CLI)* | base-nova AlertDialog primitive. |
| `components/systems/DeleteSystemButton.tsx` *(modify)* | Confirm-first flow and the blocking list. |
| `components/systems/DeleteSystemButton.test.tsx` *(create)* | jsdom tests for the flow, plus an axe scan. |
| `components/systems/DeleteSystemPartsDialog.tsx` *(modify)* | Accepts the new `hasDependents` result arm. |
| `app/(app)/systems/[id]/page.tsx` *(modify)* | Passes `hasDependents` through the injected actions. |
| `tests/e2e/parts.spec.ts` *(modify)* | Clicks the new confirm step before the parts prompt. |
| `app/(app)/reminders/[id]/edit/page.tsx` *(modify)* | House-day fallback for a target-less reminder. |
| `app/(app)/reminders/[id]/edit/page.test.tsx` *(create)* | Pins the fallback. |
| `lib/metadata/reserved-keys.ts` *(modify)* | `stripReservedMetadata`, `withStoredReservedMetadata`. |
| `lib/metadata/reserved-keys.test.ts` *(modify)* | Unit tests. |
| `components/items/ItemForm.tsx`, `components/parts/PartForm.tsx` *(modify)* | Strip reserved keys from the RHF defaults. |
| `components/items/ItemForm.test.tsx`, `components/parts/PartForm.test.tsx` *(modify)* | Submitted-payload tests. |
| `lib/items/actions.ts`, `lib/parts/actions.ts` *(modify)* | Merge the stored reserved keys back on update. |
| `tests/integration/metadata-provenance-preserved.test.ts` *(create)* | Q-H3 server behavior. |
| `lib/chat/actions.ts` *(modify, comment only)* | Correct the false "#328 cannot recur" claim (`:1196-1199`). |

---

### Task 0: Branch

- [ ] **Step 1: Start from a clean, current `main`**

```bash
git checkout main
git pull --ff-only
git status --short          # expect: empty
git checkout -b fix/data-integrity
docker compose up -d db meilisearch
```

---

### Task 1: Q-M6 — delete the directory the file actually lives in

**Files:**
- Modify: `lib/attachments/storage.ts:40-44` (`removeDir`), plus a new export
- Modify: `lib/attachments/storage.test.ts`
- Modify: `lib/attachments/actions.ts:13` (import), `:141-172` (`deleteAttachment`)
- Create: `tests/integration/attachment-ownership.test.ts`

- [ ] **Step 1: Write the failing unit tests**

In `lib/attachments/storage.test.ts`, replace the first two import lines:

```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { atomicWrite, removeDir, resolveStoragePath } from './storage';
```

with:

```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { atomicWrite, attachmentStorageDirs, removeDir, resolveStoragePath } from './storage';
```

and append at the end of the file:

```ts
describe('attachmentStorageDirs', () => {
  it('returns the upload directory once when original and thumbnail share it', () => {
    expect(
      attachmentStorageDirs({ storagePath: 'att1/original.pdf', thumbnailPath: 'att1/thumb.webp' }),
    ).toEqual(['att1']);
  });

  // The Q-M6 bug: ingest.ts lays inbound files out under a cuid that is NOT the
  // attachment id, so recomputing the directory from the id misses it.
  it('returns the inbound directory, not one named after the attachment id', () => {
    expect(
      attachmentStorageDirs({ storagePath: 'inbound/ab/cxyz/invoice.pdf', thumbnailPath: null }),
    ).toEqual(['inbound/ab/cxyz']);
  });

  it('returns both directories when the thumbnail lives apart from the original', () => {
    expect(
      attachmentStorageDirs({
        storagePath: 'inbound/ab/cxyz/photo.jpg',
        thumbnailPath: 'att1/thumb.webp',
      }),
    ).toEqual(['inbound/ab/cxyz', 'att1']);
  });

  it('returns nothing for an external link', () => {
    expect(attachmentStorageDirs({ storagePath: null, thumbnailPath: null })).toEqual([]);
  });

  // dirname('loose.pdf') is '.', i.e. FILES_DIR itself. Returning it would
  // rm -rf every attachment in the house.
  it('never returns FILES_DIR itself for a path with no directory', () => {
    expect(attachmentStorageDirs({ storagePath: 'loose.pdf', thumbnailPath: null })).toEqual([]);
  });
});

describe('removeDir', () => {
  it('refuses to remove FILES_DIR itself', async () => {
    const root = await mkdtemp(`${tmpdir()}/storage-test-`);
    await writeFile(`${root}/sentinel`, 'keep');

    await expect(removeDir(root, '')).rejects.toThrow(/FILES_DIR itself/);
    await expect(removeDir(root, '.')).rejects.toThrow(/FILES_DIR itself/);

    expect((await readFile(`${root}/sentinel`)).toString()).toBe('keep');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm exec vitest run lib/attachments/storage.test.ts
```

Expected: FAIL. `attachmentStorageDirs` is not exported, so its describe block errors with `attachmentStorageDirs is not a function`. The `removeDir` test fails because today `removeDir(root, '')` resolves without throwing and deletes the temp root, sentinel included.

- [ ] **Step 3: Implement in `lib/attachments/storage.ts`**

Replace:

```ts
/** Recursive remove of FILES_DIR/<dir>. Idempotent. */
export async function removeDir(filesDir: string, dir: string): Promise<void> {
  const abs = resolveStoragePath(filesDir, dir);
  await rm(abs, { recursive: true, force: true });
}
```

with:

```ts
/**
 * Recursive remove of FILES_DIR/<dir>. Idempotent.
 *
 * Refuses FILES_DIR itself: `resolveStoragePath` accepts '' and '.' (they do
 * not escape the root, they ARE the root), and a recursive remove of the root
 * would take every stored file with it.
 */
export async function removeDir(filesDir: string, dir: string): Promise<void> {
  const abs = resolveStoragePath(filesDir, dir);
  if (path.relative(filesDir, abs) === '') {
    throw new Error(`refusing to remove FILES_DIR itself (dir: ${JSON.stringify(dir)})`);
  }
  await rm(abs, { recursive: true, force: true });
}

/**
 * The directories an attachment's files live in, relative to FILES_DIR.
 *
 * Derived from the STORED paths, never recomputed from the attachment id,
 * because the writers disagree on layout:
 *   - upload:    `<attachmentId>/original.<ext>`   (lib/attachments/actions.ts)
 *   - thumbnail: `<attachmentId>/thumb.webp`       (worker/jobs/thumbnail.ts)
 *   - inbound:   `inbound/<xx>/<cuid>/<name>`      (lib/incoming-email/ingest.ts)
 *                with a cuid unrelated to the row id
 * Each of those directories holds exactly one attachment's files, which is
 * what makes removing the whole directory safe. A path with no directory
 * component yields nothing: its dirname is FILES_DIR itself.
 */
export function attachmentStorageDirs(paths: {
  storagePath: string | null;
  thumbnailPath: string | null;
}): string[] {
  const dirs = new Set<string>();
  for (const p of [paths.storagePath, paths.thumbnailPath]) {
    if (!p) continue;
    const dir = path.dirname(p);
    if (dir === '.' || dir === '' || path.isAbsolute(dir)) continue;
    dirs.add(dir);
  }
  return [...dirs];
}
```

(`path` is already imported at the top of `storage.ts`.)

- [ ] **Step 4: Run the unit tests and confirm they pass**

```bash
pnpm exec vitest run lib/attachments/storage.test.ts
```

Expected: PASS (all `resolveStoragePath`, `atomicWrite + removeDir`, `attachmentStorageDirs`, `removeDir` cases).

- [ ] **Step 5: Write the failing integration test**

Create `tests/integration/attachment-ownership.test.ts`:

```ts
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createId } from '@paralleldrive/cuid2';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWrite } from '@/lib/attachments/storage';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'u1', name: 'Test' } })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Only FILES_DIR is read on these paths (same narrowing as part-attachments.test.ts).
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ FILES_DIR: process.env.FILES_DIR }),
}));

vi.mock('@/lib/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/queue')>();
  return { ...orig, getBoss: vi.fn(async () => ({ send: vi.fn(async () => 'fake-job-id') })) };
});

const searchCalls: { kind: string; id: string; op: string }[] = [];
vi.mock('@/lib/search/client', () => ({
  enqueueSearchIndex: vi.fn(async (kind: string, id: string, op: string) => {
    searchCalls.push({ kind, id, op });
  }),
}));
vi.mock('@/lib/embedding/enqueue', () => ({ enqueueEmbed: vi.fn(async () => {}) }));

let ctx: IntegrationContext;
let attachments: typeof import('@/lib/attachments/actions');
let filesDir: string;
const originalFilesDir = process.env.FILES_DIR;

beforeAll(async () => {
  ctx = await setupIntegration();
  filesDir = await mkdtemp(`${tmpdir()}/attachment-ownership-`);
  process.env.FILES_DIR = filesDir;
  attachments = await import('@/lib/attachments/actions');
}, 180_000);

afterAll(async () => {
  process.env.FILES_DIR = originalFilesDir;
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  searchCalls.length = 0;
  await ctx.prisma.attachment.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.incomingEmail.deleteMany();
  await ctx.prisma.part.deleteMany();
  await ctx.prisma.vendor.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@example.com', name: 'U1' } });
});

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function makeEmail(vendorId: string | null = null) {
  return ctx.prisma.incomingEmail.create({
    data: {
      messageId: `<${createId()}@example.com>`,
      fromAddress: 'billing@acme.example',
      subject: 'Invoice #1042',
      receivedAt: new Date('2026-05-01T12:00:00Z'),
      headersJson: {},
      vendorId,
    },
  });
}

/** Mirrors ingest.ts's layout: one `inbound/<xx>/<cuid>` directory per file. */
async function seedInboundAttachment(incomingEmailId: string) {
  const cuid = createId();
  const dirRel = `inbound/${cuid.slice(0, 2)}/${cuid}`;
  const storagePath = await atomicWrite(
    filesDir,
    dirRel,
    'invoice.pdf',
    Buffer.from('%PDF-1.4 test'),
  );
  const attachment = await ctx.prisma.attachment.create({
    data: {
      incomingEmailId,
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 13,
      storagePath,
      uploadedById: 'u1',
    },
  });
  return {
    attachment,
    fileAbs: join(filesDir, storagePath),
    dirAbs: join(filesDir, dirRel),
  };
}

describe('deleteAttachment removes the directory the file actually lives in', () => {
  it("removes an inbound attachment's inbound/<xx>/<cuid> directory", async () => {
    const email = await makeEmail();
    const { attachment, dirAbs } = await seedInboundAttachment(email.id);

    const r = await attachments.deleteAttachment(attachment.id);

    expect(r).toEqual({ ok: true, data: undefined });
    expect(await ctx.prisma.attachment.findUnique({ where: { id: attachment.id } })).toBeNull();
    expect(await exists(dirAbs)).toBe(false);
    expect(searchCalls).toContainEqual({ kind: 'attachment', id: attachment.id, op: 'delete' });
  });

  it("still removes an uploaded attachment's <id> directory, thumbnail included", async () => {
    const part = await ctx.prisma.part.create({ data: { name: 'Anode rod', kind: 'OTHER' } });
    const id = createId();
    const storagePath = await atomicWrite(filesDir, id, 'original.jpg', Buffer.from('jpg'));
    const thumbnailPath = await atomicWrite(filesDir, id, 'thumb.webp', Buffer.from('webp'));
    await ctx.prisma.attachment.create({
      data: {
        id,
        partId: part.id,
        filename: 'anode.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 3,
        storagePath,
        thumbnailPath,
        uploadedById: 'u1',
      },
    });

    const r = await attachments.deleteAttachment(id);

    expect(r.ok).toBe(true);
    expect(await exists(join(filesDir, id))).toBe(false);
  });
});
```

- [ ] **Step 6: Run it and confirm the inbound case fails**

```bash
pnpm exec vitest run tests/integration/attachment-ownership.test.ts
```

Expected: the inbound test FAILS on `expect(await exists(dirAbs)).toBe(false)` (received `true`), because `removeDir(FILES_DIR, id)` removed a nonexistent `<attachmentId>` directory. The upload test passes and guards against regressions.

- [ ] **Step 7: Implement in `deleteAttachment`**

In `lib/attachments/actions.ts`, change the storage import (line 13):

```ts
import { atomicWrite, removeDir } from './storage';
```

to:

```ts
import { atomicWrite, attachmentStorageDirs, removeDir } from './storage';
```

In `deleteAttachment`, replace the `select` and the removal:

```ts
    select: {
      itemId: true,
      warrantyId: true,
      serviceRecordId: true,
      noteId: true,
      partId: true,
    },
  });
  if (!row) return { ok: false, formError: 'Not found' };

  await prisma.attachment.delete({ where: { id } });
  await enqueueSearchIndex('attachment', id, 'delete');
  await removeDir(env.FILES_DIR, id).catch((e) => {
    logger.error({ err: e }, 'failed to remove storage dir');
  });
```

with:

```ts
    select: {
      itemId: true,
      warrantyId: true,
      serviceRecordId: true,
      noteId: true,
      partId: true,
      storagePath: true,
      thumbnailPath: true,
    },
  });
  if (!row) return { ok: false, formError: 'Not found' };

  await prisma.attachment.delete({ where: { id } });
  await enqueueSearchIndex('attachment', id, 'delete');
  // Directories come from the stored paths, not the id — inbound files live
  // under `inbound/<xx>/<cuid>/`, so `removeDir(FILES_DIR, id)` left them on
  // disk. removeDir re-checks each one against FILES_DIR.
  for (const dir of attachmentStorageDirs(row)) {
    await removeDir(env.FILES_DIR, dir).catch((e) => {
      logger.error({ err: e, dir }, 'failed to remove storage dir');
    });
  }
```

Leave the rest of the function (the `revalidatePath` block and the return) unchanged. PR B appends its embedding tombstone after the delete.

- [ ] **Step 8: Run both test files and confirm they pass**

```bash
pnpm exec vitest run lib/attachments/storage.test.ts tests/integration/attachment-ownership.test.ts
pnpm typecheck
```

Expected: PASS and typecheck clean.

- [ ] **Step 9: Commit**

```bash
pnpm lint:fix   # new/changed imports: Biome may reorder specifiers
git add lib/attachments/storage.ts lib/attachments/storage.test.ts lib/attachments/actions.ts tests/integration/attachment-ownership.test.ts
git commit -m "fix(attachments): delete the directory the file lives in, never FILES_DIR itself"
git log --oneline -1   # confirm HEAD moved
```

---

### Task 2: Q-H4 — inbound email attachments survive their draft service record

**Files:**
- Modify: `lib/incoming-email/create-service-record.ts:68-78` (comment), plus a new export at the end
- Modify: `lib/service-records/actions.ts:1-9` (import), `:216-238` (`deleteServiceRecord`)
- Modify: `lib/attachments/actions.ts:141-172` (`deleteAttachment`: select + unlink branch)
- Modify: `tests/integration/attachment-ownership.test.ts`
- Modify: `tests/unit/lib/search-index-drift.test.ts:76-82` (exemption reason)

- [ ] **Step 1: Write the failing tests**

In `tests/integration/attachment-ownership.test.ts`:

(a) Below `let attachments: typeof import('@/lib/attachments/actions');` add:

```ts
let serviceRecords: typeof import('@/lib/service-records/actions');
let inbox: typeof import('@/lib/incoming-email/actions');
```

(b) In `beforeAll`, below `attachments = await import('@/lib/attachments/actions');` add:

```ts
  serviceRecords = await import('@/lib/service-records/actions');
  inbox = await import('@/lib/incoming-email/actions');
```

(c) Append at the end of the file:

```ts
/**
 * Drafts a service record through the real "Create service record" action.
 * The worker's autoStub goes through the same createServiceRecordForEmail
 * helper, so this covers both creation paths.
 */
async function draftFromEmail() {
  const vendor = await ctx.prisma.vendor.create({ data: { name: `Acme ${createId()}` } });
  const email = await makeEmail(vendor.id);
  const seeded = await seedInboundAttachment(email.id);
  const r = await inbox.createServiceRecordFromEmail({ id: email.id });
  if (!r.ok) throw new Error(`draft failed: ${JSON.stringify(r)}`);
  const linked = await ctx.prisma.attachment.findUniqueOrThrow({
    where: { id: seeded.attachment.id },
  });
  expect(linked.serviceRecordId).toBe(r.data.serviceRecordId); // precondition
  return { email, serviceRecordId: r.data.serviceRecordId, ...seeded };
}

describe('an inbound attachment is owned by its email, not by the drafted service record', () => {
  it("deleting the draft keeps the email's attachment row and its file", async () => {
    const { email, serviceRecordId, attachment, fileAbs } = await draftFromEmail();

    const r = await serviceRecords.deleteServiceRecord(serviceRecordId);

    expect(r).toEqual({ ok: true, data: undefined });
    expect(await ctx.prisma.serviceRecord.findUnique({ where: { id: serviceRecordId } })).toBeNull();
    const after = await ctx.prisma.attachment.findUnique({ where: { id: attachment.id } });
    expect(after).not.toBeNull();
    expect(after?.incomingEmailId).toBe(email.id);
    expect(after?.serviceRecordId).toBeNull();
    expect(await exists(fileAbs)).toBe(true);
    // Its search parent moved from the record back to the email.
    expect(searchCalls).toContainEqual({ kind: 'attachment', id: attachment.id, op: 'upsert' });
  });

  it('re-drafting after deleting the draft re-links the same attachment', async () => {
    const { email, serviceRecordId, attachment } = await draftFromEmail();
    await serviceRecords.deleteServiceRecord(serviceRecordId);

    const again = await inbox.createServiceRecordFromEmail({ id: email.id });

    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const after = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: attachment.id } });
    expect(after.serviceRecordId).toBe(again.data.serviceRecordId);
  });

  it('an attachment uploaded straight to the record still goes with it', async () => {
    const { serviceRecordId } = await draftFromEmail();
    const own = await ctx.prisma.attachment.create({
      data: {
        serviceRecordId,
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1,
        storagePath: `${createId()}/original.jpg`,
        uploadedById: 'u1',
      },
    });

    await serviceRecords.deleteServiceRecord(serviceRecordId);

    expect(await ctx.prisma.attachment.findUnique({ where: { id: own.id } })).toBeNull();
  });

  it('"delete" on the service-record page unlinks an email-owned attachment instead of destroying it', async () => {
    const { email, attachment, fileAbs } = await draftFromEmail();

    const r = await attachments.deleteAttachment(attachment.id);

    expect(r).toEqual({ ok: true, data: undefined });
    const after = await ctx.prisma.attachment.findUnique({ where: { id: attachment.id } });
    expect(after).not.toBeNull();
    expect(after?.incomingEmailId).toBe(email.id);
    expect(after?.serviceRecordId).toBeNull();
    expect(await exists(fileAbs)).toBe(true);
    expect(searchCalls).toContainEqual({ kind: 'attachment', id: attachment.id, op: 'upsert' });
    expect(searchCalls).not.toContainEqual({
      kind: 'attachment',
      id: attachment.id,
      op: 'delete',
    });
  });
});
```

- [ ] **Step 2: Run it and confirm the new cases fail**

```bash
pnpm exec vitest run tests/integration/attachment-ownership.test.ts
```

Expected: FAIL.
- "deleting the draft keeps…": `expect(after).not.toBeNull()` receives `null` (the cascade).
- "re-drafting…": `findUniqueOrThrow` throws (the row is gone).
- "'delete' on the service-record page…": `after` is `null`.

"uploaded straight to the record" and the two Task 1 cases pass.

- [ ] **Step 3: Add the detach helper**

In `lib/incoming-email/create-service-record.ts`, replace the comment above the hand-off:

```ts
  // Multi-parent attachments: the same PDF/photo now shows on both the inbox
  // detail (via incomingEmailId) and the service record. Single copy on disk.
  // `serviceRecordId: null` guards against stealing a file the user already
  // attached somewhere else.
```

with:

```ts
  // Multi-parent attachments: the same PDF/photo now shows on both the inbox
  // detail (via incomingEmailId) and the service record. Single copy on disk.
  // The EMAIL owns the row; serviceRecordId is only a link — see
  // detachEmailOwnedAttachments below, which every service-record delete runs
  // first. `serviceRecordId: null` guards against stealing a file the user
  // already attached somewhere else, and is also what lets a re-draft (after
  // the first draft was deleted) pick the same files back up.
```

Append at the end of the file:

```ts
/**
 * The inverse of the hand-off in `createServiceRecordForEmail`, run before a
 * service record is deleted.
 *
 * Ownership rule: an attachment with `incomingEmailId` set belongs to the
 * email, and its `serviceRecordId` is only a link. Both FKs are
 * `onDelete: Cascade` (prisma/schema.prisma, model Attachment), so without
 * this, deleting a drafted record cascade-deleted the email's original
 * invoice — auto-stub drafts, the user bins the draft, the source PDF is gone.
 *
 * Must run in the same transaction as the delete. Returns the detached rows so
 * the caller can re-index them after commit: their search parent moves from
 * the record back to the email.
 */
export async function detachEmailOwnedAttachments(
  tx: TransactionClient,
  serviceRecordId: string,
): Promise<Array<{ id: string; incomingEmailId: string }>> {
  const owned = await tx.attachment.findMany({
    where: { serviceRecordId, incomingEmailId: { not: null } },
    select: { id: true, incomingEmailId: true },
  });
  if (owned.length === 0) return [];
  await tx.attachment.updateMany({
    where: { id: { in: owned.map((a) => a.id) } },
    data: { serviceRecordId: null },
  });
  return owned.map((a) => ({ id: a.id, incomingEmailId: a.incomingEmailId as string }));
}
```

- [ ] **Step 4: Use it in `deleteServiceRecord`**

In `lib/service-records/actions.ts`, add the import below the `enqueueEmbed` import:

```ts
import { detachEmailOwnedAttachments } from '@/lib/incoming-email/create-service-record';
```

Replace:

```ts
  await prisma.serviceRecord.delete({ where: { id } });
  await enqueueSearchIndex('service', id, 'delete');
  await enqueueEmbed('SERVICE_RECORD', id);

  revalidatePath('/service');
  revalidatePath('/dashboard');
  if (existing.vendorId) revalidatePath(`/vendors/${existing.vendorId}`);
  revalidateForTargets(existing.targets);

  return { ok: true, data: undefined };
}
```

with:

```ts
  // Email-owned attachments are unlinked, not cascaded — see
  // detachEmailOwnedAttachments. Same transaction, so a failed delete leaves
  // the links intact.
  const detached = await prisma.$transaction(async (tx) => {
    const rows = await detachEmailOwnedAttachments(tx, id);
    await tx.serviceRecord.delete({ where: { id } });
    return rows;
  });
  await enqueueSearchIndex('service', id, 'delete');
  await enqueueEmbed('SERVICE_RECORD', id);
  for (const a of detached) await enqueueSearchIndex('attachment', a.id, 'upsert');

  revalidatePath('/service');
  revalidatePath('/dashboard');
  if (existing.vendorId) revalidatePath(`/vendors/${existing.vendorId}`);
  revalidateForTargets(existing.targets);
  for (const emailId of new Set(detached.map((a) => a.incomingEmailId))) {
    revalidatePath(`/inbox/${emailId}`);
  }

  return { ok: true, data: undefined };
}
```

- [ ] **Step 5: Unlink instead of delete in `deleteAttachment`**

In `lib/attachments/actions.ts` `deleteAttachment`, add `incomingEmailId: true,` to the `select` (after `partId: true,`). Then insert this block **between** `if (!row) return { ok: false, formError: 'Not found' };` and `await prisma.attachment.delete({ where: { id } });`:

```ts
  // An inbound attachment linked to a service record is owned by the email
  // (see detachEmailOwnedAttachments). The only delete button that reaches it
  // is on the record's page, so "delete" means "remove from this record";
  // the email keeps its original row and file.
  if (row.incomingEmailId && row.serviceRecordId) {
    await prisma.attachment.update({ where: { id }, data: { serviceRecordId: null } });
    await enqueueSearchIndex('attachment', id, 'upsert');
    revalidatePath(`/service/${row.serviceRecordId}`);
    revalidatePath(`/inbox/${row.incomingEmailId}`);
    revalidatePath('/dashboard');
    return { ok: true, data: undefined };
  }
```

- [ ] **Step 6: Correct the drift-guard exemption reason**

The helper's new `updateMany` is covered by the existing whole-file `attachment` exemption, but the stated reason is false: the attachment search doc *does* use the service record as its parent (`lib/search/document.ts:483-497`). In `tests/unit/lib/search-index-drift.test.ts`, replace:

```ts
    reason:
      'updateMany only sets serviceRecordId to link inbox attachments to a service record; ' +
      'attachment search doc references the direct Item link, not serviceRecord',
```

with:

```ts
    reason:
      'shared transactional link/unlink of inbox attachments (createServiceRecordForEmail, ' +
      'detachEmailOwnedAttachments); enqueueing inside the transaction would publish state ' +
      'Meili cannot yet read — deleteServiceRecord re-upserts the detached rows after commit',
```

- [ ] **Step 7: Run the tests and confirm they pass**

```bash
pnpm exec vitest run tests/integration/attachment-ownership.test.ts tests/integration/incoming-email-actions.test.ts tests/integration/service-records.test.ts tests/integration/attachments.test.ts tests/unit/lib/search-index-drift.test.ts tests/unit/lib/embed-drift.test.ts
pnpm typecheck
pnpm lint:worker-graph
```

Expected: all PASS. `incoming-email-actions.test.ts` "links existing email attachments to the new service record (multi-parent)" is unchanged. `attachments.test.ts` "cascade-deletes when the parent ServiceRecord is hard-deleted" still passes because it deletes through raw Prisma and the FK is unchanged. The worker graph is clean because `create-service-record.ts` still imports only types.

- [ ] **Step 8: Commit**

```bash
pnpm lint:fix   # new/changed imports: Biome may reorder specifiers
git add lib/incoming-email/create-service-record.ts lib/service-records/actions.ts lib/attachments/actions.ts tests/integration/attachment-ownership.test.ts tests/unit/lib/search-index-drift.test.ts
git commit -m "fix(inbox): deleting a drafted service record no longer destroys the email's attachments"
git log --oneline -1   # confirm HEAD moved
```

---

### Task 3: Q-H5 — system delete confirms, and refuses to orphan records

**Files:**
- Modify: `lib/systems/actions.ts:6` (import), `:79-263`
- Create: `tests/integration/system-delete-dependents.test.ts`
- Create: `components/ui/alert-dialog.tsx` (shadcn CLI)
- Modify: `components/systems/DeleteSystemButton.tsx` (whole file)
- Create: `components/systems/DeleteSystemButton.test.tsx`
- Modify: `components/systems/DeleteSystemPartsDialog.tsx:16, 24-31, 69-87`
- Modify: `app/(app)/systems/[id]/page.tsx:161-180`
- Modify: `tests/e2e/parts.spec.ts:175-176`
- Modify: `app/(app)/reminders/[id]/edit/page.tsx:1-12, 22-49`
- Create: `app/(app)/reminders/[id]/edit/page.test.tsx`

#### 3A — server guard

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/system-delete-dependents.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calDaysOut,
  type IntegrationContext,
  setupIntegration,
  teardownIntegration,
  todayCal,
} from './helpers';

let currentUserId: string | null = null;

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => (currentUserId ? { user: { id: currentUserId } } : null)),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/search/client', () => ({ enqueueSearchIndex: vi.fn(async () => {}) }));
vi.mock('@/lib/embedding/enqueue', () => ({ enqueueEmbed: vi.fn(async () => {}) }));

let ctx: IntegrationContext;
let actions: typeof import('@/lib/systems/actions');

beforeAll(async () => {
  ctx = await setupIntegration();
  // Dynamic import AFTER setupIntegration: lib/db builds its Prisma singleton
  // at import time from process.env.DATABASE_URL.
  actions = await import('@/lib/systems/actions');
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.warranty.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.partLink.deleteMany();
  await ctx.prisma.part.deleteMany();
  await ctx.prisma.system.deleteMany();
  await ctx.prisma.vendor.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@example.com', name: 'U1' } });
  currentUserId = 'u1';
});

const RECURRENCE = { kind: 'interval', every: 30, unit: 'day' };

async function makeSystem(name: string) {
  return ctx.prisma.system.create({ data: { name } });
}

async function makeReminder(
  kind: 'REMINDER' | 'CHORE',
  title: string,
  systemIds: string[],
  nextDueOn = todayCal(),
) {
  return ctx.prisma.reminder.create({
    data: {
      title,
      kind,
      recurrence: RECURRENCE,
      targets: { create: systemIds.map((systemId) => ({ systemId, nextDueOn })) },
    },
  });
}

async function makeWarranty(provider: string, systemIds: string[]) {
  return ctx.prisma.warranty.create({
    data: {
      provider,
      startsOn: todayCal(),
      endsOn: calDaysOut(365),
      targets: { create: systemIds.map((systemId) => ({ systemId })) },
    },
  });
}

async function makeServiceRecord(
  summary: string,
  systemIds: string[],
  anchor: { vendorId?: string; selfPerformed?: boolean } = {},
) {
  return ctx.prisma.serviceRecord.create({
    data: {
      summary,
      performedOn: todayCal(),
      ...anchor,
      targets: { create: systemIds.map((systemId) => ({ systemId })) },
    },
  });
}

describe('tryDeleteSystem refuses to orphan records', () => {
  it("lists a REMINDER whose only target is the system, and deletes nothing", async () => {
    const system = await makeSystem('Water heater');
    const reminder = await makeReminder('REMINDER', 'Flush water heater', [system.id]);

    const result = await actions.tryDeleteSystem(system.id);

    expect(result).toEqual({
      ok: false,
      hasDependents: true,
      dependents: [{ kind: 'reminder', id: reminder.id, label: 'Flush water heater' }],
    });
    expect(await ctx.prisma.system.findUnique({ where: { id: system.id } })).not.toBeNull();
    expect(await ctx.prisma.reminderTarget.count({ where: { reminderId: reminder.id } })).toBe(1);
  });

  it('lists a warranty and an unanchored service record, reminders first', async () => {
    const system = await makeSystem('Water heater');
    const warranty = await makeWarranty('Rheem limited warranty', [system.id]);
    const sr = await makeServiceRecord('Anode rod swap', [system.id]);
    const reminder = await makeReminder('REMINDER', 'Flush water heater', [system.id]);

    const result = await actions.tryDeleteSystem(system.id);

    if (result.ok || !('hasDependents' in result)) throw new Error('expected the dependents list');
    expect(result.dependents).toEqual([
      { kind: 'reminder', id: reminder.id, label: 'Flush water heater' },
      { kind: 'warranty', id: warranty.id, label: 'Rheem limited warranty' },
      { kind: 'serviceRecord', id: sr.id, label: 'Anode rod swap' },
    ]);
  });

  it('lets a service record with a vendor or self-performed marker become vendor-only/self-only', async () => {
    const system = await makeSystem('Water heater');
    const vendor = await ctx.prisma.vendor.create({ data: { name: 'Acme Plumbing' } });
    const withVendor = await makeServiceRecord('Annual service', [system.id], {
      vendorId: vendor.id,
    });
    const selfDone = await makeServiceRecord('Drained tank', [system.id], { selfPerformed: true });

    const result = await actions.tryDeleteSystem(system.id);

    expect(result).toEqual({ ok: true });
    for (const id of [withVendor.id, selfDone.id]) {
      expect(await ctx.prisma.serviceRecord.findUnique({ where: { id } })).not.toBeNull();
      expect(await ctx.prisma.serviceRecordTarget.count({ where: { serviceRecordId: id } })).toBe(0);
    }
  });

  it('allows the delete when every record keeps another target', async () => {
    const system = await makeSystem('Water heater');
    const other = await makeSystem('Boiler');
    const reminder = await makeReminder('REMINDER', 'Check pressure', [system.id, other.id]);
    const warranty = await makeWarranty('Home warranty', [system.id, other.id]);

    const result = await actions.tryDeleteSystem(system.id);

    expect(result).toEqual({ ok: true });
    const rTargets = await ctx.prisma.reminderTarget.findMany({ where: { reminderId: reminder.id } });
    expect(rTargets.map((t) => t.systemId)).toEqual([other.id]);
    const wTargets = await ctx.prisma.warrantyTarget.findMany({ where: { warrantyId: warranty.id } });
    expect(wTargets.map((t) => t.systemId)).toEqual([other.id]);
  });

  // A cascade would delete the chore's only target row — and with it the
  // cadence and (ReminderCompletion.target is Cascade) the completion history.
  it('turns a sole-target CHORE into a standalone chore in place, keeping cadence and history', async () => {
    const system = await makeSystem('Water heater');
    const chore = await makeReminder('CHORE', 'Flush water heater', [system.id], calDaysOut(5));
    const target = await ctx.prisma.reminderTarget.findFirstOrThrow({
      where: { reminderId: chore.id },
    });
    const completedAt = new Date('2026-06-01T15:00:00Z');
    await ctx.prisma.reminderTarget.update({
      where: { id: target.id },
      data: { lastCompletedOn: completedAt },
    });
    await ctx.prisma.reminderCompletion.create({
      data: { reminderId: chore.id, targetId: target.id, completedById: 'u1', completedOn: completedAt },
    });

    const result = await actions.tryDeleteSystem(system.id);

    expect(result).toEqual({ ok: true });
    const after = await ctx.prisma.reminderTarget.findMany({ where: { reminderId: chore.id } });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: target.id, itemId: null, systemId: null, partId: null });
    expect(after[0].nextDueOn).toEqual(calDaysOut(5));
    expect(after[0].lastCompletedOn).toEqual(completedAt);
    expect(await ctx.prisma.reminderCompletion.count({ where: { reminderId: chore.id } })).toBe(1);
  });

  it('reports blockers before the parts prompt', async () => {
    const system = await makeSystem('Water heater');
    const part = await ctx.prisma.part.create({ data: { name: 'Anode rod', kind: 'OTHER' } });
    await ctx.prisma.partLink.create({ data: { partId: part.id, systemId: system.id } });
    await makeReminder('REMINDER', 'Flush water heater', [system.id]);

    const result = await actions.tryDeleteSystem(system.id);

    expect(result.ok).toBe(false);
    expect('hasDependents' in result).toBe(true);
  });
});

describe('deleteSystemWithParts re-checks blockers inside its transaction', () => {
  it('rolls back and returns the blockers when a sole-target reminder appears after the prompt', async () => {
    const system = await makeSystem('Water heater');
    const part = await ctx.prisma.part.create({ data: { name: 'Anode rod', kind: 'OTHER' } });
    await ctx.prisma.partLink.create({ data: { partId: part.id, systemId: system.id } });

    const prompt = await actions.tryDeleteSystem(system.id);
    if (prompt.ok || !('hasParts' in prompt)) throw new Error('expected the parts prompt');

    const reminder = await makeReminder('REMINDER', 'Flush water heater', [system.id]);

    const result = await actions.deleteSystemWithParts({
      systemId: system.id,
      archivePartIds: [part.id],
      keepPartIds: [],
    });

    expect(result).toEqual({
      ok: false,
      hasDependents: true,
      dependents: [{ kind: 'reminder', id: reminder.id, label: 'Flush water heater' }],
    });
    expect(await ctx.prisma.system.findUnique({ where: { id: system.id } })).not.toBeNull();
    expect((await ctx.prisma.part.findUniqueOrThrow({ where: { id: part.id } })).archivedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm exec vitest run tests/integration/system-delete-dependents.test.ts
```

Expected: FAIL. The blocking cases get `{ ok: true }` (the system is deleted and the reminder is left with 0 targets). The chore case fails on `toHaveLength(1)` with received `0`. The two "allowed" cases already pass.

- [ ] **Step 3: Implement the guard in `lib/systems/actions.ts`**

Change the db import (line 6):

```ts
import { prisma } from '@/lib/db';
```

to:

```ts
import { prisma, type TransactionClient } from '@/lib/db';
```

Replace the `TryDeleteSystemResult` type (lines 89-98, its doc comment included) with:

```ts
/**
 * `PartLink.system` is `onDelete: Cascade`, so deleting a system succeeds
 * silently and takes its link rows with it. There is no RESTRICT violation to
 * catch, which is why this is a **pre-query** and not the `tryDeleteVendor`
 * probe: that pattern needs the database to say no, and here it says yes.
 * The same holds for the reminder/warranty/service-record target tables —
 * see findSystemDeleteBlockers.
 */
export type TryDeleteSystemResult =
  | { ok: true }
  | { ok: false; hasDependents: true; dependents: SystemDependentSummary[] }
  | { ok: false; hasParts: true; parts: SystemPartSummary[] }
  | { ok: false; formError: string };
```

Directly **after** the `summarizeSystemParts` function (ends at line 135), insert:

```ts
// ---------- Records that would be left pointing at nothing ----------

export type SystemDependentSummary = {
  kind: 'reminder' | 'warranty' | 'serviceRecord';
  id: string;
  label: string;
};

/** Thrown inside the transaction to force a rollback — same lever as StaleSystemPartsError. */
class SystemDeleteBlockedError extends Error {
  constructor(readonly dependents: SystemDependentSummary[]) {
    super('system delete blocked by dependents');
  }
}

function targetsOnlyThisSystem(systemId: string, targets: { systemId: string | null }[]): boolean {
  return targets.length > 0 && targets.every((t) => t.systemId === systemId);
}

const byLabel = (a: SystemDependentSummary, b: SystemDependentSummary) =>
  a.label.localeCompare(b.label);

/**
 * Records whose ONLY target is this system. The target tables cascade from
 * `System` (prisma/schema.prisma), so deleting it would silently leave them
 * with none — and every "must have a target" rule here is app-level only:
 *   - REMINDER needs ≥1 target: reminders-tick iterates target rows, the iCal
 *     feed skips it, completeReminder refuses "Reminder has no targets".
 *   - Warranty needs ≥1 target (targetsArraySchema); there is no warranty list
 *     page, so a target-less warranty is unreachable.
 *   - Service record needs a vendor, the self-performed marker, or ≥1 target
 *     (requireAnchor in lib/service-records/schema.ts). One that keeps a vendor
 *     or the marker stays valid and listed, so only unanchored ones block.
 * CHOREs never block: see detachSoleTargetChores.
 *
 * Filtered in JS rather than with Prisma's `every`: `every: { systemId }` on a
 * nullable column is exactly the three-valued-logic corner that is easy to get
 * wrong, and the candidate set (records with SOME target here) is small.
 */
async function findSystemDeleteBlockers(
  tx: TransactionClient,
  systemId: string,
): Promise<SystemDependentSummary[]> {
  const reminders = await tx.reminder.findMany({
    where: { kind: 'REMINDER', targets: { some: { systemId } } },
    select: { id: true, title: true, targets: { select: { systemId: true } } },
  });
  const warranties = await tx.warranty.findMany({
    where: { targets: { some: { systemId } } },
    select: { id: true, provider: true, targets: { select: { systemId: true } } },
  });
  const serviceRecords = await tx.serviceRecord.findMany({
    where: { targets: { some: { systemId } }, vendorId: null, selfPerformed: false },
    select: { id: true, summary: true, targets: { select: { systemId: true } } },
  });

  return [
    ...reminders
      .filter((r) => targetsOnlyThisSystem(systemId, r.targets))
      .map((r) => ({ kind: 'reminder' as const, id: r.id, label: r.title }))
      .sort(byLabel),
    ...warranties
      .filter((w) => targetsOnlyThisSystem(systemId, w.targets))
      .map((w) => ({ kind: 'warranty' as const, id: w.id, label: w.provider }))
      .sort(byLabel),
    ...serviceRecords
      .filter((s) => targetsOnlyThisSystem(systemId, s.targets))
      .map((s) => ({ kind: 'serviceRecord' as const, id: s.id, label: s.summary }))
      .sort(byLabel),
  ];
}

/**
 * A CHORE whose only target is this system becomes a standalone chore — the
 * item/system/part-all-NULL shape updateReminder reconciles a link-less chore
 * to (lib/reminders/actions.ts). Converted IN PLACE rather than cascaded and
 * re-created, so the row keeps its `nextDueOn`, `lastCompletedOn` and its
 * ReminderCompletion history (which cascades from the target row). Safe
 * against the NULLS NOT DISTINCT unique: a chore whose every target is this
 * system cannot already have a standalone row.
 */
async function detachSoleTargetChores(tx: TransactionClient, systemId: string): Promise<void> {
  const chores = await tx.reminder.findMany({
    where: { kind: 'CHORE', targets: { some: { systemId } } },
    select: { id: true, targets: { select: { systemId: true } } },
  });
  const ids = chores.filter((c) => targetsOnlyThisSystem(systemId, c.targets)).map((c) => c.id);
  if (ids.length === 0) return;
  await tx.reminderTarget.updateMany({
    where: { systemId, reminderId: { in: ids } },
    data: { systemId: null },
  });
}
```

Replace the whole `tryDeleteSystem` function and `revalidateAfterSystemDelete` (lines 137-164) with:

```ts
/**
 * The delete entry point, run as one transaction so the checks and the delete
 * see the same rows. Blockers are reported before parts: asking the user to
 * archive parts only to refuse the delete afterwards would be worse.
 */
export async function tryDeleteSystem(systemId: string): Promise<TryDeleteSystemResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const outcome = await prisma.$transaction(async (tx) => {
    const system = await tx.system.findUnique({ where: { id: systemId }, select: { id: true } });
    if (!system) return { kind: 'missing' as const };

    const dependents = await findSystemDeleteBlockers(tx, systemId);
    if (dependents.length > 0) return { kind: 'blocked' as const, dependents };

    const parts = summarizeSystemParts(
      await tx.partLink.findMany({ where: { systemId }, select: SYSTEM_PART_LINK_SELECT }),
    );
    if (parts.length > 0) return { kind: 'parts' as const, parts };

    await detachSoleTargetChores(tx, systemId);
    await tx.system.delete({ where: { id: systemId } });
    return { kind: 'deleted' as const };
  });

  if (outcome.kind === 'missing') return { ok: false, formError: 'System not found' };
  if (outcome.kind === 'blocked') {
    return { ok: false, hasDependents: true, dependents: outcome.dependents };
  }
  if (outcome.kind === 'parts') return { ok: false, hasParts: true, parts: outcome.parts };

  revalidateAfterSystemDelete();
  return { ok: true };
}

function revalidateAfterSystemDelete() {
  revalidatePath('/systems');
  revalidatePath('/items');
  revalidatePath('/parts');
  // Reminders, chores and warranties may have lost a target chip.
  revalidatePath('/reminders');
  revalidatePath('/chores');
  revalidatePath('/dashboard');
}
```

Replace the `DeleteSystemWithPartsResult` type with:

```ts
export type DeleteSystemWithPartsResult =
  | ActionResult<{ archivedCount: number; keptCount: number }>
  | { ok: false; hasParts: true; parts: SystemPartSummary[] }
  | { ok: false; hasDependents: true; dependents: SystemDependentSummary[] };
```

In `deleteSystemWithParts`, inside the transaction, insert directly after `if (!system) return null;`:

```ts
      // Re-checked here, not trusted from the prompt: a sole-target reminder
      // created between the prompt and the submit must still block.
      const dependents = await findSystemDeleteBlockers(tx, systemId);
      if (dependents.length > 0) throw new SystemDeleteBlockedError(dependents);
```

replace:

```ts
      await tx.partLink.deleteMany({ where: { systemId } });
      await tx.system.delete({ where: { id: systemId } });
```

with:

```ts
      await tx.partLink.deleteMany({ where: { systemId } });
      await detachSoleTargetChores(tx, systemId);
      await tx.system.delete({ where: { id: systemId } });
```

and in the `catch`, insert before `if (error instanceof StaleSystemPartsError) {`:

```ts
    if (error instanceof SystemDeleteBlockedError) {
      return { ok: false, hasDependents: true, dependents: error.dependents };
    }
```

- [ ] **Step 4: Pass the new arm through the page**

In `app/(app)/systems/[id]/page.tsx`, replace `doTryDelete` and `doDeleteWithParts` (lines 161-180) with:

```ts
  async function doTryDelete() {
    'use server';
    const r = await tryDeleteSystem(id);
    if (r.ok) return { ok: true as const };
    if ('hasDependents' in r) {
      return { ok: false as const, hasDependents: true as const, dependents: r.dependents };
    }
    if ('hasParts' in r) return { ok: false as const, hasParts: true as const, parts: r.parts };
    return { ok: false as const, formError: r.formError };
  }

  async function doDeleteWithParts(input: { archivePartIds: string[]; keepPartIds: string[] }) {
    'use server';
    const r = await deleteSystemWithParts({ systemId: id, ...input });
    if (r.ok) {
      return {
        ok: true as const,
        archivedCount: r.data.archivedCount,
        keptCount: r.data.keptCount,
      };
    }
    if ('hasDependents' in r) {
      return { ok: false as const, hasDependents: true as const, dependents: r.dependents };
    }
    if ('hasParts' in r) return { ok: false as const, hasParts: true as const, parts: r.parts };
    return { ok: false as const, formError: r.formError };
  }
```

(Typecheck fails until 3B updates the button props. That's expected, so don't commit yet.)

- [ ] **Step 5: Run the server tests and confirm they pass**

```bash
pnpm exec vitest run tests/integration/system-delete-dependents.test.ts tests/integration/system-delete-parts.test.ts
```

Expected: PASS, including every existing `system-delete-parts.test.ts` case (its fixtures have no reminders, warranties or SRs).

#### 3B — confirm dialog and blocking list

- [ ] **Step 6: Add the AlertDialog primitive**

First confirm there is no new dependency. `CLAUDE.md` says to install transitive component deps explicitly, and the only runtime dep here is `@base-ui/react`, which is pinned at 1.8.0 and already ships the primitive:

```bash
ls node_modules/@base-ui/react/alert-dialog   # must exist; if not, STOP and report
```

Then run the CLI **non-interactively**. The registry item depends on `button`, which already exists, and without `--yes` the CLI stops at an "overwrite button.tsx?" prompt that hangs a non-TTY shell. Pass `--yes` but **never `--overwrite`**, because `components/ui/button.tsx` must not be replaced:

```bash
pnpm dlx shadcn@latest add alert-dialog --yes
git diff --stat components/ui/button.tsx   # must print nothing
git status --short
```

Expected: `git diff --stat` prints nothing, and `git status` shows only `?? components/ui/alert-dialog.tsx`. If `components/ui/button.tsx`, `package.json` or `pnpm-lock.yaml` changed, run `git checkout -- <file>` on it.

**Fallback if the CLI still hangs or fails:** kill it and write `components/ui/alert-dialog.tsx` by hand from the base-nova registry item (`https://ui.shadcn.com/r/styles/base-nova/alert-dialog.json`, `files[0].content`). Rewrite its two registry-internal imports to `import { Button } from '@/components/ui/button';` and `import { cn } from '@/lib/utils';`. Keep `'use client'` and the `import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog';` import. `AlertDialogAction` is a plain `<Button>`. `AlertDialogCancel` is `AlertDialogPrimitive.Close` with `render={<Button variant={variant} size={size} />}` (variant defaults to `"outline"`).

Format the file to repo style:

```bash
pnpm exec biome check --write components/ui/alert-dialog.tsx
```

Check that it exports `AlertDialog`, `AlertDialogAction`, `AlertDialogCancel`, `AlertDialogContent`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogHeader` and `AlertDialogTitle`, and imports `AlertDialog as AlertDialogPrimitive` from `@base-ui/react/alert-dialog`. In the base-nova registry, `AlertDialogAction` is a plain `<Button>` (it does not close the dialog), and `AlertDialogCancel` is `AlertDialogPrimitive.Close` with `render={<Button variant="outline" />}`. The component below depends on both.

- [ ] **Step 7: Write the failing component test**

Create `components/systems/DeleteSystemButton.test.tsx`:

```tsx
// @vitest-environment jsdom
//
// Q-H5: the delete button used to delete on the FIRST click, and a system whose
// only link to a reminder/warranty/service record went with it silently
// orphaned them. These tests pin the confirm step and the blocking list.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SystemDependentSummary } from '@/lib/systems/actions';
import { expectNoAxeViolations } from '@/tests/a11y/axe';
import { DeleteSystemButton } from './DeleteSystemButton';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  push.mockReset();
});

type Props = ComponentProps<typeof DeleteSystemButton>;
type TryDelete = Props['onTryDelete'];

function renderButton(onTryDelete: TryDelete) {
  const onDeleteWithParts = vi.fn<Props['onDeleteWithParts']>(async () => ({
    ok: true,
    archivedCount: 0,
    keptCount: 0,
  }));
  render(
    <DeleteSystemButton
      systemName="Water heater"
      onTryDelete={onTryDelete}
      onDeleteWithParts={onDeleteWithParts}
    />,
  );
}

const DEPENDENTS: SystemDependentSummary[] = [
  { kind: 'reminder', id: 'r1', label: 'Flush water heater' },
  { kind: 'warranty', id: 'w1', label: 'Rheem limited warranty' },
  { kind: 'serviceRecord', id: 's1', label: 'Anode rod swap' },
];

describe('DeleteSystemButton', () => {
  it('asks before deleting: the trigger alone never deletes', async () => {
    const onTryDelete = vi.fn<TryDelete>(async () => ({ ok: true }));
    renderButton(onTryDelete);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('system-delete-trigger'));

    expect(await screen.findByText('Permanently delete Water heater?')).toBeInTheDocument();
    expect(onTryDelete).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('delete-system-alert-confirm'));

    await waitFor(() => expect(onTryDelete).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/systems'));
  });

  it('Cancel does not delete', async () => {
    const onTryDelete = vi.fn<TryDelete>(async () => ({ ok: true }));
    renderButton(onTryDelete);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('system-delete-trigger'));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(onTryDelete).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('lists the records that would be orphaned, links each, and offers no delete', async () => {
    const onTryDelete = vi.fn<TryDelete>(async () => ({
      ok: false,
      hasDependents: true,
      dependents: DEPENDENTS,
    }));
    renderButton(onTryDelete);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('system-delete-trigger'));
    await user.click(await screen.findByTestId('delete-system-alert-confirm'));

    const reminder = await screen.findByRole('link', { name: 'Flush water heater' });
    expect(reminder).toHaveAttribute('href', '/reminders/r1');
    expect(screen.getByRole('link', { name: 'Rheem limited warranty' })).toHaveAttribute(
      'href',
      '/warranties/w1',
    );
    expect(screen.getByRole('link', { name: 'Anode rod swap' })).toHaveAttribute(
      'href',
      '/service/s1',
    );
    expect(screen.queryByTestId('delete-system-alert-confirm')).toBeNull();
    expect(push).not.toHaveBeenCalled();

    await expectNoAxeViolations();
  });

  it('hands over to the parts prompt when the system has parts', async () => {
    const onTryDelete = vi.fn<TryDelete>(async () => ({
      ok: false,
      hasParts: true,
      parts: [{ id: 'p1', name: 'Anode rod', kind: 'OTHER', willBeOrphaned: true }],
    }));
    renderButton(onTryDelete);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('system-delete-trigger'));
    await user.click(await screen.findByTestId('delete-system-alert-confirm'));

    expect(await screen.findByTestId('delete-system-confirm')).toBeInTheDocument();
  });
});
```

- [ ] **Step 8: Run it and confirm it fails**

```bash
pnpm exec vitest run components/systems/DeleteSystemButton.test.tsx
```

Expected: FAIL. The first test's `findByText('Permanently delete Water heater?')` times out and `onTryDelete` was called on the first click. The later tests fail to find `delete-system-alert-confirm`.

- [ ] **Step 9: Rewrite `components/systems/DeleteSystemButton.tsx`**

Replace the whole file with:

```tsx
'use client';

import { Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { DeleteSystemPartsDialog } from '@/components/systems/DeleteSystemPartsDialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import type { SystemDependentSummary, SystemPartSummary } from '@/lib/systems/actions';

type Props = {
  systemName: string;
  /** Injected by the server page, per the action-injection convention. */
  onTryDelete: () => Promise<
    | { ok: true }
    | { ok: false; hasDependents: true; dependents: SystemDependentSummary[] }
    | { ok: false; hasParts: true; parts: SystemPartSummary[] }
    | { ok: false; formError?: string }
  >;
  onDeleteWithParts: (input: {
    archivePartIds: string[];
    keepPartIds: string[];
  }) => Promise<
    | { ok: true; archivedCount: number; keptCount: number }
    | { ok: false; hasDependents: true; dependents: SystemDependentSummary[] }
    | { ok: false; hasParts: true; parts: SystemPartSummary[] }
    | { ok: false; formError?: string }
  >;
};

const DEPENDENT_HREF: Record<SystemDependentSummary['kind'], (id: string) => string> = {
  reminder: (id) => `/reminders/${id}`,
  warranty: (id) => `/warranties/${id}`,
  serviceRecord: (id) => `/service/${id}`,
};

const DEPENDENT_KIND_LABEL: Record<SystemDependentSummary['kind'], string> = {
  reminder: 'Reminder',
  warranty: 'Warranty',
  serviceRecord: 'Service record',
};

/**
 * The only entry point for deleting a system. Every delete is confirmed first.
 * The server then either deletes, refuses with the records that would be left
 * with no target (listed here, each linked so the user can retarget or delete
 * it), or hands over to the archive-or-keep parts prompt.
 */
export function DeleteSystemButton({ systemName, onTryDelete, onDeleteWithParts }: Props) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dependents, setDependents] = useState<SystemDependentSummary[]>([]);
  const [parts, setParts] = useState<SystemPartSummary[] | null>(null);
  const [pending, startTransition] = useTransition();

  const blocked = dependents.length > 0;

  function openConfirm() {
    setDependents([]);
    setConfirmOpen(true);
  }

  function handleConfirm() {
    startTransition(async () => {
      const r = await onTryDelete();
      if (r.ok) {
        setConfirmOpen(false);
        toast.success('System deleted');
        router.push('/systems');
        return;
      }
      if ('hasDependents' in r) {
        setDependents(r.dependents);
        return;
      }
      if ('hasParts' in r) {
        setConfirmOpen(false);
        setParts(r.parts);
        return;
      }
      toast.error(r.formError ?? 'Failed to delete system');
    });
  }

  return (
    <>
      <Button
        variant="destructive"
        onClick={openConfirm}
        disabled={pending}
        data-testid="system-delete-trigger"
      >
        <Trash2 className="h-4 w-4" />
        Delete
      </Button>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="delete-system-alert">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {blocked ? `${systemName} can't be deleted yet` : `Permanently delete ${systemName}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {blocked
                ? 'These records point only at this system. Deleting it would leave them tracking nothing — give each another item or system, or delete it, first. Or archive the system instead.'
                : 'Its links from reminders, warranties and service records are removed. This cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {blocked && (
            <ul className="max-h-72 space-y-1 overflow-y-auto" data-testid="delete-system-blockers">
              {dependents.map((d) => (
                <li key={`${d.kind}-${d.id}`} className="rounded-md border p-2 text-sm">
                  {/* Labels are user-supplied: text, never markup. */}
                  <Link
                    href={DEPENDENT_HREF[d.kind](d.id)}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {d.label}
                  </Link>
                  <span className="block text-xs text-muted-foreground">
                    {DEPENDENT_KIND_LABEL[d.kind]}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>{blocked ? 'Close' : 'Cancel'}</AlertDialogCancel>
            {!blocked && (
              <AlertDialogAction
                variant="destructive"
                onClick={handleConfirm}
                disabled={pending}
                data-testid="delete-system-alert-confirm"
              >
                Delete system
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {parts && (
        <DeleteSystemPartsDialog
          open
          onOpenChange={(next) => {
            if (!next) setParts(null);
          }}
          systemName={systemName}
          parts={parts}
          onConfirm={async (input) => {
            const r = await onDeleteWithParts(input);
            if (r.ok) {
              setParts(null);
              router.push('/systems');
            } else if ('hasDependents' in r) {
              // A sole-target record appeared after the prompt: swap back to
              // the blocking list.
              setParts(null);
              setDependents(r.dependents);
              setConfirmOpen(true);
            }
            return r;
          }}
        />
      )}
    </>
  );
}
```

- [ ] **Step 10: Accept the new arm in `DeleteSystemPartsDialog`**

In `components/systems/DeleteSystemPartsDialog.tsx`:

Change the type import (line 16):

```ts
import type { SystemPartSummary } from '@/lib/systems/actions';
```

to:

```ts
import type { SystemDependentSummary, SystemPartSummary } from '@/lib/systems/actions';
```

In `Props['onConfirm']`'s return union, add an arm after `{ ok: true; archivedCount: number; keptCount: number }`:

```ts
    | { ok: false; hasDependents: true; dependents: SystemDependentSummary[] }
```

In `handleConfirm`, insert before `if ('hasParts' in r) {`:

```ts
      if ('hasDependents' in r) {
        // The caller closes this dialog and re-opens the blocking list.
        return;
      }
```

- [ ] **Step 11: Update the parts e2e for the new confirm step**

In `tests/e2e/parts.spec.ts`, replace:

```ts
  await page.getByTestId('system-delete-trigger').click();
  await expect(page.getByRole('heading', { name: 'Delete Central HVAC?' })).toBeVisible();
```

with:

```ts
  await page.getByTestId('system-delete-trigger').click();
  // Every system delete is confirmed first (Q-H5); the parts prompt follows.
  await page.getByTestId('delete-system-alert-confirm').click();
  // Wait out the alert's close: its title ("Permanently delete Central HVAC?")
  // would also match the parts dialog's heading name as a substring.
  await expect(page.getByTestId('delete-system-alert')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Delete Central HVAC?' })).toBeVisible();
```

- [ ] **Step 12: Run the component tests and typecheck**

```bash
pnpm exec vitest run components/systems/DeleteSystemButton.test.tsx components/systems/DeleteSystemPartsDialog.test.tsx
pnpm typecheck
pnpm lint
```

Expected: PASS, typecheck clean, lint clean. knip should see `components/ui/alert-dialog.tsx` as used, and `components/ui/**` is ignored anyway.

- [ ] **Step 13: Commit 3A + 3B**

Run `pnpm lint:fix` first. The new multi-specifier import (`import { prisma, type TransactionClient } from '@/lib/db'`) and the new import blocks in `DeleteSystemButton.tsx` may fail Biome's specifier and import ordering. Re-run `pnpm lint` and confirm it is clean.

```bash
pnpm lint:fix
pnpm lint
git add lib/systems/actions.ts tests/integration/system-delete-dependents.test.ts components/ui/alert-dialog.tsx components/systems/DeleteSystemButton.tsx components/systems/DeleteSystemButton.test.tsx components/systems/DeleteSystemPartsDialog.tsx "app/(app)/systems/[id]/page.tsx" tests/e2e/parts.spec.ts
git commit -m "fix(systems): confirm deletes and refuse to orphan reminders, warranties and service records"
git log --oneline -1   # confirm HEAD moved
```

#### 3C — a target-less reminder's edit form defaults to a calendar date

This bug stays reachable after 3A: any reminder orphaned **before** this PR still has zero targets.

- [ ] **Step 14: Write the failing test**

Create `app/(app)/reminders/[id]/edit/page.test.tsx`:

```tsx
// A reminder with no targets (e.g. its only system was deleted before system
// deletes were guarded) has no derived nextDueOn. The edit page used to fall
// back to `new Date()` — an INSTANT, which the form submits untouched and the
// calendar-date write guard then rejects. The fallback must be today's HOUSE
// day at UTC midnight.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getReminder } = vi.hoisted(() => ({ getReminder: vi.fn() }));

vi.mock('@/components/reminders/ReminderForm', () => ({ ReminderForm: () => null }));
vi.mock('@/lib/reminders/actions', () => ({ updateReminder: vi.fn() }));
vi.mock('@/lib/reminders/queries', () => ({ getReminder }));
vi.mock('@/lib/items/queries', () => ({ listAllActiveItemsForPicker: vi.fn(async () => []) }));
vi.mock('@/lib/parts/queries', () => ({ listPartsForPicker: vi.fn(async () => []) }));
vi.mock('@/lib/systems/queries', () => ({
  listSystemsWithItemsForPicker: vi.fn(async () => []),
}));
vi.mock('@/lib/house-profile/queries', () => ({
  getHouseTimezone: vi.fn(async () => 'America/Chicago'),
}));

import EditReminderPage from './page';

function reminder(nextDueOn: Date | null) {
  return {
    id: 'r1',
    title: 'Flush water heater',
    description: null,
    recurrence: { kind: 'interval', every: 30, unit: 'day' },
    nextDueOn,
    leadTimeDays: 3,
    autoCreateServiceRecord: false,
    autoComplete: false,
    kind: 'REMINDER',
    targets: [],
  };
}

async function formDefaults(): Promise<{ nextDueOn: Date }> {
  const el = await EditReminderPage({ params: Promise.resolve({ id: 'r1' }) });
  return el.props.children.props.defaultValues;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 21:00 on Jul 14 in Chicago (CDT, UTC-5) — already Jul 15 in UTC.
  vi.setSystemTime(new Date('2026-07-15T02:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  getReminder.mockReset();
});

describe('EditReminderPage nextDueOn default', () => {
  it("falls back to today's house day at UTC midnight when the reminder has no targets", async () => {
    getReminder.mockResolvedValue(reminder(null));
    expect((await formDefaults()).nextDueOn).toEqual(new Date('2026-07-14T00:00:00.000Z'));
  });

  it("passes the reminder's own due date through unchanged", async () => {
    const due = new Date('2026-08-01T00:00:00.000Z');
    getReminder.mockResolvedValue(reminder(due));
    expect((await formDefaults()).nextDueOn).toEqual(due);
  });
});
```

- [ ] **Step 15: Run it and confirm it fails**

```bash
pnpm exec vitest run "app/(app)/reminders/[id]/edit/page.test.tsx"
```

Expected: the first test FAILS (received `2026-07-15T02:00:00.000Z`, the raw instant). The second passes.

- [ ] **Step 16: Fix the fallback**

In `app/(app)/reminders/[id]/edit/page.tsx`, add the imports (keeping Biome's sort order):

```ts
import { getHouseTimezone } from '@/lib/house-profile/queries';
```

after the `@/components/reminders/ReminderForm` import, and

```ts
import { startOfDayUtc } from '@/lib/time/tz';
```

after the `@/lib/targets/schema` import. Then replace:

```ts
  const isChore = r.kind === 'CHORE';
```

with:

```ts
  const isChore = r.kind === 'CHORE';
  // No targets → no derived due date. The fallback is a CALENDAR DATE (today's
  // house day), never `new Date()`: that instant is submitted untouched and the
  // calendar-date write guard rejects it (see CLAUDE.md, "Calendar dates are
  // not instants").
  const nextDueOn = r.nextDueOn ?? startOfDayUtc(new Date(), await getHouseTimezone());
```

and replace `nextDueOn: r.nextDueOn ?? new Date(),` with `nextDueOn,`.

- [ ] **Step 17: Run it, typecheck, commit**

```bash
pnpm exec vitest run "app/(app)/reminders/[id]/edit/page.test.tsx"
pnpm typecheck
pnpm lint:fix   # new/changed imports: Biome may reorder specifiers
git add "app/(app)/reminders/[id]/edit/page.tsx" "app/(app)/reminders/[id]/edit/page.test.tsx"
git commit -m "fix(reminders): default a target-less reminder's due date to the house day, not an instant"
git log --oneline -1   # confirm HEAD moved
```

Expected: PASS and typecheck clean before committing.

---

### Task 4: Q-H3 — reserved metadata keys are server-owned

**Files:**
- Modify: `lib/metadata/reserved-keys.ts` (header checklist and two new exports)
- Modify: `lib/metadata/reserved-keys.test.ts`
- Modify: `components/items/ItemForm.tsx:29-31` (import), `:68-75` (defaults)
- Modify: `components/parts/PartForm.tsx:29-31` (import), `:56-65` (defaults)
- Modify: `components/items/ItemForm.test.tsx`, `components/parts/PartForm.test.tsx`
- Modify: `lib/items/actions.ts:9` (import), `:123-138`
- Modify: `lib/parts/actions.ts:10` (import), `:88-108`
- Create: `tests/integration/metadata-provenance-preserved.test.ts`

- [ ] **Step 1: Write the failing unit tests**

In `lib/metadata/reserved-keys.test.ts`, replace the import block with:

```ts
import {
  isReservedMetadataKey,
  RESERVED_METADATA_PREFIX,
  stripReservedMetadata,
  visibleMetadataEntries,
  withStoredReservedMetadata,
} from './reserved-keys';
```

and append:

```ts
const PROVENANCE = { name: 'user', amps: 'inferred' };

describe('stripReservedMetadata', () => {
  it('returns the visible keys as an object', () => {
    expect(stripReservedMetadata({ _provenance: PROVENANCE, amps: 15 })).toEqual({ amps: 15 });
  });

  it('returns an empty object for the non-object shapes a Json column can hold', () => {
    for (const v of [null, undefined, 'a string', ['an', 'array']]) {
      expect(stripReservedMetadata(v)).toEqual({});
    }
  });
});

describe('withStoredReservedMetadata', () => {
  it('re-attaches the stored reserved keys to the incoming spec', () => {
    expect(withStoredReservedMetadata({ amps: 20 }, { _provenance: PROVENANCE, amps: 15 })).toEqual(
      { amps: 20, _provenance: PROVENANCE },
    );
  });

  it('discards a reserved key the client sent in favour of the stored one', () => {
    expect(
      withStoredReservedMetadata(
        { amps: 20, _provenance: { name: 'forged' } },
        { _provenance: PROVENANCE },
      ),
    ).toEqual({ amps: 20, _provenance: PROVENANCE });
  });

  it('drops a client-sent reserved key when nothing is stored', () => {
    expect(withStoredReservedMetadata({ amps: 20, _provenance: {} }, { amps: 15 })).toEqual({
      amps: 20,
    });
  });

  it('tolerates a null stored blob', () => {
    expect(withStoredReservedMetadata({ amps: 20 }, null)).toEqual({ amps: 20 });
  });
});
```

- [ ] **Step 2: Write the failing form tests (assert the SUBMITTED payload)**

In `components/items/ItemForm.test.tsx`, add this test directly after `it('excludes reserved keys from the freeform metadata textarea', …)`:

```tsx
  // Hiding `_provenance` from the textarea (#328) was not enough: the textarea
  // is uncontrolled, so the key still rode along in the RHF field value and an
  // UNTOUCHED save submitted it into freeformMetadataSchema's reserved-key
  // rejection. Assert on the payload, not the textarea.
  it('submits an untouched AI-captured item without its reserved keys', async () => {
    const action = makeAction({ ok: true, data: { id: 'i1' } });
    const user = userEvent.setup();

    render(
      <ItemForm
        categories={categories}
        defaultValues={{
          id: 'i1',
          name: 'Backyard String Lights',
          categorySlug: 'other',
          metadata: { _provenance: { name: 'user', location: 'inferred' }, bulbBase: 'E26' },
        }}
        action={action}
        submitLabel="Save item"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Save item' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));

    const payload = action.mock.calls[0]?.[0] as { metadata: unknown };
    expect(payload.metadata).toEqual({ bulbBase: 'E26' });
  });
```

In `components/parts/PartForm.test.tsx`, add inside `describe('PartForm', …)`:

```tsx
  // For parts the #328 leak is worse than for items: createPartSchema's
  // superRefine runs client-side through zodResolver, so a freeform part
  // carrying `_provenance` would not submit AT ALL. The action is never called.
  it('submits an untouched AI-captured freeform part without its reserved keys', async () => {
    const action = makeAction({ ok: true, data: { id: 'p9' } });
    const user = userEvent.setup();

    render(
      <PartForm
        defaultValues={{
          id: 'p9',
          name: 'Mystery fuse',
          kind: 'OTHER',
          metadata: { _provenance: { name: 'user', amps: 'inferred' }, amps: 15 },
        }}
        action={action}
        submitLabel="Save part"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Save part' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));

    const payload = action.mock.calls[0]?.[0] as { metadata: unknown };
    expect(payload.metadata).toEqual({ amps: 15 });
  });
```

- [ ] **Step 3: Write the failing integration test**

Create `tests/integration/metadata-provenance-preserved.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

// Q-H3's server half. Reserved metadata keys (`_provenance`, written only by
// chat apply) are server-owned: the edit forms never carry them, freeform
// validation rejects them, and every STRUCTURED schema is a plain z.object that
// silently strips them. So an update that wrote the validated blob verbatim
// dropped provenance on every edit. These pin that updateItem / updatePart
// re-attach the stored keys, and that a client can never overwrite them.
vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'u1', name: 'Test' } })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/search/client', () => ({ enqueueSearchIndex: vi.fn(async () => {}) }));
vi.mock('@/lib/embedding/enqueue', () => ({ enqueueEmbed: vi.fn(async () => {}) }));

const PROVENANCE = { name: 'user', model: 'inferred' };

let ctx: IntegrationContext;
let items: typeof import('@/lib/items/actions');
let parts: typeof import('@/lib/parts/actions');
let otherCategoryId: string;
let applianceCategoryId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  items = await import('@/lib/items/actions');
  parts = await import('@/lib/parts/actions');
  otherCategoryId = (
    await ctx.prisma.category.upsert({
      where: { slug: 'other' },
      create: { slug: 'other', name: 'Other', sortOrder: 999 },
      update: {},
    })
  ).id;
  applianceCategoryId = (
    await ctx.prisma.category.upsert({
      where: { slug: 'appliance' },
      create: { slug: 'appliance', name: 'Appliance', sortOrder: 10 },
      update: {},
    })
  ).id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.partLink.deleteMany();
  await ctx.prisma.part.deleteMany();
  await ctx.prisma.item.deleteMany();
});

describe('updateItem keeps server-owned metadata keys', () => {
  it('re-attaches _provenance on a freeform item', async () => {
    const item = await ctx.prisma.item.create({
      data: {
        name: 'String lights',
        categoryId: otherCategoryId,
        metadata: { _provenance: PROVENANCE, bulbBase: 'E26' },
      },
    });

    const r = await items.updateItem({
      id: item.id,
      name: 'String lights',
      categorySlug: 'other',
      metadata: { bulbBase: 'E27' },
    });

    expect(r).toEqual({ ok: true, data: { id: item.id } });
    const after = await ctx.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.metadata).toEqual({ bulbBase: 'E27', _provenance: PROVENANCE });
  });

  // The silent half: a structured z.object strips unknown keys, so this lost
  // provenance on every edit even before the form bug surfaced.
  it('re-attaches _provenance on a structured-category item', async () => {
    const item = await ctx.prisma.item.create({
      data: {
        name: 'Fridge',
        categoryId: applianceCategoryId,
        metadata: { _provenance: PROVENANCE, applianceType: 'refrigerator' },
      },
    });

    const r = await items.updateItem({
      id: item.id,
      categorySlug: 'appliance',
      metadata: { applianceType: 'freezer' },
    });

    expect(r.ok).toBe(true);
    const after = await ctx.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.metadata).toEqual({ applianceType: 'freezer', _provenance: PROVENANCE });
  });

  it('never lets a client overwrite the stored _provenance', async () => {
    const item = await ctx.prisma.item.create({
      data: {
        name: 'Fridge',
        categoryId: applianceCategoryId,
        metadata: { _provenance: PROVENANCE, applianceType: 'refrigerator' },
      },
    });

    const r = await items.updateItem({
      id: item.id,
      categorySlug: 'appliance',
      metadata: { applianceType: 'freezer', _provenance: { name: 'forged' } },
    });

    expect(r.ok).toBe(true);
    const after = await ctx.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.metadata).toEqual({ applianceType: 'freezer', _provenance: PROVENANCE });
  });
});

describe('updatePart keeps server-owned metadata keys', () => {
  it('re-attaches _provenance on a freeform (OTHER) part', async () => {
    const part = await ctx.prisma.part.create({
      data: { name: 'Mystery fuse', kind: 'OTHER', metadata: { _provenance: PROVENANCE, amps: 15 } },
    });

    const r = await parts.updatePart({
      id: part.id,
      name: 'Mystery fuse',
      kind: 'OTHER',
      metadata: { amps: 20 },
    });

    expect(r).toEqual({ ok: true, data: { id: part.id } });
    const after = await ctx.prisma.part.findUniqueOrThrow({ where: { id: part.id } });
    expect(after.metadata).toEqual({ amps: 20, _provenance: PROVENANCE });
  });

  it('re-attaches _provenance on a structured kind when kind is not resent', async () => {
    const part = await ctx.prisma.part.create({
      data: { name: 'Can light', kind: 'BULB', metadata: { _provenance: PROVENANCE, base: 'E26' } },
    });

    const r = await parts.updatePart({ id: part.id, metadata: { base: 'E12' } });

    expect(r.ok).toBe(true);
    const after = await ctx.prisma.part.findUniqueOrThrow({ where: { id: part.id } });
    expect(after.metadata).toEqual({ base: 'E12', _provenance: PROVENANCE });
  });
});
```

- [ ] **Step 4: Run all three and confirm they fail**

```bash
pnpm exec vitest run lib/metadata/reserved-keys.test.ts components/items/ItemForm.test.tsx components/parts/PartForm.test.tsx tests/integration/metadata-provenance-preserved.test.ts
```

Expected: FAIL.
- `reserved-keys.test.ts`: `stripReservedMetadata is not a function` (and the same for `withStoredReservedMetadata`).
- `ItemForm`: `payload.metadata` contains `_provenance`.
- `PartForm`: the `waitFor` times out because the action is never called (client-side rejection).
- Integration: every case gets `after.metadata` without `_provenance`. The "forged" case also fails.

- [ ] **Step 5: Implement the helpers**

In `lib/metadata/reserved-keys.ts`, replace the checklist in the header comment:

```ts
// Three enforcement points, and this list is a CHECKLIST TO EXTEND, not a
// description of a finished job:
//   - write path      — `lib/categories.ts` rejects them
//   - embedding path  — `lib/embedding/canonicalize.ts` drops them
//   - read path       — `visibleMetadataEntries` below, used by every view
//                       that enumerates a metadata blob
```

with:

```ts
// Four enforcement points, and this list is a CHECKLIST TO EXTEND, not a
// description of a finished job:
//   - write path      — `lib/categories.ts` rejects them
//   - embedding path  — `lib/embedding/canonicalize.ts` drops them
//   - read path       — `visibleMetadataEntries` below, used by every view
//                       that enumerates a metadata blob
//   - edit path       — `ItemForm` / `PartForm` strip them from their default
//                       values (`stripReservedMetadata`), and `updateItem` /
//                       `updatePart` re-attach the STORED ones on save
//                       (`withStoredReservedMetadata`). They are server-owned.
```

Append at the end of the file:

```ts
/**
 * A metadata blob with reserved keys removed, as an object — the shape a
 * form's default values need.
 *
 * Hiding them only in the rendered textarea is not enough: the textarea is
 * uncontrolled, so a hidden key still rides along in the form's field value
 * and an untouched save submits it.
 */
export function stripReservedMetadata(metadata: unknown): Record<string, unknown> {
  return Object.fromEntries(visibleMetadataEntries(metadata));
}

/**
 * Re-attach the reserved keys of the STORED blob to a validated incoming one.
 *
 * Reserved keys are server-owned. Forms never carry them, freeform validation
 * rejects them, and every structured schema is a plain `z.object` that strips
 * them, so an update action that wrote the validated blob verbatim dropped
 * `_provenance` on every edit. The stored keys always win, and any reserved
 * key the client sent is discarded — a client can never set one.
 */
export function withStoredReservedMetadata(
  next: unknown,
  stored: unknown,
): Record<string, unknown> {
  const reserved =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? Object.entries(stored as Record<string, unknown>).filter(([key]) =>
          isReservedMetadataKey(key),
        )
      : [];
  return { ...stripReservedMetadata(next), ...Object.fromEntries(reserved) };
}
```

- [ ] **Step 6: Strip in the forms**

In `components/items/ItemForm.tsx`, add the import after the `@/lib/items/schema` import:

```ts
import { stripReservedMetadata } from '@/lib/metadata/reserved-keys';
```

and replace:

```ts
    defaultValues: {
      name: '',
      categorySlug: '',
      metadata: {},
      ...defaultValues,
    },
```

with:

```ts
    defaultValues: {
      name: '',
      categorySlug: '',
      ...defaultValues,
      // Reserved keys (`_provenance`) are server-owned — updateItem re-attaches
      // the stored ones. Stripped from the FIELD VALUE, not just the textarea:
      // see stripReservedMetadata. `undefined` → `{}`, the old default.
      metadata: stripReservedMetadata(defaultValues?.metadata),
    },
```

In `components/parts/PartForm.tsx`, add the import after the `@/lib/forms/helpers` import:

```ts
import { stripReservedMetadata } from '@/lib/metadata/reserved-keys';
```

and replace:

```ts
    defaultValues: {
      name: '',
      kind: 'OTHER',
      purchaseLinks: [],
      metadata: {},
      ...defaultValues,
    },
```

with:

```ts
    defaultValues: {
      name: '',
      kind: 'OTHER',
      purchaseLinks: [],
      ...defaultValues,
      // Reserved keys (`_provenance`) are server-owned — updatePart re-attaches
      // the stored ones. Left in, createPartSchema's client-side refine rejects
      // the whole form on a field the user never touched.
      metadata: stripReservedMetadata(defaultValues?.metadata),
    },
```

- [ ] **Step 7: Merge server-side in `updateItem`**

In `lib/items/actions.ts`, add after the `freeformMetadataSchema` import:

```ts
import { withStoredReservedMetadata } from '@/lib/metadata/reserved-keys';
```

Replace:

```ts
  if (metadata !== undefined) {
    const slug =
      categorySlug ??
      (
        await prisma.item.findUnique({
          where: { id },
          select: { category: { select: { slug: true } } },
        })
      )?.category.slug;
    if (slug) {
      const metadataResult = metadataSchemaFor(slug).safeParse(metadata);
      if (!metadataResult.success) {
        return { ok: false, fieldErrors: metadataFieldErrors(metadataResult.error.issues, slug) };
      }
      data.metadata = metadataResult.data as object;
    }
  }
```

with:

```ts
  if (metadata !== undefined) {
    // One read for both: the stored category (when the slug did not travel with
    // the update) and the stored reserved keys to carry over.
    const stored = await prisma.item.findUnique({
      where: { id },
      select: { metadata: true, category: { select: { slug: true } } },
    });
    const slug = categorySlug ?? stored?.category.slug;
    if (slug) {
      const metadataResult = metadataSchemaFor(slug).safeParse(metadata);
      if (!metadataResult.success) {
        return { ok: false, fieldErrors: metadataFieldErrors(metadataResult.error.issues, slug) };
      }
      // Reserved keys (`_provenance`) are server-owned — see withStoredReservedMetadata.
      data.metadata = withStoredReservedMetadata(metadataResult.data, stored?.metadata);
    }
  }
```

- [ ] **Step 8: Merge server-side in `updatePart`**

In `lib/parts/actions.ts`, add after the `freeformMetadataSchema` import:

```ts
import { withStoredReservedMetadata } from '@/lib/metadata/reserved-keys';
```

Replace:

```ts
  if (metadata !== undefined) {
    // The schema validated metadata only when `kind` travelled with it; when it
    // did not, resolve the stored kind here.
    let kind = rest.kind;
    if (kind === undefined) {
      const existing = await prisma.part.findUnique({ where: { id }, select: { kind: true } });
      if (!existing) return { ok: false, formError: 'Part not found' };
      kind = existing.kind;
    }
    const result = partKindSchemaFor(kind).safeParse(metadata ?? {});
```

with:

```ts
  if (metadata !== undefined) {
    // One read for both: the stored kind (the schema validated metadata only
    // when `kind` travelled with it) and the stored reserved keys to carry over.
    const existing = await prisma.part.findUnique({
      where: { id },
      select: { kind: true, metadata: true },
    });
    if (!existing) return { ok: false, formError: 'Part not found' };
    const kind = rest.kind ?? existing.kind;
    const result = partKindSchemaFor(kind).safeParse(metadata ?? {});
```

and replace:

```ts
    data.metadata = result.data as Prisma.InputJsonValue;
```

with:

```ts
    // Reserved keys (`_provenance`) are server-owned — see withStoredReservedMetadata.
    data.metadata = withStoredReservedMetadata(
      result.data,
      existing.metadata,
    ) as Prisma.InputJsonValue;
```

- [ ] **Step 9: Run everything touched and confirm it passes**

```bash
pnpm exec vitest run lib/metadata/reserved-keys.test.ts components/items/ItemForm.test.tsx components/parts/PartForm.test.tsx tests/integration/metadata-provenance-preserved.test.ts tests/integration/items-metadata-reserved-key.test.ts tests/integration/items-metadata-errors.test.ts tests/integration/parts-crud.test.ts tests/integration/items.test.ts
pnpm typecheck
```

Expected: all PASS. `items-metadata-reserved-key.test.ts` still passes because `createItem` rejects a user-typed reserved key exactly as before, and nothing here strips *incoming* keys before validation. The existing "does not wipe stored metadata" form tests still pass because only reserved keys are stripped.

- [ ] **Step 10: Commit**

```bash
pnpm lint:fix   # new/changed imports: Biome may reorder specifiers
git add lib/metadata/reserved-keys.ts lib/metadata/reserved-keys.test.ts components/items/ItemForm.tsx components/items/ItemForm.test.tsx components/parts/PartForm.tsx components/parts/PartForm.test.tsx lib/items/actions.ts lib/parts/actions.ts tests/integration/metadata-provenance-preserved.test.ts
git commit -m "fix(metadata): AI-captured records save from the edit form and keep their _provenance"
git log --oneline -1   # confirm HEAD moved
```

---

### Task 5: Docs — correct the claims this PR falsifies

No `docs/*.md` or `CLAUDE.md` statement changes (verified by grepping for multi-parent, system delete, `_provenance`, `deleteAttachment`). Two in-code claims are now wrong, and one of them was already wrong.

**Files:**
- Modify: `lib/chat/actions.ts:1196-1199` (comment only)

- [ ] **Step 1: Fix the false "cannot recur" comment**

In `lib/chat/actions.ts`, replace:

```ts
  // The spec and `_provenance` share the `metadata` column, so this merges
  // rather than overwrites. Safe to write provenance here because
  // PartKindFields and the part Overview tab both strip reserved keys — the
  // #328 leak/unsaveable-form pair cannot recur.
```

with:

```ts
  // The spec and `_provenance` share the `metadata` column, so this merges
  // rather than overwrites. Safe to write provenance here because every
  // boundary treats reserved keys as server-owned: the Overview tabs hide
  // them, PartForm strips them from its defaults, and updatePart re-attaches
  // the stored ones on save (withStoredReservedMetadata,
  // lib/metadata/reserved-keys.ts). Hiding them in the textarea alone was NOT
  // enough — see Q-H3.
```

- [ ] **Step 2: Confirm no other stale claims**

```bash
grep -rn "cannot recur\|references the direct Item link" lib components app tests
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add lib/chat/actions.ts
git commit -m "docs(chat): correct the reserved-metadata comment the form fix falsified"
git log --oneline -1   # confirm HEAD moved
```

---

### Task 6: Full verification

- [ ] **Step 1: The pre-push gate**

```bash
pnpm verify
```

Expected: Biome, `lint:tokens`, `lint:worker-graph` and `lint:knip` pass, `tsc --noEmit` is clean, and every unit test passes. That includes `search-index-drift` and `embed-drift`: the only new attachment write outside `lib/attachments/actions.ts` lives in the exempted `create-service-record.ts`, and `lib/systems/actions.ts` writes only `reminderTarget`, which neither guard indexes.

- [ ] **Step 2: Every touched integration file**

```bash
pnpm exec vitest run tests/integration/attachment-ownership.test.ts tests/integration/system-delete-dependents.test.ts tests/integration/system-delete-parts.test.ts tests/integration/metadata-provenance-preserved.test.ts tests/integration/incoming-email-actions.test.ts tests/integration/incoming-email-classify-job.test.ts tests/integration/service-records.test.ts tests/integration/attachments.test.ts tests/integration/part-attachments.test.ts tests/integration/items-metadata-reserved-key.test.ts tests/integration/parts-crud.test.ts tests/integration/reminders-chores-optional-targets.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Full suite, e2e and coverage floor**

The confirm step changed a Playwright flow (`parts.spec.ts`), and CI runs only `@critical` e2e.

```bash
pnpm test:local
```

Expected: unit → integration → full e2e → coverage floor all green. **Never lower a threshold in `vitest.config.ts`.** If an e2e fails with `Executable doesn't exist at …chrome-headless-shell`, run `pnpm exec playwright install`. That is a stale browser cache, not a test failure.

---

### Task 7: PR

- [ ] **Step 1: Wait for PR A, then rebase**

```bash
gh pr list --state merged --search "inbound-email security" --limit 5   # confirm PR A merged
git fetch origin
git rebase origin/main
```

Resolve any conflicts (none are expected, since no files overlap). **Never `--no-verify`.**

- [ ] **Step 2: Re-verify the one assumption about PR A's files**

`attachmentStorageDirs` removes `dirname(storagePath)` recursively. That is only safe if **every inbound attachment still gets a directory of its own**.

```bash
grep -n "atomicWrite\|const dir\|storagePath" lib/incoming-email/ingest.ts lib/attachments/*.ts
```

Confirm the inbound layout is still one directory per attachment: today it is `inbound/<xx>/<fresh cuid>/<name>`, and a PR A move to `<attachmentId>/…` would also be fine. **If PR A introduced a shared per-email directory, STOP.** Report back, because deleting one attachment would then delete its siblings. Then rerun Task 6 Steps 1–2.

- [ ] **Step 3: Copy this plan into the repo and commit it**

```bash
cp .full-review/plans/2026-09-24-data-integrity-fixes.md docs/superpowers/plans/2026-09-24-data-integrity-fixes.md
git add docs/superpowers/plans/2026-09-24-data-integrity-fixes.md
git commit -m "docs(plans): data integrity fixes implementation plan"
git log --oneline -1   # confirm HEAD moved
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin fix/data-integrity
gh pr create --title "fix: data integrity — inbound attachments, system delete, attachment dirs, _provenance" --body "$(cat <<'EOF'
Fixes four data-loss paths from the 2026-09 full review (Q-H4, Q-M6, Q-H5, Q-H3). No schema change, no migration.

- **Q-H4** Deleting a drafted service record (or "deleting" an inbound attachment from its page) no longer destroys the email's original. Email-owned attachments are unlinked in the same transaction (`detachEmailOwnedAttachments`, next to the shared hand-off both the button and the worker auto-stub use).
- **Q-M6** `deleteAttachment` removes the directories derived from the stored paths (inbound files live under `inbound/<xx>/<cuid>/`), and `removeDir` now refuses `FILES_DIR` itself.
- **Q-H5** Every system delete is confirmed (AlertDialog). It is refused, with a linked list, when a REMINDER, warranty or unanchored service record would be left with zero targets. A sole-target CHORE becomes standalone in place, keeping cadence and completion history. Both `tryDeleteSystem` and `deleteSystemWithParts` check inside their transaction. The reminder edit page's target-less fallback is now the house day, not an instant.
- **Q-H3** Reserved metadata keys are server-owned: the forms strip them from their defaults, and `updateItem`/`updatePart` re-attach the stored ones. This also fixes a silent loss: structured schemas stripped `_provenance` on every edit.

**For PR B (embeddings):** `deleteServiceRecord` now cascades only attachments with `incomingEmailId IS NULL`; the email-owned ones survive (unlinked). Tombstone only the cascaded set. `deleteAttachment` has a new early-return unlink branch, and your `enqueueEmbed('ATTACHMENT', id)` belongs after the delete below it. An unlinked attachment's canonical text changes parent, so it may want a re-embed. That also makes the `tests/unit/lib/embed-drift.test.ts` exemption for `lib/incoming-email/create-service-record.ts` (ATTACHMENT, "embedded content (extractedText) is unchanged") false: canonical attachment text includes the parent name, and both the link (draft) and the unlink (`detachEmailOwnedAttachments`) change it. PR C deliberately leaves that exemption alone; PR B owns correcting it, or enqueueing the re-embed so it can be dropped.

Plan: `docs/superpowers/plans/2026-09-24-data-integrity-fixes.md`.

Test plan: `pnpm verify`; the integration files in Task 6; `pnpm test:local` (full e2e + coverage floor).
EOF
)"
```

- [ ] **Step 5: Watch Sourcery first (background), then address its comments**

Run in the background (`run_in_background: true`). Watch **only** the `Sourcery review` check:

```bash
PR=$(gh pr view --json number --jq .number)
until gh pr checks "$PR" --json name,state --jq '.[] | select(.name=="Sourcery review") | .state' | grep -qE 'SUCCESS|FAILURE|SKIPPED|NEUTRAL|CANCELLED'; do sleep 30; done
gh api "repos/{owner}/{repo}/pulls/$PR/reviews" --jq '.[] | select(.user.login | test("sourcery")) | .body'
gh api "repos/{owner}/{repo}/pulls/$PR/comments" --jq '.[] | select(.user.login | test("sourcery")) | {path, line, body}'
```

The check reports pass/skipping even when Sourcery hit its per-PR or weekly limit, so read the review **body**. Address real comments with new commits (explicit `git add`, verify HEAD moved, push). If Sourcery doesn't show up after about 20 minutes, check the PR directly, then continue.

- [ ] **Step 6: Enable auto-merge, then watch CI (background)**

```bash
gh pr merge --auto --squash
gh pr checks --watch --fail-fast   # run_in_background: true
```

On a failure, fix it, push, and watch again. Once it has merged:

```bash
gh pr view --json state --jq .state      # expect MERGED
git checkout main && git pull --ff-only && git branch -d fix/data-integrity
```

- [ ] **Step 7 (optional, read-only): find records orphaned before this fix**

These queries are read-only and safe against prod (use `op run` for credentials; never mutate prod). Resolve any hits through the UI:

```sql
-- REMINDERs (chores may legitimately have a standalone row) with zero targets
SELECT r.id, r.title FROM reminders r
WHERE r.kind = 'REMINDER'
  AND NOT EXISTS (SELECT 1 FROM reminder_targets t WHERE t."reminderId" = r.id);
-- CHOREs left with neither a link nor the standalone row
SELECT r.id, r.title FROM reminders r
WHERE r.kind = 'CHORE'
  AND NOT EXISTS (SELECT 1 FROM reminder_targets t WHERE t."reminderId" = r.id);
-- Warranties with zero targets
SELECT w.id, w.provider FROM warranties w
WHERE NOT EXISTS (SELECT 1 FROM warranty_targets t WHERE t."warrantyId" = w.id);
-- Unanchored service records
SELECT s.id, s.summary FROM service_records s
WHERE s."vendorId" IS NULL AND s."selfPerformed" = false
  AND NOT EXISTS (SELECT 1 FROM service_record_targets t WHERE t."serviceRecordId" = s.id);
```

Inbound attachments already lost to Q-H4 can't be recovered from the DB. The email body still exists in the inbox.

---

## Notes for PR B (embeddings) — handoff

PR B owns these; PR C does not touch them. The same text is in the PR body.
- **Cascade set changed.** `deleteServiceRecord` now cascades only attachments with `incomingEmailId IS NULL`. Email-owned ones are unlinked by `detachEmailOwnedAttachments` and survive. Tombstone only the cascaded set, for example by selecting `attachments: { where: { incomingEmailId: null } }` before the transaction.
- **`deleteAttachment` has a new early-return unlink branch** for email-owned, SR-linked rows. The `enqueueEmbed('ATTACHMENT', id)` tombstone belongs after the `prisma.attachment.delete` below it, not in the unlink branch.
- **Canonical text changes on link and unlink.** `canonicalizeAttachment` names the parent ("Linked to …"), so linking at draft time and unlinking at delete time both change an attachment's embedded text. That means the `tests/unit/lib/embed-drift.test.ts` exemption for `lib/incoming-email/create-service-record.ts` (kind `ATTACHMENT`, reason "updateMany only sets serviceRecordId; embedded content (extractedText) is unchanged") is **wrong**. PR B should fix the reason, or enqueue a re-embed for linked/unlinked rows and drop the exemption. PR C leaves that file alone on purpose.

## Acceptance criteria

- [ ] Deleting an auto-stubbed or button-drafted service record leaves the email's attachments (row + file) intact and re-draftable.
- [ ] "Delete" on an inbound attachment from a service-record page removes it from the record only.
- [ ] Deleting an attachment removes the directory its file is actually in, and nothing can remove `FILES_DIR` itself.
- [ ] No system delete happens without a confirmation. A delete that would leave a REMINDER, warranty or unanchored service record target-less is refused with a linked list. Sole-target chores survive as standalone chores with their history.
- [ ] An AI-captured freeform item or part saves untouched from its edit form, and `_provenance` survives every edit.
- [ ] `pnpm verify` and `pnpm test:local` are green, and the coverage floor is met or raised.

## Deliberately out of scope

- **Embeddings** for deleted or unlinked attachments and for cascaded children belong to PR B.
- **Files left on disk by parent cascades.** `deleteServiceRecord`, `deleteNote` and `deleteWarranty` cascade their attachment rows but never remove the files. This is a separate orphan-file sweep.
- **A DB-level backstop** for "REMINDER has ≥1 target" (a deferred constraint trigger) or `RESTRICT` target FKs. The app-level guard is the policy here.
- **Search/embedding refresh** for records that lose a (non-sole) system target on delete. It is pre-existing and backfilled nightly by `search.reindex`.
- **`IncomingEmailTarget` cascade.** An email whose only target was the deleted system stays `LINKED` with no links. It is still listed in the inbox, so nothing is lost.
- `deleteAttachment(id: string)` / `deleteServiceRecord(id: string)` / `tryDeleteSystem(systemId: string)` not taking `input: unknown`: a pre-existing skeleton deviation. Left alone to keep PR B's diff clean.
- `updateReminder` **throwing** (instead of returning `formError`) when the calendar-date guard trips. This is pre-existing. 3C removes the one known trigger.
- The attachment card's trash icon still reads "Delete attachment" for an email-owned file on an SR page, where it now unlinks. That is a UX copy follow-up.
