# Inbound Email Ingestion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an inbound funnel for vendor emails (estimates, invoices, service tickets) via the ForwardEmail webhook. Persist each email as a first-class `IncomingEmail` row, expose them in a new top-level Inbox UI, and auto-create draft `ServiceRecord` stubs from high-confidence matches. See `docs/superpowers/specs/2026-05-08-inbound-email-design.md` for design rationale.

**Architecture:** New `IncomingEmail` model with `kind` and `state` enums and optional FKs to `Vendor`/`Item`/`System`. New `incomingEmailId` FK on `Attachment` so existing storage/thumbnail/AI-indexing pipelines apply unchanged. Single Next.js Route Handler at `/api/inbound-email/[token]` verifies HMAC against the raw request body, dedupes on `Message-ID`, persists synchronously, then enqueues a background classify job that mutates state. New top-level `/inbox` route. No changes to existing entities beyond the two new optional fields.

**Tech Stack:** Next.js 16 App Router, TypeScript, Prisma 7 + Postgres 16, Auth.js v5, RHF + Zod, shadcn (Base UI) components, Vitest 4, Playwright, pg-boss.

**Spec:** `docs/superpowers/specs/2026-05-08-inbound-email-design.md`

**ForwardEmail account:** Paid plan confirmed → `X-Webhook-Signature` HMAC header is available and is the primary auth defense.

---

## Conventions for the implementer

These conventions hold across every task. Don't deviate without flagging.

- **Cadence**: each phase below is a separate branch + PR off `main`, in order. Don't open later PRs until earlier ones land — the schema PR underpins everything else, and stacking them risks the auto-close pitfall flagged in `feedback_pr_ordering.md`.
- **Commits**: signed via 1Password (just `git commit` — no `-c user.email=`, no `--no-verify`, no `--no-gpg-sign`). Stage explicit paths, never `git add -A`. Conventional-commits prefixes: `feat(inbox):`, `fix(inbox):`, `test(inbox):`, `docs(inbox):`, `chore(inbox):`.
- **Module-load DATABASE_URL trap**: `lib/db.ts` constructs PrismaClient at module load. Integration tests for new server-only modules must use the dynamic-import-in-`beforeAll` pattern from `tests/integration/notify-job.test.ts`.
- **Domain layout**: `lib/incoming-email/{schema.ts,schema.test.ts,actions.ts,queries.ts,classify.ts,classify.test.ts}` and `lib/incoming-email/hmac.ts` for signature verification. Routes under `app/(app)/inbox/`. Components under `components/incoming-email/`. Worker job at `worker/jobs/classify-incoming-email.ts`.
- **Env vars**: two new entries, both required. `INBOUND_EMAIL_TOKEN` (32+ random chars, lives in DNS TXT and env) and `INBOUND_EMAIL_HMAC_KEY` (set in ForwardEmail's "Webhook Signature Payload Verification Key" UI; same value in env). Add to `lib/env.ts`, `.env.example`, and the deployment docs.
- **Dependency policy**: do not add new runtime dependencies. Node `crypto` covers HMAC; `mailparser` output is consumed without re-running mailparser server-side; `rehype-sanitize` already wired via `lib/markdown.tsx`. If a task seems to need a new dep, stop and re-check.
- **shadcn UI primitives available**: `avatar`, `badge`, `button`, `card`, `checkbox`, `dialog`, `dropdown-menu`, `form`, `input`, `label`, `select`, `separator`, `sheet`, `sidebar`, `skeleton`, `sonner`, `switch`, `table`, `tabs`, `textarea`. No new shadcn components in this plan.
- **Test database**: integration tests use the test-DB fixture pattern in `tests/integration/`. Each migration step must leave the DB in a state that the existing integration suite still passes against.
- **Webhook fixtures**: the test suite needs at least three fixtures captured from real ForwardEmail deliveries (or hand-crafted to mailparser shape): a plain-text invoice, an HTML estimate with two PDF attachments, and a service ticket with inline image references. Park them under `tests/fixtures/inbound-email/`.

---

## File map

This plan creates or modifies the following files. (Exact code snippets appear in each task.)

**Schema & migrations (Phase A):**
- Modify `prisma/schema.prisma` — add `IncomingEmail`, `IncomingEmailKind` enum, `IncomingEmailState` enum; add `incomingEmailId` FK to `Attachment`; add back-relation on `ServiceRecord`, `Vendor`, `Item`, `System`.
- Create `prisma/migrations/<timestamp>_add_incoming_emails/migration.sql`.

**Server domain (Phase B):**
- Create `lib/incoming-email/schema.ts` — Zod schema for the ForwardEmail webhook payload.
- Create `lib/incoming-email/schema.test.ts`.
- Create `lib/incoming-email/hmac.ts` — `verifyWebhookSignature(rawBody, signatureHeader)`; constant-time HMAC-SHA256 compare.
- Create `lib/incoming-email/hmac.test.ts`.
- Create `lib/incoming-email/actions.ts` — `ingestIncomingEmail`, `archiveIncomingEmail`, `attachIncomingEmail`, `setIncomingEmailKind`, `promoteToServiceRecord`.
- Create `lib/incoming-email/queries.ts` — list + detail + untriaged-count loaders.
- Modify `lib/env.ts` — add `INBOUND_EMAIL_TOKEN`, `INBOUND_EMAIL_HMAC_KEY`.
- Modify `.env.example`.
- Modify `lib/queue.ts` — add `Queue.ClassifyIncomingEmail`.
- Create `app/api/inbound-email/[token]/route.ts` — Route Handler.
- Create `worker/jobs/classify-incoming-email.ts`.
- Modify `worker/index.ts` — register the new queue worker.

**Classifier (Phase D):**
- Create `lib/incoming-email/classify.ts` — pure function, no DB calls.
- Create `lib/incoming-email/classify.test.ts`.

**Components (Phase C):**
- Create `components/incoming-email/InboxList.tsx`, `components/incoming-email/IncomingEmailCard.tsx`, `components/incoming-email/EmailBodyView.tsx`, `components/incoming-email/LinkPicker.tsx`.
- Modify `app/(app)/_components/AppSidebar.tsx` — add Inbox entry with badge.

**Routes (Phase C):**
- Create `app/(app)/inbox/page.tsx` (list with Untriaged / Archived tabs).
- Create `app/(app)/inbox/[id]/page.tsx` (detail).

**Tests:**
- Unit: `lib/incoming-email/{schema,hmac,classify}.test.ts`.
- Integration: `tests/integration/inbound-email-webhook.test.ts`, `tests/integration/incoming-email-classify-job.test.ts`, `tests/integration/incoming-email-actions.test.ts`.
- Smoke (Phase C): `tests/smoke/inbox.spec.ts`.
- Fixtures: `tests/fixtures/inbound-email/{invoice-plain.json,estimate-html.json,ticket-inline-image.json}`.

---

## Pre-flight (Task 0)

Confirm audit-time facts before starting Phase A. If any check fails, surface it before continuing.

- [ ] **Verify Prisma version and tooling**:
  ```bash
  pnpm prisma -v 2>&1 | head -3
  ```
  Expected: Prisma 7.x.

- [ ] **Verify the existing `Attachment` shape**:
  ```bash
  awk '/^model Attachment /,/^}$/' prisma/schema.prisma | head -50
  ```
  Expected: Attachment has `itemId`, `warrantyId`, `serviceRecordId`, `noteId` FKs; `aiIndexable Boolean @default(true)`; `extractedText` and `thumbnailPath` fields. Confirm we're adding a fifth optional FK alongside the existing four.

- [ ] **Verify the existing `Queue` enum and worker registration pattern**:
  ```bash
  cat lib/queue.ts
  grep -n "boss.work\|boss.send\|Queue\." worker/index.ts
  ```
  Expected: enum string-literal style; `boss.work` registration loop pattern. The new `Queue.ClassifyIncomingEmail` will follow the same shape.

- [ ] **Verify mailparser shape against fixtures**: capture one real ForwardEmail webhook delivery (or look in `My Account → Emails` in the FE dashboard). Save the JSON body verbatim under `tests/fixtures/inbound-email/`. If you don't have an alias configured yet, hand-craft a minimal fixture matching the spec's shape — the schema task validates the shape we *expect* so this is acceptable.

- [ ] **Run the full test suite** to capture a baseline:
  ```bash
  pnpm test --run 2>&1 | tail -10
  ```
  Expected: passing. Save the output for later regression-check.

- [ ] **Confirm paid-plan HMAC capability**: log in to ForwardEmail → My Account → Domains → Settings → "Webhook Signature Payload Verification Key" exists and is rotatable. If the field isn't visible, the account is on a free plan and Phase B's auth design needs revisiting before continuing.

---

# Phase A — Schema (PR 1: `feat/inbox-schema`)

Single PR: schema additions + migration + minimal Zod scaffolding + integration test that the row can be inserted/read. No webhook handler, no UI, no classifier.

## Task A1: IncomingEmail model + enums + Attachment FK

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_incoming_emails/migration.sql`

- [ ] **Step 1: Add enums and model in `prisma/schema.prisma`**

After the `ServiceRecord` model block, add:

```prisma
enum IncomingEmailKind {
  ESTIMATE
  INVOICE
  TICKET
  UNKNOWN
}

enum IncomingEmailState {
  UNTRIAGED
  AUTO_LINKED
  LINKED
  ARCHIVED
}

model IncomingEmail {
  id              String              @id @default(cuid())

  messageId       String              @unique
  fromAddress     String
  fromName        String?
  subject         String
  receivedAt      DateTime
  ingestedAt      DateTime            @default(now())

  bodyText        String?             @db.Text
  bodyHtml        String?             @db.Text
  headersJson     Json
  authResultsJson Json?

  kind            IncomingEmailKind   @default(UNKNOWN)
  state           IncomingEmailState  @default(UNTRIAGED)

  vendorId        String?
  vendor          Vendor?             @relation(fields: [vendorId], references: [id], onDelete: SetNull)
  itemId          String?
  item            Item?               @relation(fields: [itemId], references: [id], onDelete: SetNull)
  systemId        String?
  system          System?             @relation(fields: [systemId], references: [id], onDelete: SetNull)

  createdServiceRecordId String?
  createdServiceRecord   ServiceRecord? @relation("IncomingEmailServiceRecord", fields: [createdServiceRecordId], references: [id], onDelete: SetNull)

  attachments     Attachment[]

  archivedAt      DateTime?

  @@index([state])
  @@index([receivedAt])
  @@index([vendorId])
  @@index([itemId])
  @@index([systemId])
  @@index([kind])
  @@map("incoming_emails")
}
```

- [ ] **Step 2: Add the FK column to `Attachment`**

In `model Attachment`, after the existing `noteId` line:

```prisma
  incomingEmailId String?
  incomingEmail   IncomingEmail? @relation(fields: [incomingEmailId], references: [id], onDelete: Cascade)
```

And in the index list:
```prisma
  @@index([incomingEmailId])
```

- [ ] **Step 3: Add back-relations**

In `Vendor`: `incomingEmails  IncomingEmail[]`.
In `Item`: `incomingEmails  IncomingEmail[]`.
In `System`: `incomingEmails  IncomingEmail[]`.
In `ServiceRecord`: `fromIncomingEmail IncomingEmail? @relation("IncomingEmailServiceRecord")`.

- [ ] **Step 4: Generate migration**

```bash
pnpm prisma migrate dev --create-only --name add_incoming_emails
```

Expected: a `prisma/migrations/<timestamp>_add_incoming_emails/migration.sql` containing two new enum types, a `CREATE TABLE incoming_emails`, all five expected indexes, and an `ALTER TABLE attachments ADD COLUMN "incomingEmailId"` plus its index.

- [ ] **Step 5: Apply the migration**

```bash
pnpm prisma migrate dev
```

Expected: migration applied; Prisma client regenerated.

- [ ] **Step 6: Quick integration test**

Create `tests/integration/incoming-email-crud.test.ts` (use the dynamic-import pattern). Cover:
- Insert an `IncomingEmail` with all required fields; row exists with default `kind=UNKNOWN`, `state=UNTRIAGED`.
- Insert with a duplicate `messageId` is rejected (unique constraint).
- Set `vendorId` to a real vendor; query through `vendor.incomingEmails` returns the row.
- Delete the vendor; the email still exists with `vendorId=null` (SetNull behavior).
- Insert an `Attachment` with `incomingEmailId`; deleting the email cascades to delete the attachment.

```bash
pnpm vitest run tests/integration/incoming-email-crud.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit and ship PR 1**

```bash
git checkout -b feat/inbox-schema
git add prisma/schema.prisma prisma/migrations/*_add_incoming_emails tests/integration/incoming-email-crud.test.ts
git commit -m "feat(inbox): add IncomingEmail model + Attachment FK + enums"
```

Open PR via `superpowers:finishing-a-development-branch`. Title: `feat(inbox): IncomingEmail schema + Attachment FK`. Body should reference the spec doc, list the four new SetNull/Cascade behaviors, and note "no code paths produce these rows yet — Phase B adds the webhook."

Wait for CI green + merge before starting Phase B.

---

# Phase B — Webhook handler (PR 2: `feat/inbox-webhook`)

Adds the Route Handler, HMAC verification, payload validation, dedup, attachment write-through, and the `classifyIncomingEmail` queue worker (stub — does nothing in this PR; Phase D fills it in). After this PR, real ForwardEmail deliveries hit the DB; UI still doesn't expose them.

## Task B1: Env vars + Queue entry

**Files:**
- Modify: `lib/env.ts`, `.env.example`, `lib/queue.ts`

- [ ] **Step 1**: Add to the Zod schema in `lib/env.ts`:
```ts
  INBOUND_EMAIL_TOKEN: z.string().min(16),
  INBOUND_EMAIL_HMAC_KEY: z.string().min(16),
```

- [ ] **Step 2**: Append to `.env.example`:
```
# Inbound email webhook (paired with ForwardEmail "inbox:" alias):
#   - INBOUND_EMAIL_TOKEN goes in the DNS TXT URL path (not a secret on its own).
#   - INBOUND_EMAIL_HMAC_KEY must match ForwardEmail's
#     "Webhook Signature Payload Verification Key" exactly.
INBOUND_EMAIL_TOKEN=
INBOUND_EMAIL_HMAC_KEY=
```

- [ ] **Step 3**: Add to `Queue` in `lib/queue.ts`:
```ts
  ClassifyIncomingEmail: 'incoming-email.classify',
```
The queue registration loop picks it up automatically.

- [ ] **Step 4**: Run `pnpm typecheck`. Expected: clean.

## Task B2: HMAC verifier

**Files:**
- Create: `lib/incoming-email/hmac.ts`, `lib/incoming-email/hmac.test.ts`

- [ ] **Step 1**: Write `hmac.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function computeWebhookSignature(rawBody: string, key: string): string {
  return createHmac('sha256', key).update(rawBody, 'utf8').digest('hex');
}

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  key: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = computeWebhookSignature(rawBody, key);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signatureHeader.trim(), 'hex');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 2**: Write `hmac.test.ts` covering: known-good signature passes; missing header → false; tampered body → false; wrong-length signature → false; empty key → false (and assert no exception).

- [ ] **Step 3**: `pnpm vitest run lib/incoming-email/hmac.test.ts`. Expected: PASS.

## Task B3: Payload Zod schema

**Files:**
- Create: `lib/incoming-email/schema.ts`, `lib/incoming-email/schema.test.ts`
- Create: `tests/fixtures/inbound-email/invoice-plain.json`, `estimate-html.json`, `ticket-inline-image.json`

- [ ] **Step 1**: Park the three fixtures captured during Pre-flight under `tests/fixtures/inbound-email/`. If hand-crafted, model them on the spec's payload table.

- [ ] **Step 2**: Write `schema.ts` exactly as in the spec's "Validation" section. Export `ForwardEmailWebhookSchema` and `type ForwardEmailWebhookBody = z.infer<typeof ForwardEmailWebhookSchema>`.

- [ ] **Step 3**: Write `schema.test.ts`:
- Each fixture parses cleanly.
- Missing `messageId` rejects.
- Invalid email in `from.value[0].address` rejects.
- Out-of-range byte (e.g., 256) in `attachments[*].content.data` rejects.
- Unknown top-level keys pass through (`.passthrough()` behavior).
- Empty `attachments` defaults to `[]`.

- [ ] **Step 4**: `pnpm vitest run lib/incoming-email/schema.test.ts`. Expected: PASS.

## Task B4: Ingest action

**Files:**
- Create: `lib/incoming-email/actions.ts` (partial — `ingestIncomingEmail` only)

- [ ] **Step 1**: Implement `ingestIncomingEmail(parsed: ForwardEmailWebhookBody): Promise<{ id: string; duplicate: boolean }>`. Behavior:
  1. Pre-check: `findUnique({ messageId })`. If found, return `{ id, duplicate: true }`.
  2. Open a transaction.
  3. Insert the `IncomingEmail` row using `prisma.incomingEmail.create` with `kind=UNKNOWN`, `state=UNTRIAGED`, `headersJson` = the parsed `headers` object (or `{}` if absent), `authResultsJson` = `{ dkim, spf, dmarc }`, `receivedAt` = `parsed.date ?? new Date()`, `bodyText` and `bodyHtml` from the payload.
  4. For each attachment in `parsed.attachments`: decode `Buffer.from(content.data)`, call `lib/attachments/storage.ts`'s `atomicWrite` to persist under a generated path, then `prisma.attachment.create({ data: { incomingEmailId: id, filename, mimeType: contentType, sizeBytes: size, storagePath, uploadedById: SYSTEM_USER_ID, aiIndexable: true } })`. Treat the system user id as a constant — see step 2 of Task B5.
  5. On unique-violation of `messageId` mid-insert (race against another in-flight delivery of the same Message-ID), catch Prisma `P2002` and re-fetch by `messageId` instead of erroring; return `{ id, duplicate: true }`.
  6. Commit; return `{ id, duplicate: false }`.

  Note: `uploadedById` in `Attachment` is non-nullable. The webhook isn't a user; we need a system principal. Resolve with the next step.

- [ ] **Step 2**: Decide on the system-uploader id. Two options:
  - (a) Reuse the existing single user as the uploader (this is a single-user app).
  - (b) Create a synthetic `User` row (e.g. id `system:inbound-email`) on first ingest and reuse.

  Recommended: (a) for now — query the single non-deleted `User` in the tenant and use that id. If the app grows to multi-user, revisit.

  Implement a tiny helper `getOrFetchInboundUserId(): Promise<string>` in `lib/incoming-email/actions.ts` that memoizes. Tests can override via DI.

## Task B5: Route Handler

**Files:**
- Create: `app/api/inbound-email/[token]/route.ts`

- [ ] **Step 1**: Implement the handler:

```ts
import { type NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { getBoss, Queue } from '@/lib/queue';
import { verifyWebhookSignature } from '@/lib/incoming-email/hmac';
import { ForwardEmailWebhookSchema } from '@/lib/incoming-email/schema';
import { ingestIncomingEmail } from '@/lib/incoming-email/actions';

const log = getLogger('inbound-email');
const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MB

export const runtime = 'nodejs';                // we need node:crypto
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const env = getEnv();
  const { token } = await params;

  const expected = Buffer.from(env.INBOUND_EMAIL_TOKEN);
  const got = Buffer.from(token);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    log.warn({ ip: req.headers.get('x-forwarded-for') }, 'inbound-email: token mismatch');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  }

  const sig = req.headers.get('x-webhook-signature');
  if (!verifyWebhookSignature(rawBody, sig, env.INBOUND_EMAIL_HMAC_KEY)) {
    log.warn({ ip: req.headers.get('x-forwarded-for') }, 'inbound-email: signature mismatch');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const parsed = ForwardEmailWebhookSchema.safeParse(json);
  if (!parsed.success) {
    log.error({ issues: parsed.error.issues }, 'inbound-email: schema validation failed');
    return NextResponse.json({ error: 'invalid payload' }, { status: 400 });
  }

  const result = await ingestIncomingEmail(parsed.data);

  if (!result.duplicate) {
    const boss = await getBoss();
    await boss.send(Queue.ClassifyIncomingEmail, { id: result.id });
  }

  return NextResponse.json({ id: result.id, duplicate: result.duplicate }, { status: 200 });
}
```

- [ ] **Step 2**: Auth.js middleware concerns: ensure `app/api/inbound-email/...` is excluded from auth-required routes. Check `middleware.ts` (or wherever auth gating lives) and add an exclusion if needed. Webhook calls have no session.

## Task B6: Classify-job stub worker

**Files:**
- Create: `worker/jobs/classify-incoming-email.ts`
- Modify: `worker/index.ts`

- [ ] **Step 1**: Stub the worker — for now, just load the email by id and log `{ id, subject }` at info level. Phase D replaces the body.

```ts
import { getLogger } from '@/lib/logger';
import { prisma } from '@/lib/db';

export type ClassifyIncomingEmailJob = { id: string };
const log = getLogger('classify-incoming-email');

export async function handleClassifyIncomingEmail(jobs: { data: ClassifyIncomingEmailJob }[]) {
  for (const { data } of jobs) {
    const row = await prisma.incomingEmail.findUnique({ where: { id: data.id } });
    if (!row) { log.warn({ id: data.id }, 'classify: row not found'); continue; }
    log.info({ id: row.id, subject: row.subject }, 'classify: stub (no-op)');
  }
}
```

- [ ] **Step 2**: Wire it in `worker/index.ts`:
```ts
await boss.work<ClassifyIncomingEmailJob>(
  Queue.ClassifyIncomingEmail,
  { batchSize: 4 },
  handleClassifyIncomingEmail,
);
```

## Task B7: Integration tests

**Files:**
- Create: `tests/integration/inbound-email-webhook.test.ts`

- [ ] **Step 1**: Test the full pipeline (route handler → DB) using fixture payloads. Cover:
  - Happy path: POST with valid token + valid signature + plain-invoice fixture → 200, row exists, attachments persisted, classify job enqueued.
  - Wrong token → 401, no row.
  - Missing `X-Webhook-Signature` → 401, no row.
  - Tampered body (signature computed over original, body modified) → 401, no row.
  - Duplicate Message-ID (POST same fixture twice) → first 200 `{ duplicate: false }`, second 200 `{ duplicate: true }`, only one row total.
  - Oversized body (synthesize >25 MB) → 413, no row.
  - Malformed JSON → 400, no row.
  - Schema-rejected payload (e.g., missing `messageId`) → 400, no row.

  Use Next.js's testing pattern for Route Handlers (import the route module, call `POST(new NextRequest(...))`).

- [ ] **Step 2**: `pnpm vitest run tests/integration/inbound-email-webhook.test.ts`. Expected: PASS.

## Task B8: Commit and ship PR 2

- [ ] **Step 1**: `git checkout -b feat/inbox-webhook` (from updated `main`).
- [ ] **Step 2**: Stage explicit paths:
  ```bash
  git add lib/env.ts .env.example lib/queue.ts \
          lib/incoming-email/{hmac.ts,hmac.test.ts,schema.ts,schema.test.ts,actions.ts} \
          tests/fixtures/inbound-email/ \
          app/api/inbound-email/ \
          worker/jobs/classify-incoming-email.ts worker/index.ts \
          tests/integration/inbound-email-webhook.test.ts
  ```
- [ ] **Step 3**: `git commit -m "feat(inbox): inbound webhook with HMAC verification + dedup"`.
- [ ] **Step 4**: PR via `superpowers:finishing-a-development-branch`. Title: `feat(inbox): inbound email webhook handler`. Body should call out: HMAC verification before JSON parse; raw-body capture via `req.text()`; idempotent dedup on Message-ID; classify job is currently a no-op stub.
- [ ] **Step 5**: Wait for CI green + merge before starting Phase C.
- [ ] **Step 6** (post-merge): operator action — generate `INBOUND_EMAIL_TOKEN`, set the matching values in ForwardEmail's webhook key UI and in production env, then add the DNS TXT record. The first real webhook hit lands in the DB; the row is invisible until Phase C ships.

---

# Phase C — Inbox UI (PR 3: `feat/inbox-ui`)

Sidebar entry, list page with Untriaged / Archived tabs, detail page with body view, attach pickers, and archive/promote actions. After this PR the user can triage emails manually; the classifier still does nothing useful (Phase D is next).

## Task C1: Server actions and queries

**Files:**
- Modify: `lib/incoming-email/actions.ts` (add the user-facing actions)
- Create: `lib/incoming-email/queries.ts`

- [ ] **Step 1**: In `actions.ts` add:
  - `attachIncomingEmail({ id, vendorId, itemId, systemId })` — `prisma.incomingEmail.update` with the supplied FKs (any combination of three; null clears). On success, set `state = LINKED`. Revalidate `/inbox` and `/inbox/[id]`.
  - `setIncomingEmailKind({ id, kind })` — straight update.
  - `archiveIncomingEmail({ id })` — set `archivedAt = now()`, `state = ARCHIVED`. Revalidate.
  - `unarchiveIncomingEmail({ id })` — clear `archivedAt`, set `state` back to `UNTRIAGED` if no FKs are set, else `LINKED`.
  - `promoteToServiceRecord({ id })` — server action that creates a new `ServiceRecord` from the email (similar to the auto-stub logic from the spec, but only fires when user clicks the button) and sets `createdServiceRecordId` + `state = LINKED`. Use the existing `lib/service-records/actions.ts` `createServiceRecord` so the same Zod gate applies.

  Each action: import `auth()` from Auth.js, require a session, attribute the change in the structured log.

- [ ] **Step 2**: In `queries.ts` add:
  - `listInboxEmails({ tab: 'untriaged' | 'archived', skip, take })` — returns rows with kind/sender/subject/receivedAt/state/archivedAt and three `_count`-style booleans (`hasVendor`, `hasItem`, `hasSystem`). Untriaged tab: `state IN (UNTRIAGED, AUTO_LINKED) AND archivedAt IS NULL`. Archived tab: `archivedAt IS NOT NULL` ordered desc.
  - `getInboxEmail(id)` — full detail with `vendor`, `item`, `system`, `attachments`, `createdServiceRecord`.
  - `countUntriaged()` — fast `count` for the sidebar badge.

- [ ] **Step 3**: Tests in `tests/integration/incoming-email-actions.test.ts`: each action smoke-tested against a real DB row.

## Task C2: Components

**Files:**
- Create: `components/incoming-email/InboxList.tsx`
- Create: `components/incoming-email/IncomingEmailCard.tsx`
- Create: `components/incoming-email/EmailBodyView.tsx`
- Create: `components/incoming-email/LinkPicker.tsx`

- [ ] **Step 1**: `InboxList.tsx` — server component, takes `rows` from `listInboxEmails`. Renders `<ul>` of rows; each row shows kind icon (use lucide: `Receipt` for INVOICE, `FileSearch` for ESTIMATE, `Wrench` for TICKET, `Mail` for UNKNOWN), sender name + address, subject (truncated), received date, link badges (Vendor / Item / System using existing chip patterns). Row click → `/inbox/[id]`.

- [ ] **Step 2**: `IncomingEmailCard.tsx` — server component, used on the detail page. Header: kind badge, sender, subject, received date. Body slot accepts `<EmailBodyView>`. Attachments slot reuses existing `<AttachmentList>`. Footer slot accepts `<LinkPicker>` and action buttons.

- [ ] **Step 3**: `EmailBodyView.tsx` — given `bodyHtml` and `bodyText`, render the HTML through the existing `lib/markdown.tsx` rehype-sanitize pipeline (or use `rehype-sanitize` directly if the markdown wrapper is too tied to markdown semantics). If only `bodyText`, render `<pre className="whitespace-pre-wrap">`. Sanitize once, cache the rendered React tree across requests is not needed (server-rendered each time).

- [ ] **Step 4**: `LinkPicker.tsx` — client component. Three Combobox-ish controls: Vendor, Item, System (each a shadcn Select with `items` prop populated from server-fetched lists). Submit calls `attachIncomingEmail` server action. Optimistic UI not required — full revalidation is fine.

## Task C3: Routes

**Files:**
- Create: `app/(app)/inbox/page.tsx`
- Create: `app/(app)/inbox/[id]/page.tsx`

- [ ] **Step 1**: `app/(app)/inbox/page.tsx` — server component. Reads `?tab=archived` from search params (default `untriaged`). Fetches via `listInboxEmails`. Renders shadcn `<Tabs>` with two triggers (Untriaged, Archived) and the `<InboxList>` inside the active tab.

- [ ] **Step 2**: `app/(app)/inbox/[id]/page.tsx` — fetches `getInboxEmail`. Renders `<IncomingEmailCard>` with body, attachments, and footer action row: `<LinkPicker>`, kind dropdown, `Archive` button, `Promote to ServiceRecord` button (gated on `!createdServiceRecordId && state !== ARCHIVED`). When `createdServiceRecordId` exists, show an info banner linking to `/service/[id]`.

## Task C4: Sidebar entry

**Files:**
- Modify: `app/(app)/_components/AppSidebar.tsx`

- [ ] **Step 1**: Add an Inbox entry between Items and Vendors:
  ```tsx
  { href: '/inbox', label: 'Inbox', icon: Inbox },
  ```
  Import `Inbox` from `lucide-react`.

- [ ] **Step 2**: Badge on the Inbox label: server-fetched `countUntriaged()` count, render via existing badge primitive when > 0. Do *not* introduce client polling — count refreshes on next navigation.

## Task C5: Smoke test

**Files:**
- Create: `tests/smoke/inbox.spec.ts`

- [ ] **Step 1**: Playwright spec: seed two `IncomingEmail` rows directly via Prisma (one untriaged, one archived). Sign in. Navigate to `/inbox`. Assert untriaged tab shows one row; switch tabs; archived shows one row. Click into the untriaged row. Use the Vendor LinkPicker to attach to a seeded vendor. Reload `/inbox`; row now shows the vendor chip; sidebar badge reads "0".

- [ ] **Step 2**: `pnpm test:smoke tests/smoke/inbox.spec.ts`. Expected: PASS.

## Task C6: Commit and ship PR 3

- [ ] **Step 1**: `git checkout -b feat/inbox-ui` off updated main.
- [ ] **Step 2**: Stage paths under `lib/incoming-email/`, `components/incoming-email/`, `app/(app)/inbox/`, `app/(app)/_components/AppSidebar.tsx`, `tests/integration/incoming-email-actions.test.ts`, `tests/smoke/inbox.spec.ts`.
- [ ] **Step 3**: Commit message: `feat(inbox): list + detail UI with link/archive/promote`.
- [ ] **Step 4**: PR via `superpowers:finishing-a-development-branch`. Body callouts: HTML body sanitization path; manual triage works; classifier is still a stub.
- [ ] **Step 5**: Wait for CI + merge.

---

# Phase D — Heuristic classifier + auto-stub (PR 4: `feat/inbox-classify`)

Replace the no-op stub with the real classifier and auto-stub creation. After this PR, inbound tickets from known vendors mentioning known items/systems land as draft service records.

## Task D1: Pure classifier

**Files:**
- Create: `lib/incoming-email/classify.ts`, `lib/incoming-email/classify.test.ts`

- [ ] **Step 1**: Implement `classifyEmail(input: ClassifyInput): ClassifyResult` per the spec's "Classification" section. `ClassifyInput`:
```ts
type ClassifyInput = {
  fromAddress: string;
  subject: string;
  bodyText: string;
  vendors: { id: string; email: string | null; notes: string | null }[];
  items: { id: string; name: string }[];
  systems: { id: string; name: string }[];
};
type ClassifyResult = {
  kind: 'ESTIMATE' | 'INVOICE' | 'TICKET' | 'UNKNOWN';
  vendorId: string | null;
  itemId: string | null;
  systemId: string | null;
  shouldAutoStubServiceRecord: boolean;
};
```
Pure function, no DB calls, no I/O.

- [ ] **Step 2**: Tests cover every rule branch:
- Vendor exact email match wins over domain match.
- Domain match falls back when no exact.
- No vendor match → `vendorId=null` and item/system match is *not* attempted.
- Each kind regex (one positive + one negative case each).
- Item/system match is skipped when ≥2 distinct entities matched (list email).
- `shouldAutoStubServiceRecord` is true *only* when (kind=TICKET, vendorId set, item OR system set).
- Word-boundary anchoring: an item named "AC" does not match "ACH" or "AC/DC"; "Limestone" does match "limestone".

- [ ] **Step 3**: `pnpm vitest run lib/incoming-email/classify.test.ts`. Expected: PASS.

## Task D2: Wire classifier into the worker

**Files:**
- Modify: `worker/jobs/classify-incoming-email.ts`

- [ ] **Step 1**: Replace the stub body with: load the email, load the candidate vendor/item/system lists (active only), run `classifyEmail`, persist the result. If `shouldAutoStubServiceRecord`, call `createServiceRecord` (from `lib/service-records/actions.ts`) with `{ vendorId, performedOn: email.receivedAt, summary: email.subject.slice(0, 200), notes: '[auto-created from inbound email — review and edit]', targets: [{ itemId: classified.itemId } | { systemId: classified.systemId }] }`. Wire the new record's id into `createdServiceRecordId`. Set `state = AUTO_LINKED`.

- [ ] **Step 2**: Be defensive against partial failure: if the ServiceRecord create throws, leave the email as `state=UNTRIAGED` with the FKs still set (the user can promote manually) and log the failure with full Sentry capture.

## Task D3: Integration test

**Files:**
- Create: `tests/integration/incoming-email-classify-job.test.ts`

- [ ] **Step 1**: Cover end-to-end:
- Seed a Vendor with `email='dispatch@acme.example'`, an Item named "Garage Door Opener". Insert an `IncomingEmail` from `dispatch@acme.example` with subject "Service report — Garage Door Opener" and a service-y body. Run the classify worker (call its handler directly with a fake job). Verify: `kind=TICKET`, `vendorId` set, `itemId` set, `state=AUTO_LINKED`, `createdServiceRecordId` set, the new ServiceRecord exists with one target pointing at the item.
- Seed an unrelated email (`from='spam@unknown.example'`) → `kind=UNKNOWN`, all FKs null, `state=UNTRIAGED`, no ServiceRecord.
- Seed an invoice from a known vendor mentioning *no* known items → `kind=INVOICE`, `vendorId` set, no auto-stub.

- [ ] **Step 2**: `pnpm vitest run tests/integration/incoming-email-classify-job.test.ts`. Expected: PASS.

## Task D4: Commit and ship PR 4

- [ ] **Step 1**: `git checkout -b feat/inbox-classify` off updated main.
- [ ] **Step 2**: Stage `lib/incoming-email/classify.{ts,test.ts}`, `worker/jobs/classify-incoming-email.ts`, `tests/integration/incoming-email-classify-job.test.ts`.
- [ ] **Step 3**: Commit message: `feat(inbox): heuristic classifier + auto-stub ServiceRecord on high-confidence tickets`.
- [ ] **Step 4**: PR via `superpowers:finishing-a-development-branch`. Body callouts: pure classifier with full unit coverage; auto-stub fires only on the three-way match; partial-failure path leaves manual triage available.
- [ ] **Step 5**: Wait for CI + merge.

---

# Phase E — Finishing

## Task E1: End-to-end verification in production-like dev

After PR 4 merges:

- [ ] **Step 1**: With the dev server running, send a real email through the configured ForwardEmail alias. Watch the worker logs. Verify the row in `/inbox`. Verify the auto-stub appears under `/service` if the email matched.
- [ ] **Step 2**: Edit `lib/incoming-email/classify.ts` to add additional kind regexes if real-world mail surfaces patterns the initial set missed. Each addition needs a corresponding unit test.
- [ ] **Step 3**: Update `MEMORY.md` with a "shipped" entry: `[Project — Inbox SHIPPED](project_inbox_shipped.md)` summarizing the four merged PRs and noting that Phase 5 (AI extraction) is the next roadmap item.

## Task E2: Phase 5 placeholder

- [ ] **Step 1**: Write `docs/superpowers/plans/2026-XX-XX-inbox-ai-extraction.md` *only when* the user signals readiness — do not pre-emptively scaffold. The hook is the existing `lib/ai/suggest` pattern; the trigger is "after a few weeks of real inbound flow we know which fields the heuristic misses most often."

---

## Roll-out checklist (operator)

After PR 2 ships, before turning the funnel on:

1. Generate `INBOUND_EMAIL_TOKEN`: `openssl rand -hex 24` (48 hex chars).
2. ForwardEmail dashboard → My Account → Domains → Settings → "Webhook Signature Payload Verification Key" → set or rotate. Copy the value.
3. Set in production env: `INBOUND_EMAIL_TOKEN=<the token>`, `INBOUND_EMAIL_HMAC_KEY=<the FE key>`. Restart the app.
4. Add DNS TXT record:
   `forward-email=inbox:https://housemanager.owine.net/api/inbound-email/<INBOUND_TOKEN>?raw=false`
5. Smoke test: send an email to `inbox@<userdomain>`. Watch app logs; expect `inbound-email` info log with the persisted id.
6. After PR 3 ships, the row shows up in the Inbox UI. After PR 4 ships, classification metadata is set.
