# House Manager — Design Spec

**Date:** 2026-04-26
**Status:** Draft for review
**Authors:** Oliver Wine (with Claude)

## Overview

A self-hosted, multi-user web application for managing household information: appliances and other items, vendors, service records, warranties, manuals/documents, general knowledge, and recurring maintenance reminders and checklists. Includes AI-powered search, Q&A grounded in user-uploaded documents, and AI-suggested seasonal task lists.

Designed for a single household with multiple users, deployed via Docker Compose on a home server. Authentication delegated to Authelia via OIDC.

## Goals

1. Be the durable system of record for "everything I know about my house" — items, vendors, service history, warranties, knowledge.
2. Keep maintenance from being forgotten via push notifications, email reminders, and an iCal feed.
3. Make the data instantly searchable (typo-tolerant keyword) and queryable (RAG over uploaded manuals/photos).
4. Personalize maintenance suggestions to the user's actual inventory and house profile.
5. Run reliably on a home server with backups, observability, and a sane upgrade path.

## Non-goals (v1)

- Multi-household / multi-tenant.
- Native mobile apps. (PWA only.)
- Local LLM provider. (Architecture supports it via abstraction; only Anthropic+Voyage shipped.)
- Granular per-item ACLs. All household members see all items.
- Public sharing links.
- Real-time collaboration / WebSockets.
- Two-factor auth on the app itself. (Authelia owns auth, including 2FA.)

## Architecture

### Stack

- **Web app:** Next.js 15 (App Router, React Server Components, TypeScript)
- **ORM:** Prisma
- **Database:** Postgres 16 with `pgvector` extension and built-in FTS
- **Search:** Meilisearch (typo-tolerant keyword/instant search)
- **Auth:** Auth.js v5, generic OIDC provider pointed at Authelia
- **Background jobs:** `pg-boss` (Postgres-backed queue, no Redis)
- **File storage:** bind-mounted local volume (`/data/files`), served via authenticated Next.js route
- **Email:** ForwardEmail HTTP API
- **Web Push:** `web-push` library, VAPID keys
- **AI generation:** Anthropic Claude Haiku 4.5 (default; cost-optimized)
- **AI embeddings:** Voyage AI `voyage-3-lite` (1024-dim)
- **OCR:** Tesseract (default, local) with optional Claude Haiku vision backend
- **Image normalization:** `sharp` (HEIC support, EXIF rotation, thumbnail generation)
- **AI provider abstraction:** thin `AIProvider` interface; only Anthropic+Voyage shipped, but business logic is provider-agnostic for future Ollama/OpenAI plug-in.

### Compose services

```
[Browser/PWA] ── HTTPS ──► [web (Next.js)] ──┐
                                              ├──► [db (Postgres + pgvector)]
                              [worker] ──────┤            ▲
                                  │           └──► [meilisearch]
                                  ├─► ForwardEmail API
                                  ├─► Web Push (VAPID)
                                  └─► Anthropic + Voyage
```

Four services: `web`, `worker`, `db`, `meilisearch`. Optional `caddy` for TLS if the user does not already have a reverse proxy.

The `web` and `worker` containers share a single Docker image, run with different commands. This keeps build outputs identical and avoids drift.

### Why this shape

- Single language (TypeScript) end-to-end.
- Single database for relational data, FTS, and vectors.
- Worker is a separate container so reminders fire on schedule independent of web traffic.
- No Redis: pg-boss covers the job load at household scale.
- No dedicated vector DB: pgvector handles thousands of chunks easily and JOINs natively with item/category filters.
- Meilisearch earns its container by providing typo-tolerant instant search that Postgres FTS cannot match without significant hand-rolling.

## Data model

Prisma-flavored pseudocode. JSONB-typed fields are noted explicitly.

### Identity

```
User
  id, oidcSub (unique), email, name
  role: ADMIN | MEMBER
  createdAt, lastLoginAt
  pushSubscriptions: PushSubscription[]
  notificationPrefs: Json
    // { push: bool, email: bool, leadTimeDays: int,
    //   quietHours: { startHour: int, endHour: int, tz: string } }

PushSubscription
  id, userId, endpoint, p256dh, auth, userAgent, createdAt

HouseProfile         // singleton row, edited in /settings
  id, location (city/region), climateZone, propertyType
  // Used to personalize AI suggestions.
```

### Core domain

```
Category             // seeded; not user-editable in v1
  id, slug (unique), name, icon
  // Seeds: Appliance, HVAC, Plumbing, Electrical, Exterior,
  //        Vehicle, Tool, Landscaping, Other.

Item
  id, name, categoryId, location (string, optional)
  manufacturer, model, serialNumber, purchaseDate, purchasePrice
  metadata: Json     // category-specific fields (BTU, sqft, VIN, etc.)
  notes (markdown)
  archivedAt (nullable)            // soft delete; preserves service history
  includeInSuggestions (bool, default true)
  createdAt, updatedAt

Vendor
  id, name, kind (string, e.g. "plumber"), phone, email, website
  address, notes (markdown), tags: string[]

Warranty
  id, itemId, provider, policyNumber
  startsOn, endsOn, coverage (markdown), cost
  // Attachments referenced via Attachment.warrantyId.

ServiceRecord
  id, itemId (nullable)            // not all service is item-specific
  vendorId (nullable)
  performedOn, cost, summary, notes (markdown)
  reminderId (nullable)            // populated if auto-created from completion
```

### Knowledge

```
Note
  id, title, body (markdown)
  itemId (nullable)                // notes can be standalone or attached to an item
  tags: string[], createdAt, updatedAt

Attachment
  id, filename, mimeType, sizeBytes, storagePath
  itemId | warrantyId | serviceRecordId | noteId   // exactly one set
       (enforced by CHECK constraint)
  uploadedById, createdAt
  extractedText (text, nullable)
  indexedAt (nullable)
  aiIndexable (bool, default true) // privacy escape hatch
  thumbnailPath (nullable)         // for images

DocumentChunk
  id, attachmentId, chunkIndex, content (text)
  embedding: Vector(1024)          // pgvector, voyage-3-lite dim
  // HNSW index for similarity search.
```

### Reminders & schedules

```
Reminder
  id, itemId (nullable), title, description (markdown)
  recurrence: Json                 // see Recurrence shape below
  lastCompletedOn (nullable), nextDueOn
  leadTimeDays (default 3)
  notifyUserIds: string[]          // default = all household members
  autoCreateServiceRecord (bool, default false)
  active (bool), createdAt

ReminderCompletion
  id, reminderId, completedById, completedOn
  notes (markdown), createdServiceRecordId (nullable)

Checklist
  id, name, description (markdown)
  schedule: Json (nullable)        // same shape as Reminder.recurrence; null = ad-hoc
  nextDueOn (nullable)
  active (bool)

ChecklistItem
  id, checklistId, position, title
  itemId (nullable)                // a checklist item may reference a house Item

ChecklistRun
  id, checklistId, startedOn, completedOn (nullable), startedById

ChecklistRunItem
  id, runId, checklistItemId
  completedAt (nullable), completedById, notes
```

### Audit

```
NotificationLog
  id, reminderId, userId, channel (push|email),
  cycle (text, e.g. "2026-04 reminder #123"),
  sentAt, status (sent|failed|skipped), errorReason

AISuggestionLog
  id, userId, kind (checklist|reminders|tasks),
  prompt, response (Json),
  acceptedItemIds: Json,
  createdAt
```

### Recurrence shape

```ts
type Recurrence =
  | { kind: "interval"; days: number }                // every N days from last completion
  | { kind: "anchored"; rrule: string }               // RFC 5545 RRULE
  | { kind: "monthly"; dayOfMonth: number }           // sugar
  | { kind: "yearly"; month: number; day: number };   // sugar
```

Backed by the `rrule` npm library. Anchored recurrences re-export verbatim into the iCal feed.

## Reminder & scheduling engine

The worker container runs a pg-boss cron job every 5 minutes:

1. Find Reminders where `nextDueOn <= now() + leadTimeDays` and not yet notified for the current cycle.
2. For each reminder, fan out a notification job per (user × channel) — push and/or email.
3. Mark "notified for this cycle" via `NotificationLog`.
4. Same loop for Checklists with `schedule.nextDueOn` upcoming → auto-create a `ChecklistRun`.

### Completing a reminder

1. User taps "Done" → server inserts a `ReminderCompletion`.
2. If `autoCreateServiceRecord` is true, present a quick form (vendor, cost, notes) and save a `ServiceRecord` linked back to the completion.
3. Compute `nextDueOn`:
   - `interval`: `completedOn + days`.
   - `anchored` / sugar variants: next RRULE occurrence after `completedOn`.
4. Reset cycle-notified state.

### Notification model

- **Per-user prefs** in `User.notificationPrefs`: channels, default lead time, quiet hours.
- **Per-reminder override** in `Reminder.notifyUserIds`: which household members get notified.
- **Quiet hours**: worker holds the notification job and re-queues for the next allowed window.

### iCal feed

- `GET /api/calendar/{userToken}.ics` — opaque per-user token, generated on demand, revocable from settings.
- Returns reminders + upcoming checklist runs as VEVENTs with VALARM set to user's lead time.
- Subscribers (Apple/Google Calendar) poll every few hours; no webhook required.

### Edge cases

- Reminder created with `nextDueOn` in the past → fires on next worker tick.
- Early completion → next due computed from completion date (interval) or next valid RRULE date (anchored).
- Push subscription expired (HTTP 410) → notification job deletes the dead subscription record.
- Reminder marked inactive → existing pending notification jobs cancelled.

## AI capabilities

Three distinct features, all built on the `AIProvider` abstraction.

### Find — Meilisearch keyword search

- Indexes: items, vendors, notes, service records, attachment filenames, attachment extracted-text snippets.
- Single unified index with a faceted `kind` field; UI offers per-kind filtering.
- Sync: every Item/Note/Vendor/ServiceRecord write enqueues a pg-boss job that upserts the indexed document. Self-healing via a `reindex-all` job that rebuilds Meilisearch from Postgres.
- UI: header search box with instant dropdown; full-results page with facets at `/search`.

### Ask — RAG over user documents

**Indexing** (worker job `extract-text`, `embed-chunks`):

```
PDF:
  1. pdf-parse text layer.
  2. If extracted text < 200 chars → render pages to PNG via pdfjs-dist → OCR each page → concat.
  3. Else use extracted text.

Image (jpeg, png, webp, heic, ...):
  1. sharp normalizes to PNG (HEIC decode, EXIF rotation, downscale large images).
  2. OCR via configured backend.
  3. Generate thumbnail to /data/files/<id>/thumb.webp.

Text (txt, md):
  1. Read directly.

Other (binary formats): skip indexing, set indexedAt with a note.
```

After text extraction:

1. Chunk text (~500 tokens, ~50-token overlap).
2. Batch-embed chunks via Voyage `voyage-3-lite` (up to 128 per request).
3. Insert `DocumentChunk` rows.
4. Set `Attachment.indexedAt`.
5. Skip everything if `Attachment.aiIndexable = false`.

**OCR backend** (env var `OCR_BACKEND`):

- `tesseract` (default): local, free, ~80MB Docker layer for binary + English language pack.
- `claude-vision`: better quality on messy scans, costs ~$0.001/page, network call.
- `none`: disable OCR; only text-extractable documents indexed.

**Query flow:**

1. User asks a question (optionally scoped to a specific Item).
2. Embed query with `voyage-3-lite`.
3. `SELECT chunks ORDER BY embedding <=> queryEmbedding LIMIT 8` (with optional WHERE filter).
4. Build prompt with cached system message + cited sources.
5. Stream Claude Haiku 4.5 response.
6. UI renders streamed answer + clickable citation links to the original attachments.

### Suggest — structured generation

Entry points:
- Dashboard: "Generate a checklist for [current season]".
- Item detail: "Suggest reminders for this item".
- Item creation flow: "Suggest reminders" step before save.
- Checklist editor: "Suggest items to add".
- Standalone `/suggest` page with free-form prompt.

Flow:
1. Build context: inventory summary (items grouped by category with model/manufacturer, filtered to `includeInSuggestions = true`), current date/season, `HouseProfile` (location, climate zone, property type), optional user prompt.
2. Call Claude Haiku 4.5 with a tool definition (`propose_checklist` or `propose_reminders`) whose schema mirrors the corresponding Prisma model.
3. Render tool call result as a preview UI: each proposed item has a checkbox (accept) and edit pencil.
4. "Save selected" bulk-inserts into the Checklist or Reminder tables.
5. Log the prompt/response/acceptances to `AISuggestionLog`.

### Cost & performance

- Embeddings (`voyage-3-lite`, $0.02/1M tokens): ~100 manuals ≈ ~$0.05 one-time.
- Per Ask query (Haiku 4.5, ~3K context + ~500 output): well under $0.01; system prompt cached drops repeat-query cost ~80%.
- Per Suggest call (Haiku 4.5, structured output ~1K tokens): well under $0.01.
- pgvector HNSW similarity search: ~5ms at this scale.
- Embedding API latency: ~200ms; Haiku streaming first-token ~500ms.

### Privacy

- Per-attachment `aiIndexable` flag (default true): when false, never embedded or sent to Claude/Voyage.
- Per-item `includeInSuggestions` flag (default true): excluded from Suggest prompts.
- All AI keys are server-side; never sent to the client.

## Application structure

### Code layout (Next.js App Router)

```
/app
  /(auth)/signin                  — OIDC redirect entry
  /api/auth/[...nextauth]         — Auth.js handlers
  /api/files/[id]                 — authenticated file serving
  /api/calendar/[token].ics       — iCal feed
  /api/push/subscribe             — register push subscription
  /api/ai/ask                     — RAG endpoint (streams)
  /api/health, /api/health/ready  — liveness/readiness
  /(app)/                         — auth-gated layout
    /dashboard                    — what's due, recent activity
    /items                        — list, filter
    /items/[id]                   — detail with tabs
    /items/new
    /vendors                      — list, search
    /vendors/[id]
    /reminders                    — upcoming, snoozed, history
    /checklists                   — templates
    /checklists/[id]
    /checklists/runs/[id]
    /notes
    /search                       — full search results
    /ask                          — conversational RAG
    /suggest                      — AI suggestion center
    /settings                     — profile, prefs, push, HouseProfile
    /admin                        — users, categories, jobs, backups (admin-only)

/lib
  /db, /auth, /reminders, /ai, /search, /push, /email, /storage

/worker
  /index.ts                       — pg-boss bootstrap
  /jobs
    reminder-tick.ts
    notify-push.ts
    notify-email.ts
    extract-text.ts
    embed-chunks.ts
    sync-meilisearch.ts
    cleanup-expired-pushes.ts

/prisma/schema.prisma
/public/sw.js                     — service worker
/docker-compose.yml
/Dockerfile
```

### UX patterns

- **Item detail page** is the centerpiece — tabbed: Overview · Warranties · Service · Reminders · Notes · Files.
- **Quick capture** flow on mobile: per-item buttons for "Log service," "Add note," "Upload photo/PDF," "Add reminder."
- **Dashboard** has three lanes: *Due soon* (next 14 days), *Active checklists*, *Recent activity*.
- **Cmd-K command palette** (desktop): search items/vendors/notes, jump to Ask, quick-create.
- **Mobile bottom nav:** Dashboard · Items · Search · Ask · More.
- **PWA install nudge:** banner detects iOS Safari and shows "Add to Home Screen" instructions (required for iOS push since 16.4).
- **Theme:** light/dark/system, follows OS preference.
- **Data plate capture:** new-item flow can take a photo of the data plate; OCR + Claude vision tool-call extracts manufacturer/model/serial as form suggestions.

### Forms & validation

- **Zod** schemas shared between client (React Hook Form) and server (Server Action input validation).
- Server Actions return `{ ok: true, data } | { ok: false, error }` discriminated unions; UI renders inline errors.

### Error handling

- Worker jobs use pg-boss retry-with-exponential-backoff. Permanent failures appear in `/admin/jobs` (dead-letter view).

## Deployment & operations

### docker-compose.yml shape

```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    volumes: [pgdata:/var/lib/postgresql/data]
    environment: [POSTGRES_PASSWORD, POSTGRES_DB=housemanager]
    healthcheck: pg_isready

  meilisearch:
    image: getmeili/meilisearch:v1.10
    volumes: [meilidata:/meili_data]
    environment: [MEILI_MASTER_KEY, MEILI_ENV=production]

  web:
    build: .
    command: node server.js
    depends_on: [db, meilisearch]
    volumes: [files:/data/files]
    environment: <see .env.example>
    ports: ["3000:3000"]

  worker:
    build: .
    command: node worker.js
    depends_on: [db, meilisearch]
    volumes: [files:/data/files]
    environment: <same as web>

volumes: { pgdata, meilidata, files }
```

### First-run setup

`make setup` (or npm script):

1. Generate VAPID keypair → write to `.env`.
2. Generate Meilisearch master key → write to `.env`.
3. Prompt for Authelia OIDC issuer URL, client ID, client secret.
4. Prompt for Anthropic + Voyage + ForwardEmail API keys.
5. Run `prisma migrate deploy`; seed Categories.
6. Create the first admin user record (matched by `oidcSub` on first login).

### Backups

`scripts/backup.sh` produces a single tarball of:

1. `pg_dump` of the database (vectors included as binary).
2. `tar` of the `/data/files` volume.
3. The `.env` values (encrypted) — without VAPID keys, push subscriptions break on restore.

Optionally encrypted with `age`. Worker container nightly cron runs this and keeps last N copies in `/data/backups`.

**Restore procedure:** stop stack → `pg_restore` → untar files → start stack → run `reindex-all` job (Meilisearch rebuilds from Postgres).

### Migrations

Prisma Migrate. The `web` container's entrypoint runs `prisma migrate deploy` before starting the server (idempotent). `prisma/migrations/` is committed to the repo.

### Observability

- Logs: stdout JSON via `pino`.
- Health endpoints: `/api/health` (process up), `/api/health/ready` (db + Meilisearch reachable).
- Worker dashboard: `/admin/jobs` shows pg-boss queue depth, recent failures, last-run timestamps.
- No Prometheus/Grafana shipped; users can scrape stdout if they want.

### Security

- All routes auth-gated except `/api/health`, OIDC callback, and the iCal feed (token-protected).
- File serving validates the requesting user has access to the parent entity.
- All Server Action input validated by Zod; DB access via Prisma (parameterized vector queries the only raw SQL).
- CSP headers via Next.js config; no inline scripts except service-worker registration shim.
- Secrets only via env vars; `.env.example` documents every required variable.
- ForwardEmail / Anthropic / Voyage / Meilisearch keys never sent to the client.

## CI/CD, testing, lint

### Tooling

| Concern | Tool |
|---|---|
| Package manager | pnpm |
| Lint + format | Biome |
| Typecheck | tsc --noEmit |
| Unit tests | Vitest |
| E2E tests | Playwright |
| Integration tests | Vitest + Testcontainers |
| Pre-commit | lefthook |
| Commit format | Conventional Commits |
| Migration drift check | prisma migrate diff |

### Local dev scripts

```
pnpm dev          → next dev + tsx worker --watch
pnpm build        → next build && tsc -p worker
pnpm lint         → biome check .
pnpm format       → biome format --write .
pnpm typecheck    → tsc --noEmit
pnpm test         → vitest run
pnpm test:watch   → vitest
pnpm test:e2e     → playwright test
pnpm db:migrate   → prisma migrate dev
pnpm db:seed      → tsx prisma/seed.ts
pnpm verify       → lint + typecheck + test
```

### Pre-commit (lefthook)

```
pre-commit:
  - biome check --staged
  - tsc --noEmit (incremental)
pre-push:
  - vitest run --changed
```

### GitHub Actions pipeline

```
setup            → checkout, pnpm install, restore caches
  ├─ lint
  ├─ typecheck
  ├─ migrate-check  (prisma migrate diff --exit-code)
  ├─ unit           (vitest --coverage)
  └─ integration    (testcontainers: postgres + meilisearch)
e2e              → playwright (depends on build)
build            → next build, docker build, push to GHCR (main only)
```

- PRs run lint + typecheck + migrate-check + unit + integration + e2e in parallel.
- Push to `main` additionally builds and publishes the Docker image to GHCR (`:sha`, `:latest`).
- Tagged releases publish `:vX.Y.Z` and run a smoke test that boots the full Compose stack.

### Coverage targets (aspirational, not gates initially)

- Unit: 80% on `lib/reminders`, `lib/ai`, `lib/search`.
- Integration: every job type in `worker/jobs/` covered.
- E2E: 6 critical paths — sign in, create item, log service, complete reminder, run checklist, ask AI question.

### Dependency management

Renovate config that:
- Groups patch updates into a single weekly PR.
- Auto-merges patch updates if CI passes.
- Flags major updates separately for manual review.

### Branch protection

`main` requires: passing CI, up-to-date with main, signed commits, linear history. Direct push disabled.

### Release flow

Conventional commits on `main` → **release-please** action proposes a release PR with auto-generated CHANGELOG → merging tags a release → tagged-image build runs.

## Open questions / future work

- **Local LLM provider** (Ollama). Not v1, but the `AIProvider` interface accepts it.
- **OCR upgrade path:** if Tesseract proves inadequate, users can flip `OCR_BACKEND=claude-vision`.
- **Multi-household.** Schema would need a `Household` table and a `householdId` foreign key on most rows. Out of v1.
- **Granular ACLs.** Current model: all household members see all items. If desired later, add a per-item visibility flag and per-user item-tag preferences.
- **Public sharing.** "Share this warranty PDF with my contractor" via signed time-limited link. Out of v1; design supports adding it as a separate `SharedLink` table.
- **Real-time updates.** v1 uses stale-while-revalidate; if multi-user concurrent editing becomes painful, add Server-Sent Events on the relevant pages.

## Appendix: critical user flows

1. **Onboarding:** sign in via Authelia → first-login creates User → admin sees empty dashboard → fills HouseProfile → creates first Item.
2. **Add appliance from data plate photo:** new Item → snap photo → OCR + Claude vision pre-fills manufacturer/model/serial → user confirms → optional "Suggest reminders" step.
3. **Log a service visit:** open Item → "Log service" → vendor (autocomplete from Vendors), date, cost, notes, optional file upload (receipt) → save → appears in Service tab and Recent Activity.
4. **Complete a reminder:** push notification → tap → app opens to reminder → "Done" → optional auto-service-record form → next due recomputed.
5. **Ask:** dashboard or item page → "Ask" → "What's the recommended filter size for the furnace?" → streamed answer with clickable citations.
6. **Generate fall checklist:** dashboard → "Generate fall checklist" → preview list → user unchecks 2 items, edits 1, saves → appears as a Checklist with `nextDueOn` set.
