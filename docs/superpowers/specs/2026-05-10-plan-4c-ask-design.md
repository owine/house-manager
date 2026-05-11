# Plan 4c — Ask: RAG over user content with citations

**Date:** 2026-05-10
**Status:** Draft for review
**Authors:** Oliver Wine (with Claude)
**Parent spec:** `docs/superpowers/specs/2026-04-26-house-manager-design.md`
**Builds on:** Plans 1, 2a, 2b, 2c, 3, 4a, 4ab, 4b, 5a, 5b — all shipped to main as of 2026-05-10. Plus Systems (PR #55) and Inbox (PRs #75–#78).

## Overview

Plan 4c adds **Ask**: a natural-language Q&A surface backed by retrieval-augmented generation over everything the user has captured — items and their metadata, notes, service records, checklists, and attachment contents. A user types a question on a new `/ask` page (or via a sidebar shortcut), receives a grounded answer with inline citations, and can click each citation to land on the source entity.

This is the third and final Plan 4 milestone, after Find (Plan 4a — Meilisearch keyword search) and Suggest (Plan 4b — structured AI generation). Where Find answers *"where is X?"* and Suggest answers *"what should I do next?"*, Ask answers *"what do I know about X?"*.

The hardest sub-problem isn't the LLM call — it's making attachments queryable. PDFs come in two flavours: text-native (most invoices, manuals, inspection reports — including the Rose Pest report that prompted PR #101) and image-only (phone photos of receipts, scans of warranties). Plan 4c adds an OCR pipeline so the second category is no longer black-box content.

## Goals

1. Ship a working `/ask` page that answers questions with grounded, cited responses.
2. Index *all* user-owned content into a unified pgvector store: items (name + metadata + notes), notes, service records, checklist items, warranties, and attachment text (PDF + image OCR).
3. Establish an indexing pipeline that runs in the worker process, mirrors the existing pg-boss + state-change patterns from Plan 4a (Meilisearch), and keeps embeddings in sync as entities are created, edited, archived, and deleted.
4. Add OCR via Tesseract.js so phone-photographed receipts and image-based PDFs become first-class indexed content.
5. Capture every Ask call in a telemetry table with enough detail (tokens, latency, retrieved chunk IDs, citations rendered, user feedback) to tune the system and spot regressions.
6. Stay within the existing infrastructure: one new dependency (`tesseract.js`), one new third-party API (Voyage), no new containers, no new databases (pgvector is already in the squashed init).

## Non-goals

- **Multi-turn conversations.** v1 is one-shot Q&A. The Server Action takes a question, returns an answer + citations, end of story. A "follow-up question" textarea is just a fresh call. Conversational memory ships later if usage warrants.
- **Voice input / output.** Text-only.
- **Sharing answers / public links.** Single-household model.
- **Streaming token output.** The Anthropic call is non-streaming (matches Plan 4b). A "Thinking…" spinner covers the ~2–5s latency. Streaming is a polish step deferred to a follow-up.
- **Image generation, charts, structured tables.** The model produces text + markdown only.
- **External knowledge.** The system prompt tells the model to refuse questions outside the user's content ("I don't have anything in your records about that.") rather than answer from general training data.
- **Cross-household retrieval.** Single-household; no per-user ACL within the system. Every authed user sees every Embedding row.
- **Image embeddings.** Image attachments are OCR'd to text and then embedded as text. No CLIP / multimodal embedding model.
- **Voyage rerank.** v1 uses a plain top-k similarity search. Reranking via `voyage-rerank-2` is a quality lever deferred to a follow-up.
- **Hybrid retrieval (Meilisearch + pgvector blend).** Pure vector search in v1. The two stacks coexist but Ask doesn't consult Meilisearch. Adding hybrid is a backlog item.
- **Extended prompt caching.** Default 5-min cache covers single-session bursts.

## Architecture

Two parallel pipelines plus the live Q&A path.

**Pipeline A — Indexing (worker, async):**
A new `embed-content` pg-boss job runs per (entity, kind) on every create / update / archive. It computes the entity's canonical text representation, chunks it, embeds the chunks via Voyage's batch API, and upserts into the `Embedding` table. Mirrors the existing `search-index` job (Plan 4a) at the orchestration level.

**Pipeline B — Attachment OCR (worker, async):**
A new `extract-attachment-text` pg-boss job runs per Attachment on upload. It dispatches by mime type:
- `application/pdf` → unpdf text extract (already in the codebase since PR #101). If text length is below a threshold (200 chars), fall through to OCR via Tesseract.js rendering each page from the PDF.
- `image/*` (jpeg, png, webp, heic) → Tesseract.js OCR direct (after `sharp` normalization for HEIC and rotation).
- `text/*` (txt, md) → read directly.
- Anything else → skip, log, set `Attachment.indexedAt` with the skip reason.

The extracted text is stored on the Attachment row (`extractedText: String?`, `extractedAt: DateTime?`, `extractedError: String?`) and *then* the `embed-content` job is enqueued for the attachment. Two jobs because OCR is heavy (10–60s for a multi-page scan); embedding is fast (one Voyage call).

**Pipeline C — Ask (Server Action, synchronous):**
User submits a question on `/ask`. The action: embeds the question via Voyage, runs a pgvector `<=>` cosine-distance query against `Embedding` (top-k = 12, with optional filter by entity kind), assembles a context block with retrieved chunks and their source metadata, calls Anthropic's `messages.parse` with a Zod schema that constrains the answer shape `{ answer, citations[] }`, logs to `AISuggestionLog` (existing — extends the existing telemetry table with a new `kind: 'ASK'`), returns to the client. Client renders the answer with citation chips that link to the source entity.

```
┌────────────────────┐
│ User → /ask page   │
└────────┬───────────┘
         │ Server Action: askQuestion(input)
         ▼
┌────────────────────┐    ┌────────────────────┐
│ Voyage embeddings  │ ←  │ Question text      │
│ (voyage-3.5-lite)  │    └────────────────────┘
└────────┬───────────┘
         │ vector
         ▼
┌────────────────────┐    ┌────────────────────┐
│ pgvector top-k     │ →  │ retrieved chunks   │
│ ORDER BY <=>       │    │ + parent metadata  │
└────────┬───────────┘    └────────┬───────────┘
         │                          │
         │       ┌──────────────────┘
         ▼       ▼
┌─────────────────────────────────┐
│ Anthropic messages.parse        │
│ system: grounded Q&A prompt     │
│ user: question + cited chunks   │
│ output_config: AskAnswerSchema  │
└────────┬────────────────────────┘
         │
         ▼
┌────────────────────┐
│ { answer,          │
│   citations[] }    │
└────────────────────┘
```

## Schema additions

### New: `Embedding`

The vector store. One row per chunk.

```prisma
model Embedding {
  id          String   @id @default(cuid())
  entityType  EmbeddingEntityType  // ITEM | NOTE | SERVICE_RECORD | CHECKLIST_ITEM | WARRANTY | ATTACHMENT
  entityId    String                // FK target depends on entityType; not declared as a Prisma relation (polymorphic)
  chunkIndex  Int                   // 0-based; ordering within an entity for citation rendering
  text        String   @db.Text     // the actual chunk text (~500 tokens worth)
  embedding   Unsupported("vector(1024)")  // Voyage voyage-3.5-lite is 1024-dim
  tokenCount  Int                   // approximate, for diagnostics
  contentHash String                // SHA-256 of the source canonical text; re-embed only when this changes
  createdAt   DateTime @default(now())

  @@index([entityType, entityId])
  @@index([contentHash])
  // Pgvector index — IVFFlat with 100 lists for cosine distance. Created via
  // raw SQL in the migration (Prisma doesn't generate vector indexes natively).
  @@map("embeddings")
}

enum EmbeddingEntityType {
  ITEM
  NOTE
  SERVICE_RECORD
  CHECKLIST_ITEM
  WARRANTY
  ATTACHMENT
}
```

**Why polymorphic, not per-entity FK?** Cuts six tables down to one. The cost is no FK cascade — orphan rows must be cleaned by the `embed-content` worker on entity delete (which already needs to be triggered for re-index anyway). Net win for ingest throughput and migration simplicity.

**Why `contentHash`?** Most updates don't actually change embedding-relevant content — e.g. archiving an Item doesn't change its name/metadata text. Skip re-embed when the hash matches what's already stored. Saves Voyage tokens and worker time.

### Modified: `Attachment`

Add OCR / extraction fields. These already partially exist for `extractedText` semantically (we have the user's earlier feedback about extract telemetry); v1 adds explicit columns.

```prisma
model Attachment {
  // ...existing fields...
  extractedText   String?   @db.Text
  extractedAt     DateTime?
  extractedError  String?           // human-readable reason if extraction failed
  ocrUsed         Boolean   @default(false)   // tracks whether OCR ran vs text-layer extraction
  indexable       Boolean   @default(true)    // user toggle: opt out of AI indexing for sensitive docs
}
```

### Modified: `AISuggestionLog`

Already exists from Plan 4b. Extend the `kind` enum with `ASK`, and add a `citationCount: Int?` column. Existing telemetry shape (`latencyMs`, `inputTokens`, `outputTokens`, `errorReason`, `userId`) is reused as-is.

```prisma
enum AISuggestionKind {
  REMINDERS
  CHECKLIST
  EXTRACT_INCOMING_EMAIL  // existing
  ASK                     // new
}

model AISuggestionLog {
  // ...existing fields...
  citationCount  Int?      // populated only for ASK rows
  retrievedChunkIds  String[]  @default([])  // for replay / debugging
}
```

### Migration: pgvector index

Prisma doesn't generate vector indexes. The migration file appends raw SQL:

```sql
CREATE INDEX embeddings_embedding_cosine_idx
  ON embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

100 lists is a reasonable starting point for under ~100k chunks. The pgvector docs recommend `rows / 1000` lists; we can revisit when the table gets large.

## Canonical text per entity type

The text we embed isn't the raw row — it's a canonical, AI-friendly serialization tailored per entity type. This is what the model "sees" as context, so it has to be readable in isolation.

### Item

```
Item: <name>
Category: <category.name>
[Manufacturer: <manufacturer>]
[Model: <model>]
[Location: <location>]
[Purchased: <purchaseDate> for $<purchasePrice>]
[System: <system.name>]
Metadata:
  applianceType: refrigerator
  fuelType: electric
  capacityCuFt: 22
  ...
Notes (item-level): <item.notes>
```

Skip empty fields. Metadata is pretty-printed key:value lines for everything in the typed schema (PR #100). Serial numbers are deliberately excluded (`buildInventoryBlock` in Plan 4b already redacts these).

### Note

```
Note: <title>
[Item: <linked-item-name>]  (or System / Vendor / ServiceRecord depending on relation)
Created: <createdAt>
---
<note body, markdown>
```

### ServiceRecord

```
Service: <summary>
Performed: <performedOn>
Vendor: <vendor.name or freeform name>
Targets: <item names + system names, comma-separated>
Cost: $<cost>
---
<notes, markdown>
```

### ChecklistItem

```
Checklist: <checklist.name>
Item: <title>
[Linked item: <item.name>]
Rationale: <rationale>
Status: <completed|pending>
```

### Warranty

```
Warranty: <summary>
Targets: <items/systems>
Coverage: <markdown>
Starts: <startsOn>
Ends: <endsOn>
[Cost: $<cost>]
```

### Attachment

```
Attachment: <filename>
[Linked to: <parent entity type and name>]
Extracted text:
<extractedText — chunked, see below>
```

## Chunking strategy

Different content shapes need different chunkers, but we keep it simple in v1:

- **Items, Notes, Service records, Checklist items, Warranties**: single-chunk usually. If the canonical text exceeds 1500 tokens (rare — usually only `notes` heavy entities), split on paragraph boundaries to roughly 500-token chunks with 50-token overlap.
- **Attachments**: always paragraph-split into 500-token chunks with 50-token overlap. Long manuals can be hundreds of chunks.

Token counting uses a rough char-based approximation (1 token ≈ 4 chars). Good enough for chunking; precise counts come from the Voyage API response for telemetry.

## Voyage integration

**Model:** `voyage-3.5-lite` (1024-dim, 32K input). Cheap enough that re-embedding the full corpus on a model upgrade is feasible.

**Batching:** Voyage's batch endpoint accepts up to 128 inputs per call. Worker batches across the queue cycle when multiple chunks need embedding.

**Env var:** `VOYAGE_API_KEY` (required when `ASK_ENABLED=true`; absence disables the feature and all indexing jobs no-op-skip).

**Errors:** Standard exponential backoff via the worker job retry mechanism (pg-boss `retryLimit: 5`, `retryDelay: 60`). On final failure, log to a per-entity error column (`embeddingError` on Item/etc — or a single column on `Embedding` parent rows; TBD during plan).

## OCR via Tesseract.js

**Why Tesseract.js over Anthropic vision:** privacy (everything local), free (no per-page cost), good enough for typed receipts and scanned invoices. Anthropic vision is better on messy handwriting but that's not the common case — household docs are typed.

**Worker integration:**
- Tesseract.js workers are heavy (~10MB language data per worker). We init a single shared worker per worker process at startup, not per job.
- English-only language pack (`eng`); add others if a future user needs them.
- For PDFs that fall through to OCR (text layer < 200 chars), render each page to PNG via `unpdf`'s `getDocumentProxy` + canvas. Cap at 20 pages to bound runtime.
- For HEIC and other phone formats, `sharp` normalizes to PNG first.

**Tradeoffs called out for the implementer:**
- Tesseract.js cold start is 1–3s; warm OCR runs at ~1–2s per page on a Pi.
- Memory: a warm worker holds ~80MB resident.
- The `extract-attachment-text` job is gated by `OCR_BACKEND` env (`tesseract` | `none`). Default `tesseract` in dev / prod, `none` in CI to avoid bloating test runtime.

## Ask UI

### `/ask` page

```
+--------------------------------------------------+
|  Ask                                              |
|  Type a question about anything in your records.  |
|                                                   |
|  +---------------------------------------------+ |
|  | When did I last service the HVAC?           | |
|  +---------------------------------------------+ |
|                                       [ Ask ]    |
|                                                   |
|  ────────────────────────────────────────────    |
|                                                   |
|  Answer                                           |
|                                                   |
|  The HVAC system was last serviced on 2026-04-12 |
|  by GreenLawn LLC. The service summary was       |
|  "Annual spring tune-up; replaced air filter."   |
|                                                   |
|  Sources:                                         |
|  [Service: Annual spring tune-up — 2026-04-12]   |
|  [Service: Filter replacement — 2026-01-05]      |
|  [Item: HVAC system: Carrier 58STA]              |
+--------------------------------------------------+
```

Citation chips are clickable; each is a `<Link>` to the source entity (`/service/<id>`, `/items/<id>`, etc.). The chip label uses the entity's display name and date if applicable.

### Sidebar entry

New sidebar item under "Workflows": **Ask** (between Inbox and Reminders, with a chat-bubble lucide icon).

### Optional scoping

A small dropdown above the question textarea lets the user narrow retrieval:
- *All content* (default)
- *Items*
- *Notes*
- *Service history*
- *Attachments*

This becomes a `WHERE entityType IN (...)` filter on the retrieval query.

## Telemetry

Every Ask call writes one row to `AISuggestionLog`:

| Column | Source |
|--|--|
| `kind` | `ASK` |
| `userId` | session |
| `latencyMs` | wall clock |
| `inputTokens` | Anthropic usage |
| `outputTokens` | Anthropic usage |
| `citationCount` | parsed answer |
| `retrievedChunkIds` | top-k IDs from pgvector |
| `errorReason` | `rate_limited` / `embed_failed` / `llm_failed` / null |

The Admin `/admin/ai` page (already exists from Plan 4b) renders Ask stats next to Suggest stats. Per-row "view question + answer + retrieved chunks" admin drilldown deferred to a follow-up.

## Rate limiting

Reuse the per-user rate limiter from Plan 4b (`lib/ai/rate-limit.ts`). Same daily budget — Ask calls and Suggest calls share a single bucket so a runaway loop in either feature throttles both. Limit is configurable via env (current value documented in the limiter module).

## Privacy

- Embeddings are stored in *our* Postgres. Voyage sees chunk text once per upsert and doesn't retain (per their data-use policy; cite in plan).
- The `extractedText` field on Attachment is plaintext in the DB — visible to anyone with DB access (which is the single-household admin). No new exposure surface vs the source attachment file itself.
- `Attachment.indexable: false` lets the user opt out per-attachment for sensitive docs (passport scans, tax returns).
- Serial numbers, exact addresses, and other PII fields are excluded from the canonical text (same redaction policy as Plan 4b's `buildInventoryBlock` / `coarsenLocation`).

## Open questions / TBDs

1. **Reindex trigger UX.** When a user toggles `Attachment.indexable` or edits a heavy Item, does the user need a "Re-index now" affordance, or is the worker-driven reindex on row update enough? Plan: rely on row-update triggers + a single admin "Rebuild all embeddings" button (mirror of the existing Meilisearch rebuild button).
2. **Vector dimension choice.** Voyage `voyage-3.5-lite` is 1024. `voyage-3-large` is 2048 and higher quality. Trade-off: 2x storage, 2x cosine compute. Default to lite; document the upgrade path in the migration's comment.
3. **Citation linking when source is an attachment.** An attachment doesn't have a "view" page of its own — it lives under its parent (Item, ServiceRecord, etc.). Citation should link to the parent with a query-string anchor to the attachment row (`/items/abc?attachment=xyz`). The parent page needs a small scroll-to-attachment behavior.
4. **Plan 4a / Meilisearch overlap.** Should Find and Ask share a unified search endpoint? Probably no in v1: their UX is genuinely different (instant typo-tolerant keyword vs. natural-language Q&A). A blended `/search` view that runs both is a polish item for after Ask is live and we see usage patterns.
5. **Worker memory budget.** Tesseract.js + Voyage batching could push the worker container above its current implicit memory budget on the Pi. Plan should include a Docker memory limit + a watchdog log warning at, say, 800MB RSS.
6. **Backfill on first deploy.** Existing rows have no embeddings. First deploy must enqueue a full-corpus reindex (one-shot startup job, idempotent). The Meilisearch reindex job is a working precedent.

## What ships

- A `/ask` page that answers questions over all user content with clickable citations.
- A worker indexing pipeline that keeps embeddings fresh as entities change.
- An attachment OCR pipeline that makes phone photos and image PDFs first-class queryable content.
- Telemetry, rate limiting, and an admin view that mirror Plan 4b's patterns.
- One new dep (`tesseract.js`), one new third-party API (`VOYAGE_API_KEY`), no new containers.

After 4c, the README's Plans status will accurately read: every plan complete, organic features (Systems, Inbox, etc.) tracked separately. The next planning milestone (call it Plan 6 — Polish++, or Plan 4d — Ask v2 with streaming and rerank) is wide open.
