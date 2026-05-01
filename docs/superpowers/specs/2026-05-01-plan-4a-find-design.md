# Plan 4a — Find: Meilisearch keyword search

**Date:** 2026-05-01
**Status:** Draft for review
**Authors:** Oliver Wine (with Claude)
**Parent spec:** `docs/superpowers/specs/2026-04-26-house-manager-design.md`
**Builds on:** Plans 1, 2a, 2b, 2c, and 3 — all shipped to main as of 2026-05-01.

## Overview

Plan 4a adds the first AI-adjacent capability from the master spec: **Find** — a unified Meilisearch keyword search across the app's domain entities. A header search box returns instant top-N matches in a dropdown; a `/search` page provides full results with facet filters and pagination. Server Actions on every domain write enqueue a pg-boss job that upserts the corresponding row into a single Meilisearch index. A `reindex-all` job (manual button + nightly cron) is the recovery path for any drift.

This plan is the first of a three-part Plan 4 decomposition. Plan 4b will add **Suggest** (structured generation via Claude tool-use, plus the deferred Checklist tables). Plan 4c will add **Ask** (RAG over user documents, OCR pipeline, embeddings, pgvector chunks). Plans 4b and 4c reuse the search infrastructure shipped here (the same `lib/search/document.ts` patterns extend to embedding pipelines later).

## Goals

1. Ship a single search box that finds **anything** — items, vendors, notes, service records, attachments by filename, reminders — without the user needing to know which list page contains it.
2. Make the result feel instant on the typical household-scale dataset (≤ ~5,000 indexed documents). Header dropdown returns within ~200ms of the last keystroke; `/search` page renders the first batch server-side.
3. Establish the **per-action enqueue → pg-boss → search-index worker** pattern that Plan 4c's embedding sync will copy.
4. Pre-stage the index document shape for Plan 4c's RAG additions (a dormant `extractedText` field on the attachment kind, populated when OCR lands).
5. Stay within the existing infrastructure — Meilisearch is already in `docker-compose.yml` (v1.42), env vars are already in `lib/env.ts`, the worker container already runs pg-boss. No new services.

## Non-goals

- **Embeddings, vector search, RAG.** Plan 4c.
- **OCR / extracted-text indexing.** The `extractedText` field is reserved on the document shape but not populated until Plan 4c. v1 indexes attachment **filenames** only.
- **Per-user / ACL filtering at search time.** All authed users see all hits — same household-shared model as the rest of the app's read paths.
- **Server-side debounce or rate limiting.** v1 trusts the client (`SearchBar` debounces 250ms). The Route Handler is auth-gated; abuse is bounded by the user count (~1).
- **Search analytics** (top queries, no-result queries). Defer to Plan 5 polish.
- **Fuzzy synonym dictionaries / custom tokenizers.** Meilisearch's defaults handle typos and stemming well enough for v1.
- **Multi-language.** English-only fixtures; Meilisearch's relevance still works for other latin-script content but no first-class i18n.

## Architecture

### Components

```
┌─ Server Actions (existing, modified) ──────────────────────┐
│  lib/{items,vendors,notes,service-records,reminders,       │
│       attachments}/actions.ts                              │
│  After every create/update/delete:                         │
│      await boss.send(Queue.SearchIndex, {kind, id, op})    │
└────────────────────────────┬───────────────────────────────┘
                             ▼
                ┌─ pg-boss Queue.SearchIndex ─┐
                └─────────────┬───────────────┘
                              ▼
┌─ worker/jobs/search-index.ts ─────────────────────────────┐
│  handleSearchIndex({kind, id, op}) — single handler that  │
│  dispatches by kind → buildDocument(kind, id) → upserts   │
│  or deletes from the unified Meilisearch index.            │
│  (op: 'upsert' | 'delete')                                 │
└────────────────────────────┬───────────────────────────────┘
                             ▼
                  ┌─ Meilisearch index 'house' ─┐
                  │  searchableAttributes:      │
                  │   title, itemName, body,    │
                  │   tags                      │
                  │  filterableAttributes:      │
                  │   kind, itemId, categorySlug│
                  │  sortableAttributes:        │
                  │   updatedAt                 │
                  └─────────────────────────────┘
                             ▲
                             │
┌─ Read path ─────────────────┴─────────────────────────────┐
│  app/api/search/route.ts (auth-gated GET)                  │
│  Query → Meilisearch → return {hits[], facets:{kind:n}}    │
│  Used by both: header dropdown (debounced), /search page   │
└────────────────────────────────────────────────────────────┘

┌─ Reindex-all ─────────────────────────────────────────────┐
│  worker/jobs/search-reindex.ts                             │
│  - boss.schedule(Queue.SearchReindex, '0 3 * * *')         │
│  - Manual trigger: Server Action `reindexAll` from         │
│    /settings → boss.send(Queue.SearchReindex, {})          │
│  Drops + recreates the index, then full backfill from      │
│  Postgres in chunks (1000 rows/kind).                      │
└────────────────────────────────────────────────────────────┘
```

### New files

| File | Purpose |
|---|---|
| `lib/search/client.ts` | Singleton Meilisearch client. Lazy-initialized via the official `meilisearch` npm package. |
| `lib/search/document.ts` | `buildDocument(kind, id)` — kind→Prisma-query mapping + flattening into the unified document shape. One pure function per kind for testability. Returns `null` if the row no longer exists (treated as "delete"). |
| `lib/search/schema.ts` | `SearchDocument` TypeScript type, the `INDEX_SETTINGS` constant, and a Zod schema for the read API's query params. |
| `lib/search/queries.ts` | `searchAll(query, opts)` — wraps the Meilisearch client for the read path. Returns hits + per-kind facet counts. |
| `lib/search/highlight.ts` | Sentinel-replace highlighting helper (`safeHighlight(escaped, openTag, closeTag)`) — XSS-safe wrapping of `_formatted` field values. |
| `lib/search/actions.ts` | `'use server'` — `reindexAll()` action (auth-gated; enqueues a SearchReindex job, returns immediately). |
| `worker/jobs/search-index.ts` | Per-row sync handler `handleSearchIndex({kind, id, op})`. |
| `worker/jobs/search-reindex.ts` | Full-rebuild handler `handleSearchReindex()`. Concurrency-guarded against double-runs. |
| `app/api/search/route.ts` | Auth-gated GET handler for the read path. Route Handler (not Server Action) so the dropdown can use `AbortController` for stale-request cancellation. |
| `app/(app)/search/page.tsx` | `/search` page with input, kind facet pills, paginated results. Server Component initial render; pagination via URL params. |
| `components/search/SearchBar.tsx` | Header search input + dropdown. Debounced 250ms, AbortController for stale requests, keyboard-navigable (arrow keys, Enter, Escape). |
| `components/search/SearchResults.tsx` | Shared result-row rendering. Accepts a hit + the highlight tag preferences. |
| `components/search/RebuildIndexButton.tsx` | Tiny `'use client'` wrapper around the `reindexAll` action for the settings page. Shows the result toast. |

### Modifications

- **`lib/queue.ts`**: add `SearchIndex: 'search.index'` and `SearchReindex: 'search.reindex'` to the `Queue` const. The existing `getBoss()` `createQueue` loop picks these up automatically.
- **`worker/index.ts`**: register both handlers — `boss.work(Queue.SearchIndex, ...)`, `boss.schedule(Queue.SearchReindex, '0 3 * * *')`, `boss.work(Queue.SearchReindex, ...)`. Same shape as Plan 3's notify+tick wiring. Also call `applyIndexSettings()` once at startup (idempotent).
- **`lib/{items,vendors,notes,service-records,reminders}/actions.ts`** + **`lib/attachments/actions.ts`**: after each create/update/delete, `await boss.send(Queue.SearchIndex, {kind, id, op})`. Identical 1-line addition per call site (~15 sites total).
- **`app/(app)/layout.tsx`**: add `<SearchBar />` in the header. Server-rendered shell, hydrates client-side for the input.
- **`app/(app)/settings/page.tsx`**: add a "Search index" section with `<RebuildIndexButton />`.

### Why this shape

- **Single client singleton** mirrors `lib/db.ts` and `lib/queue.ts` — module-level lazy init, reused across both worker and Route Handler.
- **Pure `buildDocument(kind, id)` per kind** keeps the worker handler trivial (dispatch by kind, call build, upsert/delete) and lets unit tests cover the most-likely-to-break logic without touching Meilisearch.
- **Single unified index over six per-kind indices** because Meilisearch's relevance scoring works best when all matches compete in one query; faceting handles the "filter to one kind" use case cleanly. The synthetic `${kind}:${id}` primary key prevents id collisions across tables.
- **Per-action enqueue over Prisma `$extends` middleware** matches the existing project style — Server Actions already explicitly call `revalidatePath`; calling `boss.send` next to it is consistent and visible. Auto-enqueue middleware would hide the side-effect.
- **Route Handler over Server Action for reads** because instant search needs `AbortController` (cancel stale requests when the user keeps typing). Server Actions don't expose abort semantics and can't be cancelled from the browser.

## Data model

### Index document shape

```ts
type SearchKind = 'item' | 'vendor' | 'note' | 'service' | 'reminder' | 'attachment';

type SearchDocument = {
  // Composite primary key — domain ids are only unique within their table.
  id: string;                          // e.g. "item:cmom..." | "reminder:cmoma..."

  kind: SearchKind;
  recordId: string;                    // the underlying domain id (used to build links)

  // Searchable text
  title: string;                       // Item.name | Vendor.name | Note.title | Reminder.title | Attachment.filename | ServiceRecord.summary
  body: string;                        // Note.body | Reminder.description | ServiceRecord.notes | Attachment.extractedText (dormant; populated in Plan 4c)
  tags: string[];                      // Note.tags; [] for other kinds
  itemName: string;                    // for kinds attached to an item: Item.name (denormalized for join-search)

  // Filter facets
  itemId: string | null;               // for kinds attached to an item; null otherwise
  categorySlug: string | null;         // for items only

  // Display-only metadata, computed at index time
  href: string;                        // ready-to-use route, e.g. `/items/${id}` | `/reminders/${id}`
  iconHint: string;                    // emoji matching the dashboard-activity convention
  updatedAt: number;                   // unix-seconds for tie-breaking ranking
};
```

### Index settings

```ts
const INDEX_SETTINGS = {
  searchableAttributes: ['title', 'itemName', 'body', 'tags'],
  filterableAttributes: ['kind', 'itemId', 'categorySlug'],
  sortableAttributes: ['updatedAt'],
  rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
  pagination: { maxTotalHits: 1000 },
} as const;
```

### Denormalized `itemName`

`itemName` is a copy of the parent Item's name on every attachment, service record, reminder, and note that belongs to that item. Searching "furnace" matches the Furnace item AND every child document — the obvious user expectation.

**Cost:** when an Item's name changes, the search-index handler re-upserts every child document. The `buildDocument('item', id)` call writes the parent doc; a `buildChildren(itemId)` helper iterates the children and re-upserts each. For typical household scale (~50 items × ~10 children each), worst-case rename = ~500 upserts in a single batch — Meilisearch handles in <1 sec.

**Alternative considered:** join at query time via two Meilisearch queries + manual merge in the read path. Rejected — adds latency to every query for an event (item rename) that's rare.

### Database changes

**None.** Plan 4a doesn't add or modify any Prisma models. All persistence is in Meilisearch's own storage.

## Sync data flow

### Per write

```
User submits form → Server Action validates + writes Postgres row
                  → revalidatePath(...)
                  → boss.send(Queue.SearchIndex, {kind, id, op})  ← fire-and-forget
                  → return { ok: true } to user                     (no await on Meilisearch)

Worker picks up job
   handleSearchIndex({kind, id, op}):
     if op === 'delete':
        meilisearch.index('house').deleteDocument(`${kind}:${id}`)
        if kind === 'item': delete all children docs (query Postgres for them by itemId)
     else: // 'upsert'
        doc = buildDocument(kind, id)
        if doc === null: deleteDocument(`${kind}:${id}`)   // soft-deleted/orphan row
        else: addDocuments([doc])
        if kind === 'item': re-upsert all children for the new itemName
```

### Read path

```
Header dropdown:
  user types → SearchBar debounces 250ms → AbortController-wrapped fetch
   GET /api/search?q=furnace&limit=5
  → searchAll('furnace', {limit: 5})
  → meilisearch.search({q, limit, attributesToHighlight: ['title','body']})
  → returns { hits: [{kind, recordId, title, href, iconHint, _formatted: {...}}], ... }
  → dropdown renders top 5 + "See all results →" link

/search page:
  initial query from ?q= → server-render first page (RSC)
  user clicks facet pill → URL updates → re-fetch
  GET /api/search?q=furnace&kind=service&page=2
  → searchAll('furnace', {filter: 'kind = service', limit: 20, offset: 20})
  → page renders results + facet counts in pills + pagination
```

### Reindex-all

```
Trigger (manual button OR 03:00 cron):
  worker handleSearchReindex():
    1. Concurrency guard: if another search.reindex job is active, return early
    2. meilisearch.deleteIndex('house')              // wipe
    3. meilisearch.createIndex('house')               // recreate
    4. applyIndexSettings()                           // re-apply
    5. for each kind in ORDER [item, vendor, note, service, reminder, attachment]:
         (items first so children's denormalized itemName is correct on first pass)
         streamFromPostgres(kind, batchSize=1000):
            buildDocument(kind, id) for each row
            meilisearch.addDocuments(batch)
    6. log enqueued/processed counts
```

## Error handling

### Sync-side

| Failure | Behavior |
|---|---|
| Meilisearch down when Server Action enqueues | Server Action succeeds (Postgres write committed); pg-boss retries the index job per its default policy. Reindex-all is the recovery path. |
| Meilisearch up but the upsert fails (network blip, rate limit) | pg-boss's normal retry covers it. After exhausted retries the job lands in `pgboss.archive` — observable via `boss.fetch(name, {state: 'failed'})`. |
| Domain row deleted between enqueue and worker pickup | `buildDocument(kind, id)` returns `null` → handler issues a `deleteDocument` — idempotent no-op if the doc was never indexed. |
| Two writes for the same row arrive at different workers in different order | Both jobs run; whichever processes last wins. Documents are upserted by composite id, so no duplicates. |

### Read-side

| Failure | Behavior |
|---|---|
| Meilisearch down on read | `/api/search` returns `503 Service Unavailable` with `{error: 'search-unavailable'}`. SearchBar shows "Search temporarily unavailable" inline. `/search` page shows a banner. No throw, no redirect. |
| Empty query (`q=` or `q=     `) | API returns `{hits: [], facets: {}, total: 0}` immediately without calling Meilisearch. UIs render an empty hint state. |
| Filter for a kind with no matches | Returns `{hits: [], facets: {kind: {item: 5, …}}}` so the UI can still show "0 in service records, but 5 in items — switch filter?" |
| Reindex-all running while a search query comes in | Index is briefly absent during the drop+recreate window (~1 sec). Reads during that window get the 503 path. |

### Auth + privacy

- `/api/search` is auth-gated via `auth()` — same pattern as Plan 3's `/api/calendar/[token]` except by-session not by-token.
- All documents in the index are visible to all authed users (household-shared read model).
- `Attachment.aiIndexable: false` does **not** affect Find — it gates AI-indexing (chunks/embeddings) only, not keyword search by filename. Find by filename is just keyword search; the privacy escape hatch is meant for "don't put this in an LLM prompt," not "don't show it in search."

### Concurrency on reindex-all

Manual button enqueues the job; if another is already running or queued, the second enqueue creates a separate job — Meilisearch would see two consecutive drops+recreates. Wasteful but not incorrect. Light protection: the handler checks `boss.fetch(name, {state: 'active'})` at the start and returns early with "another rebuild is already running." Implementable in ~5 LOC.

### Highlighting (XSS mitigation)

Meilisearch's `_formatted` field wraps matches in configurable tags. Direct rendering of user content as raw HTML is unsafe. Sanitation pattern:

1. Configure the search call with `highlightPreTag: '__HL_OPEN__'` and `highlightPostTag: '__HL_CLOSE__'` (unique sentinels unlikely to appear in user content).
2. In the read path, take the `_formatted` value, escape HTML (`&<>"'`), then replace `__HL_OPEN__` → `<em>` and `__HL_CLOSE__` → `</em>`.
3. The only HTML that survives the escape-then-replace pipeline is the controlled `<em>` tags; everything else is text. The React component renders the resulting string via the dangerous-HTML prop without further sanitization.

Standard XSS-safe pattern for search highlight rendering. Unit-tested in `lib/search/highlight.test.ts`.

## Testing

### Unit (Vitest, no DB)

| File | Cases |
|---|---|
| `lib/search/document.test.ts` | `buildDocument` per kind: id composition, itemName denormalization, missing-attached-item produces `null` for `itemId`/`itemName`/`categorySlug`, deleted-row returns `null`. ~10 cases. |
| `lib/search/highlight.test.ts` | Sentinel-replace XSS mitigation — plain text, HTML chars escaped, multi-match, sentinel survives the escape, no-match returns escaped original. ~6 cases. |
| `lib/search/schema.test.ts` | Zod schema for the search query (validates `q`, `kind`, `limit`, `offset`, `page`). Boundary cases. ~5 cases. |

### Integration (Vitest + Testcontainers)

`tests/integration/helpers.ts` extended to spin up a Meilisearch container alongside the Postgres one. `setupIntegration()` returns `{prisma, meili}` (existing tests are unaffected — they don't read `meili`).

| File | Cases |
|---|---|
| `tests/integration/search-index.test.ts` | `handleSearchIndex` end-to-end: upsert item, upsert+search-by-name, delete cascades to children, item rename re-upserts children with new itemName, deleted-domain-row handler issues delete (no error). ~7 cases. |
| `tests/integration/search-reindex.test.ts` | Full rebuild: seed 10 of each kind, run `handleSearchReindex`, assert all 60 docs are queryable. Includes idempotency on missing index and concurrent-rebuild guard. ~3 cases. |
| `tests/integration/search-query.test.ts` | Read API: `searchAll('furnace', ...)` against a populated index. Cases: simple query, kind facet filter, item facet filter, empty query, special chars. ~5 cases. |

### E2E (Playwright)

| File | Cases |
|---|---|
| `tests/e2e/search.spec.ts` | One spec, three sub-flows: (1) sign in → create item "Furnace" → poll `/api/search?q=furnace` until indexed (5s timeout) → header dropdown shows result → click navigates to item page; (2) `/search?q=furnace` → click "service records" facet → verify filtered count; (3) rename item to "Boiler" → search "boiler" works → search "furnace" returns no result. |

The poll-for-sync wait covers the eventual-consistency window introduced by fire-and-forget enqueue.

### Test infrastructure additions

- `tests/integration/helpers.ts`: Meilisearch container + factory function (~20 LOC).
- `tests/e2e/auth.ts` (`resetAuth`): also wipes the Meilisearch index (`meili.deleteIndex('house').catch(() => {})`) — same isolation hole pattern fixed for Plan 3 in PR #19's follow-up.

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| `meilisearch` | `~0.45.x` (current major) | Official client |

That's the only new runtime dependency. Meilisearch the server is already in `docker-compose.yml`. No new dev dependencies — Testcontainers can run the same `getmeili/meilisearch:v1.42` image.

## Operations

- **Container resource needs**: Meilisearch's footprint is small (~50MB RAM idle, ~10MB per 10k documents). Already provisioned in `docker-compose.yml`; no infra changes.
- **Backup**: Meilisearch state lives in a Docker volume. Existing backup story (Postgres snapshot) doesn't currently include Meilisearch volumes. Out of scope for 4a — covered by reindex-all (recovery from Postgres truth).
- **Settings drift**: `applyIndexSettings()` runs at worker startup and is idempotent. If someone manually pokes the index, the next worker restart re-applies the canonical settings.

## Open questions / future work

- **Search analytics** (top queries, no-result queries) — Plan 5 polish.
- **Synonyms / stop-words tuning** — Meilisearch supports both as runtime settings; deferred until users report relevance issues.
- **Per-user "recent searches"** — UX polish; not v1.
- **Permission scopes** if multi-user / multi-household ever lands — would need a per-document `householdId` filter applied to every search. Schema-extensible.
- **Highlighting in the dropdown** — currently planned for the `/search` page hits only; dropdown rows are short and the `_formatted` value can include enough context for one line. Decision deferred to implementation; if dropdown highlighting is awkward, ship without and add in polish.
- **iCal feed of past completions** — out of scope; Plan 3 deferred this too.

## Appendix: critical user flows

### A. Search across kinds from the header

1. User types "filter" in the header search box.
2. After 250ms idle, browser fetches `/api/search?q=filter&limit=5`.
3. Dropdown renders 5 results with kind badges (📦 Item, 🔧 Service, ⏰ Reminder, etc.).
4. User clicks the "Replace HVAC filter" reminder result → navigates to `/reminders/<id>`.

### B. Filtered browse via `/search`

1. User clicks "See all results →" in the dropdown (or navigates directly to `/search?q=filter`).
2. Page renders all matches grouped by relevance, with facet pill row across the top showing per-kind counts ("All 12 · Items 3 · Reminders 4 · Services 5").
3. User clicks "Reminders 4" → URL becomes `/search?q=filter&kind=reminder` → page re-fetches → shows only the 4 reminder hits.
4. User scrolls to bottom → "Next page" link → URL adds `&page=2`.

### C. Force a reindex after a manual data fix

1. User runs a manual SQL update against Postgres (e.g., bulk renaming categories).
2. Search results show stale data for ~5 seconds because the change bypassed Server Actions and didn't enqueue.
3. User goes to `/settings`, clicks "Rebuild search index".
4. Server Action `reindexAll` enqueues a `search.reindex` job; button shows "Rebuild started — refresh in a few seconds".
5. Worker drops + recreates the index, backfills from Postgres in batches.
6. Subsequent searches reflect the post-fix data.
