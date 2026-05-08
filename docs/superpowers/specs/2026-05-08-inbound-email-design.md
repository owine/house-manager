# Inbound email ingestion — vendor estimates / invoices / service tickets

**Date:** 2026-05-08
**Status:** Draft for review
**Authors:** Oliver Wine (with Claude)

## Overview

Today the user manually downloads attachments and copies content out of vendor emails (HVAC estimate PDFs, plumber invoices, service-ticket recap notes). This spec adds an inbound funnel: vendor emails forward to a single ForwardEmail alias whose webhook posts a parsed JSON payload to the app, which persists each email as a first-class `IncomingEmail` row with attachments and exposes them in a unified Inbox view. From the Inbox the user attaches the email to a Vendor / Item / System, and — when the kind is `ticket` and we have enough confidence — the system auto-creates a `ServiceRecord` stub the user can promote.

This is an additive feature: no existing entity is reshaped, no existing flow regresses, and the inbox stays out of the way until the user opts in by configuring the DNS forward.

## Goals

1. ForwardEmail-hosted alias (`inbox@<userdomain>`) forwards parsed messages to a webhook on the app; payloads are persisted durably with idempotent deduplication on `Message-ID`.
2. Each inbound email is a first-class `IncomingEmail` entity with kind (`estimate | invoice | ticket | unknown`), parsed body, decoded attachments, and optional FKs to `Vendor` / `Item` / `System`.
3. A heuristic classifier sets the initial `kind` and best-guess `vendorId` from the sender domain. Manual overrides always available; AI extraction is a follow-up phase.
4. When the heuristic returns `kind=ticket` with both a matched Vendor and a matched Item/System, auto-create a draft `ServiceRecord` stub linked to the email. User confirms or discards from the Inbox.
5. New top-level **Inbox** sidebar entry shows all `IncomingEmail` rows with state (untriaged / linked / archived), supports attach-to and archive actions.
6. Reuse the existing `Attachment` model — every email attachment becomes an `Attachment` row with a new `incomingEmailId` FK, automatically inheriting thumbnail/text-extraction/AI-indexing pipelines.

## Non-goals

- Outbound replies. Inbox is read + classify + attach; replies happen in the user's mail client.
- IMAP polling, OAuth into Gmail/iCloud, or any path that doesn't go through ForwardEmail's webhook. Single ingestion path keeps the security surface small.
- Multi-tenant routing. Solo self-hosted deployment, single inbox alias, no `+plus-alias` user identification.
- Body-content AI extraction in the first phase. Phase 5 (post-ship) layers an `lib/ai/suggest` step on top of stored emails.
- Spam filtering inside the app. ForwardEmail already filters; what arrives at the webhook is treated as legitimate.
- Replying-to-attach (e.g., user replies "attach to fridge"). Manual UI only.
- A general-purpose document store. Inbox is for emails; non-email PDFs continue to upload via the existing item-attachment UI.

## User-resolved design choices

1. **Single alias** (option A from brainstorming): one fixed ForwardEmail alias (`inbox@<userdomain>`). Per-vendor aliases were considered but the onboarding cost outweighed the routing fidelity gain for a solo app.
2. **Auto-create ServiceRecord stub** (option B): when classifier says `kind=ticket` AND the sender domain matches a known Vendor AND at least one Item/System reference is found in subject/body, create a draft `ServiceRecord` linked to the email. All other cases stay in the triage queue.
3. **Top-level Inbox sidebar entry** (option A): visible alongside Items / Systems / Vendors, with an unread badge for untriaged count.
4. **Webhook auth via ForwardEmail HMAC + URL token** (paid-plan path): primary defense is the `X-Webhook-Signature` HMAC header that ForwardEmail signs paid-plan webhooks with, verified against the configured key. URL token in path remains as a secondary routing/sanity check. This combination closes the DNS-TXT-leakage concern that token-only auth has, since the HMAC key never appears on the wire.
5. **Plan doc first**: this spec gates the plan; plan tasks reference back here for design rationale.

## ForwardEmail webhook contract

ForwardEmail uses [`mailparser.simpleParser`](https://nodemailer.com/extras/mailparser/) to render messages into JSON, then POSTs that JSON to the configured URL. Routing is configured via DNS:

```
TXT @  3600  forward-email=inbox:https://housemanager.owine.net/api/inbound-email/<INBOUND_TOKEN>
```

Relevant payload fields the app will consume (mailparser shape, abbreviated):

| Field | Type | Used for |
|---|---|---|
| `messageId` | `string` (RFC822 `<...>`) | dedup key |
| `subject` | `string` | UI title, classifier input |
| `from.value[0].address` | `string` | sender domain → vendor match |
| `from.value[0].name` | `string` | UI sender label |
| `to.value[].address`, `cc`, `bcc` | `string[]` | display only |
| `date` | `Date` | display + ServiceRecord `performedOn` default |
| `text` | `string` | classifier input, body display |
| `html` | `string` | sanitized body display (preferred over `text` if present) |
| `headers` | `Map`-shaped object | persisted as JSON for forensics |
| `headerLines` | `Array<{key, line}>` | optional debug |
| `attachments[]` | array | each → `Attachment` row |
| `attachments[].filename` | `string` | `Attachment.filename` |
| `attachments[].contentType` | `string` (MIME) | `Attachment.mimeType` |
| `attachments[].size` | `number` (bytes) | `Attachment.sizeBytes` |
| `attachments[].content.data` | `number[]` (Buffer-as-array) | decode → write to `storagePath` |
| `attachments[].cid` | `string?` | inline image discrimination |
| `dkim`, `spf`, `dmarc` | objects | persisted as `authResults` JSON |
| `session.recipient` | `string` | `X-Original-To`, the alias hit; useful for logging |
| `raw` | `string` | NOT requested — see querystring |

The webhook URL adds `?raw=false` so ForwardEmail omits the full RFC822 body. `attachments=true` is the default and we want it.

ForwardEmail's retry contract: 60s timeout per POST, 3 immediate retries, then SMTP 421 → continuous retry at the SMTP layer for *days* until 200. The handler must therefore (a) be idempotent on `messageId`, (b) ack with 200 quickly, (c) move slow work (text extraction, classification scoring) to background jobs.

## Schema

New model:

```prisma
model IncomingEmail {
  id              String    @id @default(cuid())

  messageId       String    @unique  // RFC822 Message-ID, dedup key
  fromAddress     String
  fromName        String?
  subject         String
  receivedAt      DateTime  // mailparser `date` (envelope), falls back to now()
  ingestedAt      DateTime  @default(now())

  bodyText        String?   @db.Text
  bodyHtml        String?   @db.Text
  headersJson     Json
  authResultsJson Json?     // dkim / spf / dmarc summary

  kind            IncomingEmailKind  @default(UNKNOWN)
  state           IncomingEmailState @default(UNTRIAGED)

  // best-guess links from heuristics; user can override or null out
  vendorId        String?
  vendor          Vendor?   @relation(fields: [vendorId], references: [id], onDelete: SetNull)
  itemId          String?
  item            Item?     @relation(fields: [itemId], references: [id], onDelete: SetNull)
  systemId        String?
  system          System?   @relation(fields: [systemId], references: [id], onDelete: SetNull)

  // when auto-stub fires, the created ServiceRecord links back here
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

enum IncomingEmailKind {
  ESTIMATE
  INVOICE
  TICKET
  UNKNOWN
}

enum IncomingEmailState {
  UNTRIAGED       // arrived, not yet touched by user
  AUTO_LINKED     // heuristic matched something, awaiting user confirm
  LINKED          // user confirmed link
  ARCHIVED        // user dismissed
}
```

`Attachment` gains one column:

```prisma
  incomingEmailId String?
  incomingEmail   IncomingEmail? @relation(fields: [incomingEmailId], references: [id], onDelete: Cascade)

  @@index([incomingEmailId])
```

`ServiceRecord` gains the back-reference:

```prisma
  fromIncomingEmail  IncomingEmail? @relation("IncomingEmailServiceRecord")
```

No XOR constraint between `vendorId`/`itemId`/`systemId` — all three can coexist (an invoice from Acme HVAC about the heat pump is legitimately linked to all three).

## Routing & auth

```
POST /api/inbound-email/[token]?raw=false
Content-Type: application/json
Headers: X-Webhook-Signature: <HMAC-SHA256 of body, hex>
Body: <mailparser JSON>
```

Single Next.js Route Handler at `app/api/inbound-email/[token]/route.ts`:

1. **Token check** (sanity / routing): constant-time compare `params.token` against `process.env.INBOUND_EMAIL_TOKEN` using `crypto.timingSafeEqual`. Mismatch → 401, no body. (The token is in DNS TXT and not a secret on its own, but a quick mismatch reject avoids running HMAC verification for misrouted requests.)
2. **HMAC check** (primary defense): read the raw request body as a string before JSON-parsing. Compute `hmac-sha256(INBOUND_EMAIL_HMAC_KEY, rawBody)` hex. Constant-time compare against the `X-Webhook-Signature` header. Mismatch → 401, structured log including request id + remote IP. The HMAC key lives only on ForwardEmail's side and the app's env — it is never put on the wire.
3. Parse JSON body; max 25 MB hard cap (ForwardEmail's payloads include all attachment buffers — large attachments are why this matters).
4. Validate with Zod (see "Validation"). Reject malformed payloads with 400 + structured log; ForwardEmail will retry, so log volume during a transient bad-payload incident is bounded.

New env vars:

```
INBOUND_EMAIL_TOKEN=        # 32+ random chars, generated at install time, lives in DNS TXT
INBOUND_EMAIL_HMAC_KEY=     # set in ForwardEmail's "Webhook Signature Payload Verification Key" UI; same value here
```

Both are added to `.env.example` as comments + placeholders.

## Persistence flow

The handler is structured to ack ForwardEmail in <1s; expensive work runs in the existing pg-boss worker.

1. **Dedup**: lookup `IncomingEmail` by `messageId`. If found, return `200 { duplicate: true, id }` — ForwardEmail's "retried email re-delivered" path is now a no-op.
2. **Transactional insert**:
   - Insert `IncomingEmail` row with body, headers, kind=`UNKNOWN`, state=`UNTRIAGED`. Use `onConflict do nothing` semantics on the unique `messageId` to handle the TOCTOU race when retries arrive concurrently.
   - For each `attachment`: decode `content.data` (number array) to `Buffer`, write to the existing attachment storage layer (`lib/attachments/store.ts`), then insert an `Attachment` row referencing the new `IncomingEmail`. `aiIndexable=true` by default; thumbnail/text extraction will pick it up.
3. **Enqueue background classify job**: `pg-boss.send('classifyIncomingEmail', { id })`. Response now ack-able.
4. Return `200 { id }`.

Total handler time goal: <500ms for typical email (no synchronous I/O beyond the inserts).

The `classifyIncomingEmail` worker (new file `worker/jobs/classify-incoming-email.ts`):

1. Load the email row.
2. Run heuristic classifier (see "Classification").
3. If a Vendor matched, set `vendorId`. If an Item/System reference was found, set `itemId` or `systemId`.
4. If `kind=TICKET` AND `vendorId` set AND (`itemId` OR `systemId`) set → auto-create stub `ServiceRecord`:
   - `vendorId = matched`
   - `performedOn = email.receivedAt`
   - `summary = email.subject` (truncated to first 200 chars)
   - `notes = "[auto-created from inbound email — review and edit]"`
   - One `ServiceRecordTarget` for the matched item/system.
   - Set `IncomingEmail.createdServiceRecordId = newRecord.id`.
   - Set state to `AUTO_LINKED`.
5. Otherwise, set state to `AUTO_LINKED` if any FK set, else leave `UNTRIAGED`.

## Classification

Phase 1 is heuristic-only — fast, deterministic, easy to debug. Phase 5 plugs `lib/ai/suggest` in *after* this list to refine.

**Vendor match** (in order):
1. Exact match: `Vendor.email == email.fromAddress`.
2. Domain match: domain of `email.fromAddress` equals domain of any `Vendor.email` or appears in `Vendor.notes` (case-insensitive substring).
3. Fall through to no match.

**Kind match** (regex on `subject` + first 500 chars of `text`, case-insensitive, first to fire wins):
- `INVOICE`: `/\b(invoice|inv\s*#|amount\s+due|payment\s+due|paid\s+in\s+full)\b/`
- `ESTIMATE`: `/\b(estimate|quote|proposal|bid)\b/`
- `TICKET`: `/\b(service\s+(?:report|ticket|call|visit)|work\s+order|completed\s+service|maintenance\s+report)\b/`
- otherwise `UNKNOWN`

**Item/System match** (only attempted if Vendor matched, to avoid false positives):
- Build a corpus of `(Item.name, Item.id)` and `(System.name, System.id)` for active rows.
- Lowercase token-search subject + first 1000 chars of body for any name (≥3 chars, word-boundary anchored).
- First hit wins; ties broken by longer match length, then most-recently-updated.
- Skip if more than one distinct entity matched (likely a list email — leave UNKNOWN).

**Confidence floor for auto-stub**: only fire ServiceRecord auto-create when *all three* matched (vendor, kind=TICKET, item/system). Anything weaker stays in triage.

These rules live in `lib/incoming-email/classify.ts` as a pure function with full unit tests; no DB calls inside (loader fetches Vendor/Item/System lists, passes them in).

## Validation

`lib/incoming-email/schema.ts` exports a Zod schema for the webhook body. mailparser output is loosely typed; we validate only the fields we use, allow unknown keys to pass through, and reject only on missing-required:

```ts
const ForwardEmailWebhookSchema = z.object({
  messageId: z.string().min(1),                    // required
  subject: z.string().default(''),
  from: z.object({
    value: z.array(z.object({
      address: z.string().email(),
      name: z.string().optional(),
    })).min(1),
  }),
  date: z.coerce.date().optional(),                // mailparser sometimes omits
  text: z.string().optional(),
  html: z.string().optional(),
  headers: z.record(z.unknown()).optional(),
  headerLines: z.array(z.object({ key: z.string(), line: z.string() })).optional(),
  attachments: z.array(z.object({
    filename: z.string().nullable().optional(),
    contentType: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
    content: z.object({
      type: z.literal('Buffer'),
      data: z.array(z.number().int().min(0).max(255)),
    }),
    cid: z.string().optional(),
  })).default([]),
  dkim: z.unknown().optional(),
  spf: z.unknown().optional(),
  dmarc: z.unknown().optional(),
  session: z.object({ recipient: z.string().optional() }).passthrough().optional(),
}).passthrough();
```

The HTML body is sanitized via the existing `lib/markdown.tsx` rehype-sanitize pipeline before render. Raw HTML never reaches the React tree without first passing through that sanitizer.

## UI

**New top-level route**: `app/(app)/inbox/`

- `page.tsx` (list): two tabs — "Untriaged" (state=UNTRIAGED + AUTO_LINKED, default) and "Archived". Rows show kind icon, sender, subject, received date, link badges (Vendor / Item / System chips). Pagination via existing `lib/pagination/`.
- `[id]/page.tsx` (detail): sender + subject header, sanitized HTML body (or plaintext fallback) in a card, attachments listed via existing `<AttachmentList>`, "Linked to" section with Vendor/Item/System pickers (re-using `<TargetsPicker>` semantics where it fits), kind dropdown, "Promote to ServiceRecord" button (only when no `createdServiceRecord` yet), "Archive" button.
- Server actions: `attachIncomingEmail({ id, vendorId?, itemId?, systemId? })`, `setIncomingEmailKind({ id, kind })`, `archiveIncomingEmail({ id })`, `promoteToServiceRecord({ id })`.

**Sidebar** gets an `Inbox` entry with the `Inbox` lucide icon and a badge displaying untriaged count (server-rendered each page load; no realtime).

**Auto-stub UX**: when `state=AUTO_LINKED` and `createdServiceRecordId` is set, the detail page shows an info banner: "We drafted a service record from this email — [view draft]." User can confirm (which graduates the draft) or discard (which deletes the draft and reverts state).

## Security & correctness gotchas

- **HMAC verification must precede JSON parsing**: read the raw body string first so the HMAC is computed over the bytes ForwardEmail signed. Next.js Route Handlers expose `req.text()` for this — call it once, verify, then `JSON.parse`. Don't use `req.json()` first.
- **Idempotency**: `messageId` UNIQUE plus the lookup-then-insert pattern handles ForwardEmail re-delivery. The check-then-insert is a TOCTOU race on concurrent webhook deliveries of the same message; insert with `ON CONFLICT (messageId) DO NOTHING` semantics or wrap in a serializable transaction.
- **Body size**: ForwardEmail can deliver multi-megabyte payloads (attachments encoded as JSON arrays of byte numbers — ~3.5x base64). Hard cap at 25 MB; reject 413.
- **HTML sanitization**: vendor HTML emails contain remote images, scripts, inline styles. Pipe through rehype-sanitize before render. Never bypass the sanitizer for raw vendor HTML.
- **Attachment scanning**: rely on existing `Attachment` pipeline; same caveats as user-uploaded attachments. No additional scanning in scope.
- **Time skew**: trust `date` from envelope but fall back to `ingestedAt` if missing or > 30 days off.
- **Key rotation**: ForwardEmail lets you rotate the HMAC key in their dashboard. Plan a brief overlap window (accept either old or new key for ~5 minutes during rotation) — implementable as `INBOUND_EMAIL_HMAC_KEY` plus optional `INBOUND_EMAIL_HMAC_KEY_PREVIOUS`.

## Phasing (cross-reference for plan doc)

- **PR 1** — Schema only: `IncomingEmail`, `IncomingEmailKind`, `IncomingEmailState`, `Attachment.incomingEmailId`, `ServiceRecord.fromIncomingEmail`. Migration only, no UI, no handler.
- **PR 2** — Webhook handler: `/api/inbound-email/[token]/route.ts`, HMAC + token verification, Zod validation, dedup, attachment write-through, classify-job enqueue. Fixture-based unit + integration tests covering replay, malformed body, signature mismatch, duplicate Message-ID, oversize body.
- **PR 3** — Inbox UI: list, detail, attach/archive server actions, sidebar entry.
- **PR 4** — Heuristic classifier + auto-create ServiceRecord stub.
- **PR 5** *(later)* — AI extraction via `lib/ai/suggest`.

## Open questions for plan doc

1. **Attachment storage backend** for inbound is whatever existing `Attachment` uses (currently local FS at `data/attachments/`). Confirm capacity headroom before turning the funnel on.
2. **Untriaged badge query**: count(`state IN (UNTRIAGED, AUTO_LINKED) AND archivedAt IS NULL`) on every page render is fine at small scale; revisit if Inbox volume crosses ~10k rows.
3. **Body store**: keep both `text` and `html` raw in DB columns, or store `html` in object storage and only render-on-demand? Phase 1 keeps it inline (DB). If emails skew large in practice, move to storage in a follow-up.
4. **HMAC key rotation overlap**: implement `INBOUND_EMAIL_HMAC_KEY_PREVIOUS` from day one or defer until first rotation? Defer is simpler; cost is a 5-minute outage during rotation. Plan currently defers.

## Out-of-scope follow-ups (post-Phase 5)

- Per-vendor alias support (already considered, deferred).
- Reply-to-attach via outbound mailto.
- Full-text search across email bodies (would extend the existing Meilisearch index).
- Forwarding rules (e.g., "auto-archive after 90 days if state=ARCHIVED").
