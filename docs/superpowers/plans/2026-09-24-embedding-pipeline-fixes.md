# Embedding Pipeline Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Ask/RAG embedding pipeline match what CLAUDE.md already says about it. Checklist edits should re-embed the right rows. Deleted content should never reach the chat prompt. A transient Voyage failure should be retried and then repaired, not left stale forever.

**Architecture:** There are four layers, and each one catches what the layer before it can miss.
1. **Correct producers.** `CHECKLIST_ITEM` jobs carry `ChecklistItem.id`. Delete actions enqueue tombstones for the embeddable rows their FK cascades remove.
2. **Prompt-path guard.** A single SQL liveness predicate, `lib/embedding/live-source.ts`, filters retrieval. The nearest-neighbour scan it wraps is left untouched.
3. **Reconciliation.** `embed.backfill` sweeps orphans using that same predicate, fills gaps as it does today, and re-enqueues entities whose stored `contentHash` no longer matches their canonical text. It runs at boot, nightly and from the admin Rebuild button.
4. **Transport.** Voyage network errors and timeouts are classified as retryable. Every request is bounded by `AbortSignal.timeout`. `embed.content` gets an explicit pg-boss backoff policy that actually reaches existing databases.

**Tech Stack:** TypeScript, Prisma 7 (`$queryRaw` + `Prisma.sql` fragments), Postgres 18 + pgvector, pg-boss 12.33.2, Node 26 `fetch` (undici), Vitest 4 + Testcontainers.

---

## Background the implementer needs

**Findings as verified against the code (2026-09-24, `main` @ `b7a87cd`). Some differ from the review text:**

- **Q-H1: what a checklist-id job actually does today.** `enqueueEmbed('CHECKLIST_ITEM', checklistId)` reaches `embedEntity`, and `buildCanonical` runs `prisma.checklistItem.findUnique({ where: { id: checklistId } })`, which returns `null`. The "tombstone" branch then runs `deleteMany({ entityType: 'CHECKLIST_ITEM', entityId: checklistId })`. That deletes **0 rows**, because ids are cuids and never collide across tables. The call returns `{ status: 'deleted' }` and logs nothing (`lib/embedding/index.ts:52-60` logs only when `count > 0`). So every checklist enqueue is a silent no-op. **It never deletes the wrong thing.** Separately, `toggleChecklistItem` and `resetChecklist` **enqueue nothing at all**, even though `canonicalizeChecklistItem` embeds `Status: completed|pending`. Result: new items are embedded only by the boot backfill's missing pass, and toggles, resets and checklist renames never re-embed. Deleted items and deleted checklists leave orphan rows that nothing removes.
- **Per-item ids are already the established shape.** `lib/rename-cascade.ts:103` enqueues `CHECKLIST_ITEM` per `ChecklistItem.id`, and the loader, the canonicalizer, the boot backfill (`checklistItemIdsMissingEmbeddings`) and retrieval all key on it. **Decision: enqueue per-item ids, add no `CHECKLIST` enum value, no migration.** A whole-checklist entity would need a migration, a new canonicalizer, a new backfill query and a new liveness rule. It would also make one checklist a single chunk-set, so a question about one item would retrieve the whole list. Nothing consumes a checklist-level document.
- **Q-H2 correction: `Attachment` has no checklist parent.** Its parent FKs, all `onDelete: Cascade` (`prisma/schema.prisma`, `model Attachment`), are `itemId`, `partId`, `warrantyId`, `serviceRecordId`, `noteId` and `incomingEmailId`. Items and parts are **never hard-deleted** by any action (they archive). Nothing deletes an `IncomingEmail`. So the reachable cascades are: note, warranty and service-record deletes (attachments), and checklist deletes (items). `grep -rnE "\.(delete|deleteMany)\(" lib worker` confirms it.
- **Q-H2: `embeddings` is polymorphic with no FK** (`model Embedding`, `@@map("embeddings")`), so no cascade reaches it. `retrieveTopK` (`lib/ask/retrieve.ts:41-71`) returns rows without checking the source. `lib/chat/actions.ts:410-421` pastes them into the prompt.
- **P-H2: the error shape, measured on Node 26.9 with undici `fetch`.** A network failure throws `TypeError('fetch failed')` with `.cause` set to an `Error` carrying `.code`: `ENOTFOUND`, `ECONNREFUSED`, `ECONNRESET`, and so on. An `AbortSignal.timeout` expiry throws a `DOMException` with `name === 'TimeoutError'`. Neither is a `VoyageRetryableError`, so `worker/jobs/embed-content.ts:52-57` swallows them and pg-boss marks the job **completed**.
- **pg-boss retry options (read from `node_modules/pg-boss/dist/types.d.ts:417-466`, `manager.js:1815-1880`, `plans.js:592-631,1061-1086`).** `retryLimit` (default 2), `retryDelay` (seconds, default 0), `retryBackoff` (default false) and `retryDelayMax` (seconds, only allowed with `retryBackoff: true`) are `QueueOptions`. They are accepted by `createQueue(name, options)`, `updateQueue(name, options)` and per-job `send(..., options)`. **Trap: `createQueue` is `INSERT … ON CONFLICT DO NOTHING`.** A policy passed only to `createQueue` never reaches a database where the queue already exists, which is every deployment. `getBoss()` must also call `updateQueue` (idempotent). Jobs snapshot the queue's policy at `send()` (`plans.js:2005`, `COALESCE("retryLimit", q.retry_limit)`), so setting it in `getBoss()` covers the web and worker senders alike.
- **The stale-repair decision.** `contentHash` is `sha256(canonicalText)` (`lib/embedding/index.ts:68`). Detecting staleness needs only the canonical text, which is DB reads with no Voyage call. `embedEntity` already does this and short-circuits `unchanged`. Enqueuing a job per entity just to have the job discover "unchanged" would flood the queue: the worker runs `embed.content` at `batchSize: 1`. **Decision:** export `currentContentHash()` and compare inside the single backfill job. Only mismatches are enqueued. That makes CLAUDE.md's recovery claim true, so CLAUDE.md gets a clarification rather than a retraction. The cost is one indexed read per embedded entity per run, a few seconds at home-inventory scale.
- **Chat shares `embedTexts`** (`lib/chat/actions.ts:379`) and wraps it in a catch-all that returns "Could not process your message", so reclassifying a `TypeError` as `VoyageRetryableError` is invisible to chat. The new per-request timeout strictly *improves* chat: a wedged socket used to hang the server action with no limit. Transport failures are **not** retried inline, so chat fails fast. The existing inline 429 sleeps are unchanged in this PR (see "Not in this PR").
- **`Promise.all` over `enqueueEmbed` can start several pg-boss instances.** Concurrent first calls to `getBoss()` race (A-M1/P-M1), so new multi-id enqueue loops in this plan are sequential `for … await`.
- **Liveness must match `buildCanonical`.** `buildCanonical` returns `null` for a missing row, an archived `ITEM`/`PART`, and an `ATTACHMENT` with `aiIndexable = false`. The predicate uses exactly those rules. `ChecklistItem` has no `@@map`, so its table is `"ChecklistItem"`. The others are `items`, `notes`, `service_records`, `warranties`, `attachments` and `parts`. The predicate and the sweep SQL were checked for syntax against the dev DB, read-only (`SELECT`/`EXPLAIN` only).

**Sequencing.** This is PR **B** and merges **last**, after PR A (inbound-email security: `lib/incoming-email/ingest.ts`, the file route, the DMARC gate) and PR C (data integrity: the `deleteAttachment` wrong-directory fix, and a service-record delete that unlinks email-owned attachments instead of deleting them). This PR's edits to `deleteAttachment`, `deleteServiceRecord` and `lib/incoming-email/create-service-record.ts` are **additive enqueues only**, plus one `updateMany` → `updateManyAndReturn` in the link helper. Do not touch file-deletion logic or the unlink/detach logic. **Tasks 1-5 can run before PR C merges. Task 6 cannot:** it edits PR C's unlink branch (`deleteAttachment`) and PR C's `detachEmailOwnedAttachments` neighbour. Rebase onto a `main` that contains PR C first, then re-read the three functions (Task 6 Step 0).

**Why the email hand-off needs re-embeds (handed over from PR C).** `canonicalizeAttachment` writes `Linked to <kind>: <name>` from the parent ladder in `buildCanonical` (item → serviceRecord → warranty → note → part, with no `incomingEmail` rung). Two hand-offs therefore change an attachment's embedded text without touching `extractedText`. `createServiceRecordForEmail` links an inbox attachment to a new service record, so the text gains `Linked to serviceRecord: …`. PR C's unlink, in `deleteAttachment` and `detachEmailOwnedAttachments`, removes that parent, so the line disappears. So the drift-test exemption for `lib/incoming-email/create-service-record.ts`, "embedded content (extractedText) is unchanged", is false. Enqueuing is safe for attachments that have no text: `canonicalizeAttachment` returns `''` when `extractedText` is null, and `embedEntity` then stores nothing (`skipped`). It never creates a filename-only embedding.

**Repo conventions that apply:**
- Use `pnpm`, never `npx`/`npm`. Never `--no-verify`. `git commit` can fail silently behind the Biome/typecheck pre-commit hook, so **check that `HEAD` moved after every commit** (`git log --oneline -1`).
- Stage files explicitly (`git add <paths>`), never `-A` or `.`.
- Biome runs `noUnusedImports` as **error**. Don't commit an import that isn't used yet.
- Integration tests need `docker compose up -d db meilisearch` (Testcontainers starts its own containers, but the Docker daemon must be up). Run one file with `pnpm exec vitest run <path>`. `pnpm test:integration <path>` *widens* the run.
- Never call the real Voyage API in tests. Mock `@/lib/embedding/voyage`'s `embedTexts` (integration) or `vi.stubGlobal('fetch', …)` (unit), as the existing embedding tests do.
- `enqueueEmbed` reads `process.env.ASK_ENABLED` directly, and the worker handlers read `getEnv().ASK_ENABLED`. Tests set `process.env.ASK_ENABLED = 'true'` and, where a handler is called, mock `@/lib/env`.
- Anything the worker imports must live in `lib/`, `worker/` or `prisma/` and be a **production** dependency. This plan only adds imports of `@prisma/client` (already a prod dep, already worker-reachable via `lib/calendar-date-guard.ts`) and of new `lib/` files.

## File structure

| File | Responsibility |
|---|---|
| `lib/embedding/voyage.ts` *(modify)* | Per-request `AbortSignal.timeout`. Transport failures become `VoyageRetryableError` (with `cause`). |
| `lib/embedding/voyage.test.ts` *(modify)* | Classification + timeout-signal cases. |
| `worker/jobs/embed-content.test.ts` *(create)* | Handler contract, driven through the **real** `embedTexts`: network failure rethrown, 4xx swallowed. |
| `lib/queue.ts` *(modify)* | `QUEUE_POLICY` for `embed.content` / `embed.backfill`. `createQueue` + `updateQueue`. |
| `lib/queue.test.ts` *(create)* | Policy reaches both `createQueue` and `updateQueue`. Unlisted queues keep defaults. |
| `lib/checklists/actions.ts` *(modify)* | Per-item `CHECKLIST_ITEM` enqueues. Toggle/reset now enqueue. Deletes capture children first. |
| `lib/ai/suggest/checklist.ts` *(modify)* | Enqueue each created item id. |
| `lib/rename-cascade.ts` *(modify)* | Doc comment only: `Checklist.name → CHECKLIST_ITEM` is now covered. |
| `tests/unit/lib/embed-drift.test.ts` *(modify)* | Fix the wrong "keyed by checklistId" assumption. Add `checklistItem`. Add a checklist-id guard. |
| `tests/integration/checklist-embedding.test.ts` *(create)* | Every checklist mutation enqueues the right ids; tombstones actually remove rows. |
| `lib/embedding/live-source.ts` *(create)* | `LIVE_SOURCE_SQL` (the shared predicate) + `sweepOrphanEmbeddings()`. |
| `lib/ask/retrieve.ts` *(modify)* | Inner ANN scan unchanged, outer liveness filter, 2× over-fetch. |
| `lib/embedding/index.ts` *(modify)* | Export `currentContentHash()`. |
| `worker/jobs/embed-backfill.ts` *(modify)* | Sweep (ungated) → missing → stale. |
| `worker/index.ts` *(modify)* | Schedule `embed.backfill` nightly at 03:30 UTC on the existing queue. |
| `tests/integration/embedding-liveness.test.ts` *(create)* | Retrieval excludes dead sources. Sweep removes cascade orphans. Stale scan re-enqueues. |
| `lib/attachments/actions.ts` *(modify)* | `deleteAttachment` enqueues an `ATTACHMENT` tombstone. |
| `lib/notes/actions.ts`, `lib/warranties/actions.ts`, `lib/service-records/actions.ts` *(modify)* | Delete enqueues tombstones (or re-embeds, for PR C's detached email attachments) for the attachments the delete removes or unlinks. |
| `lib/attachments/actions.ts` *(modify, PR C's unlink branch)* | The email-owned "delete" that only unlinks also enqueues an `ATTACHMENT` re-embed. |
| `lib/incoming-email/create-service-record.ts` *(modify)* | The link helper returns the ids it re-parented (`updateManyAndReturn`). |
| `lib/incoming-email/actions.ts`, `worker/jobs/classify-incoming-email.ts` *(modify)* | Both callers enqueue `ATTACHMENT` re-embeds for those ids after commit. |
| `tests/integration/embedding-delete-cleanup.test.ts` *(create)* | Delete actions leave no embeddings behind once their jobs run. Link and unlink hand-offs re-embed with the right parent line. |
| `CLAUDE.md` *(modify)* | Recovery-path paragraph, ticks line, queue-policy note. |

The predicate gets its own module because it has two consumers with opposite actions: retrieval *keeps* rows where it is true, and the sweep *deletes* rows where it is false. A second copy would drift, and a drifted sweep deletes live data.

---

### Task 0: Branch and preconditions

**Files:** none

- [ ] **Step 1: Check whether PRs A and C have merged**

```bash
gh pr list --state merged --limit 20 --json number,title,mergedAt
```

If both are merged, start from fresh `main`. If not, Tasks 1-5 can proceed. **Task 6 must wait until PR C is on `main`**, because it edits PR C's code; see its Step 0. Task 9 rebases again before the PR.

- [ ] **Step 2: Create the branch in the main checkout**

Git worktrees are broken in this repo: knip hangs, and there is no `.env`.

```bash
git checkout main && git pull --ff-only && git checkout -b fix/embedding-pipeline
docker compose up -d db meilisearch
```

---

### Task 1: Voyage transport failures are retryable and bounded (P-H2, P-M6 timeout)

**Files:**
- Modify: `lib/embedding/voyage.ts:16-25` (class), `:43-53` (constants), `:111-159` (`postBatch`)
- Modify: `lib/embedding/voyage.test.ts` (append cases)
- Test: `worker/jobs/embed-content.test.ts` (create)

- [ ] **Step 1: Write the failing handler-contract test**

Create `worker/jobs/embed-content.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoyageRetryableError } from '@/lib/embedding/voyage';
import { handleEmbedContent } from './embed-content';

vi.mock('@/lib/env', () => ({
  getEnv: () => ({ ASK_ENABLED: true, VOYAGE_API_KEY: 'voyage-test-key' }),
}));

// Stand-in for embedEntity that reaches Voyage the way the real one does, so the
// error the handler sees comes from the REAL embedTexts classification. Mocking
// embedEntity to throw a hand-picked error class would only test the mock.
vi.mock('@/lib/embedding', async () => {
  const { embedTexts } = await import('@/lib/embedding/voyage');
  return {
    embedEntity: async () => {
      await embedTexts(['canonical text']);
      return { status: 'embedded', chunkCount: 1 };
    },
  };
});

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const JOBS = [{ data: { entityType: 'NOTE' as const, entityId: 'note-1' } }];

describe('handleEmbedContent error contract', () => {
  // Before 2026-09 undici's TypeError escaped embedTexts unclassified, the
  // handler swallowed it as permanent, pg-boss marked the job complete, and the
  // embedding stayed stale forever (P-H2).
  it('rethrows a fetch network failure so pg-boss retries it', async () => {
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed', { cause }));
    await expect(handleEmbedContent(JOBS)).rejects.toBeInstanceOf(VoyageRetryableError);
  });

  it('rethrows a request timeout so pg-boss retries it', async () => {
    fetchMock.mockRejectedValueOnce(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    );
    await expect(handleEmbedContent(JOBS)).rejects.toBeInstanceOf(VoyageRetryableError);
  });

  it('swallows a permanent 4xx so a guaranteed failure does not loop', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad request', { status: 400 }));
    await expect(handleEmbedContent(JOBS)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Append the failing classification cases to `lib/embedding/voyage.test.ts`**

Insert these `it` blocks inside `describe('embedTexts', …)`, just before the `it('exports the expected constants', …)` case:

```ts
  it('classifies a fetch network failure (TypeError) as retryable and keeps the cause', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.voyageai.com'), {
      code: 'ENOTFOUND',
    });
    const netErr = new TypeError('fetch failed', { cause });
    fetchMock.mockRejectedValueOnce(netErr);

    const err = await embedTexts(['hello']).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VoyageRetryableError);
    expect((err as VoyageRetryableError).cause).toBe(netErr);
    // Not retried inline: pg-boss owns the backoff, and a chat turn fails fast.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies a request timeout as retryable', async () => {
    fetchMock.mockRejectedValueOnce(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    );
    await expect(embedTexts(['hello'])).rejects.toBeInstanceOf(VoyageRetryableError);
  });

  // Covers both a body cut off mid-stream and a complete-but-malformed 200
  // (res.json() throws SyntaxError either way). Treating a malformed 200 as
  // retryable is deliberate: it is an upstream glitch, and retries are bounded.
  it('classifies a 200 whose body is malformed or dies mid-read as retryable', async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve(new Response('{"data": [', { status: 200 })),
    );
    await expect(embedTexts(['hello'])).rejects.toBeInstanceOf(VoyageRetryableError);
  });

  it('bounds every request with an abort signal', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse([[0.1]]));
    await embedTexts(['hello']);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
```

- [ ] **Step 3: Run both files and confirm they fail**

```bash
pnpm exec vitest run worker/jobs/embed-content.test.ts lib/embedding/voyage.test.ts
```

Expected failures:
- the embed-content network and timeout cases: `promise resolved "undefined" instead of rejecting`.
- the voyage TypeError case: `expected TypeError … to be an instance of VoyageRetryableError`.
- the voyage timeout case: `expected DOMException …` (same shape).
- the malformed/mid-read body case: `SyntaxError`.
- the signal case: `expected undefined to be an instance of AbortSignal`.

The 4xx case and the existing cases pass.

- [ ] **Step 4: Implement in `lib/embedding/voyage.ts`**

Replace the class at lines 16-25:

```ts
/** Thrown for transient errors (5xx, 429, network, timeout) — caller can retry. */
export class VoyageRetryableError extends Error {
  constructor(
    message: string,
    public status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'VoyageRetryableError';
  }
}
```

After `const MAX_RETRY_SLEEP_MS = 60_000;` (line 49), add:

```ts
// Per-attempt ceiling on one HTTP request, body read included (the signal stays
// attached to the response stream). Voyage answers a 128-input batch in a few
// seconds; 30s means "the connection is wedged", not "the model is slow".
// Without it a half-open socket parks an embed job until pg-boss's 15-minute
// expiry, and parks a chat turn with no bound at all, since chat calls this
// inside the request.
const REQUEST_TIMEOUT_MS = 30_000;
```

After `retryAfterMs` (ends line 68), add:

```ts
/**
 * A request that produced no usable response: undici's `TypeError('fetch
 * failed')` (DNS, refused, reset; the errno is on `.cause.code`), our own
 * timeout (a `DOMException` named `TimeoutError`), a body that died mid-read,
 * or a 200 whose body is complete but not valid JSON (`SyntaxError` from
 * `res.json()`). All are treated as transient. The last one is deliberate: a
 * malformed 200 is an upstream glitch, and pg-boss bounds the retries. These used to escape as a bare TypeError, which
 * embed-content treats as permanent, so the job completed and the embedding
 * stayed stale (P-H2). Not retried inline: pg-boss owns the worker's backoff
 * (lib/queue.ts), and a chat turn should fail fast rather than stall.
 */
function transportFailure(err: unknown, attempt: number): VoyageRetryableError {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  log.warn({ err, attempt }, 'voyage: transport failure');
  return new VoyageRetryableError(`Voyage request failed: ${detail}`, undefined, { cause: err });
}
```

In `postBatch`, replace the `fetch` call and the `res.ok` branch (lines 118-133) with:

```ts
    const res = await fetch(VOYAGE_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        input: batch,
        model: VOYAGE_MODEL,
        input_type: inputType,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch((err: unknown): never => {
      throw transportFailure(err, attempt);
    });

    if (res.ok) {
      return (await res.json().catch((err: unknown): never => {
        throw transportFailure(err, attempt);
      })) as VoyageResponse;
    }
```

Leave everything after it (`const body = await res.text()…`, the 429 loop, the 5xx and fatal branches) unchanged. Update `embedTexts`'s doc comment: "Throws {@link VoyageRetryableError} on 429/5xx/network/timeout".

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
pnpm exec vitest run worker/jobs/embed-content.test.ts lib/embedding/voyage.test.ts
pnpm typecheck
```

Expected: all green. The existing 429/500/400 cases still pass.

- [ ] **Step 6: Commit**

```bash
git add lib/embedding/voyage.ts lib/embedding/voyage.test.ts worker/jobs/embed-content.test.ts
git commit -m "fix(embedding): classify Voyage transport failures as retryable and bound each request"
git log --oneline -1
```

---

### Task 2: An explicit pg-boss retry policy for the embed queues (A-M2)

**Files:**
- Modify: `lib/queue.ts:2` (import), `:27-47` (policy + `getBoss` loop)
- Test: `lib/queue.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `lib/queue.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { getBoss, Queue } from './queue';

const boss = vi.hoisted(() => ({
  on: vi.fn(),
  start: vi.fn(async () => {}),
  createQueue: vi.fn<(name: string, options?: object) => Promise<void>>(async () => {}),
  updateQueue: vi.fn<(name: string, options?: object) => Promise<void>>(async () => {}),
}));

vi.mock('pg-boss', () => ({
  PgBoss: class {
    on = boss.on;
    start = boss.start;
    createQueue = boss.createQueue;
    updateQueue = boss.updateQueue;
  },
}));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ DATABASE_URL: 'postgresql://x/y' }) }));

function optionsFor(fn: typeof boss.createQueue, name: string): object | undefined {
  return fn.mock.calls.find(([n]) => n === name)?.[1];
}

describe('getBoss queue policy', () => {
  it('creates every queue', async () => {
    await getBoss();
    expect(boss.createQueue.mock.calls.map(([n]) => n).sort()).toEqual(
      Object.values(Queue).sort(),
    );
  });

  it('gives embed.content a backoff policy on create AND on update', async () => {
    await getBoss();
    const policy = {
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 900,
      expireInSeconds: 1800,
    };
    expect(optionsFor(boss.createQueue, Queue.EmbedContent)).toEqual(policy);
    // createQueue is INSERT … ON CONFLICT DO NOTHING. On a database where the
    // queue already exists (every deployment) only updateQueue changes anything.
    expect(optionsFor(boss.updateQueue, Queue.EmbedContent)).toEqual(policy);
  });

  it('gives embed.backfill a delayed retry', async () => {
    await getBoss();
    expect(optionsFor(boss.updateQueue, Queue.EmbedBackfill)).toEqual({
      retryLimit: 2,
      retryDelay: 60,
    });
  });

  it('leaves unlisted queues on pg-boss defaults', async () => {
    await getBoss();
    expect(optionsFor(boss.createQueue, Queue.Thumbnail)).toBeUndefined();
    expect(boss.updateQueue.mock.calls.map(([n]) => n)).not.toContain(Queue.Thumbnail);
  });
});
```

(`getBoss` memoizes, so the mocks accumulate exactly one boot's worth of calls. Don't reset them between cases.)

- [ ] **Step 2: Run the test and confirm it fails**

```bash
pnpm exec vitest run lib/queue.test.ts
```

Expected: `creates every queue` passes. The two policy cases fail with `expected undefined to deeply equal { retryLimit: 5, … }`.

(All five option names were checked against pg-boss 12.33.2. They are fields of `QueueOptions` (`dist/types.d.ts:417-466`). `createQueue` takes `Omit<Queue, 'name'>`, which extends `QueueOptions`. `updateQueue` takes `UpdateQueueOptions`, which keeps `expireInSeconds` and the three `retry*` fields and redeclares `retryDelayMax` as `number | null`. `plans.updateQueue` writes `expire_seconds`, `retry_limit`, `retry_delay`, `retry_backoff` and `retry_delay_max`. `attorney.validateQueueArgs` requires `expireInSeconds` ≥ 1 and ≤ 24 h, and allows `retryDelayMax` only with `retryBackoff: true`.)

- [ ] **Step 3: Implement in `lib/queue.ts`**

Change line 2 to:

```ts
import { PgBoss, type QueueOptions } from 'pg-boss';
```

After `const QUEUES = Object.values(Queue) as readonly QueueName[];` add:

```ts
// Per-queue retry policy. A queue not listed here runs on pg-boss's defaults:
// 2 retries, 0s delay, no backoff. That is fine for idempotent ticks and useless
// against a rate-limited external API.
const QUEUE_POLICY: Partial<Record<QueueName, QueueOptions>> = {
  // A Voyage outage or a 429 storm outlasts two immediate retries. Backoff runs
  // 5 retries over roughly 15-30 min (30s·2^n with jitter, each gap capped at
  // 15 min). After that the job fails, and the nightly embed.backfill stale
  // scan re-enqueues it.
  //
  // Expiry is sized to one attempt's real worst case, not the 15-min default.
  // embedTexts posts batches of 128 chunks sequentially, and one batch can
  // spend 6 requests × 30s timeout plus 5 inline 429 sleeps × 60s, about 8 min.
  // The largest source is an attachment capped at 256K chars of extracted text
  // (extract-attachment-text.ts), which is about 145 chunks at ~450 net tokens
  // each, so 2 batches and about 16 min. That is already past the default 900s,
  // so an attempt could expire mid-embed and be retried from scratch. 30 min
  // covers two batches plus DB work with margin.
  [Queue.EmbedContent]: {
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 900,
    expireInSeconds: 1800,
  },
  // DB-only work, so a failure is a Postgres blip. Give it a minute, not 0s.
  [Queue.EmbedBackfill]: { retryLimit: 2, retryDelay: 60 },
};
```

Replace `for (const name of QUEUES) await boss.createQueue(name);` with:

```ts
  for (const name of QUEUES) {
    const policy = QUEUE_POLICY[name];
    await boss.createQueue(name, policy);
    // createQueue is `INSERT … ON CONFLICT DO NOTHING` (pg-boss plans.js). On
    // any database where the queue already exists it changes nothing, so a
    // policy passed only there would never reach production. updateQueue
    // applies it and is idempotent. Jobs snapshot the policy at send().
    if (policy) await boss.updateQueue(name, policy);
  }
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
pnpm exec vitest run lib/queue.test.ts tests/unit/lib/queue-worker-parity.test.ts
pnpm typecheck
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add lib/queue.ts lib/queue.test.ts
git commit -m "fix(queue): give embed queues a backoff retry policy and real expiry that reach existing databases"
git log --oneline -1
```

---

### Task 3: Checklist embeds are keyed by ChecklistItem.id (Q-H1)

**Files:**
- Modify: `lib/checklists/actions.ts:16-178`
- Modify: `lib/ai/suggest/checklist.ts:229-286`
- Modify: `lib/rename-cascade.ts:59-60` (comment only)
- Modify: `tests/unit/lib/embed-drift.test.ts:13-23` and add one case
- Test: `tests/integration/checklist-embedding.test.ts` (create)

- [ ] **Step 1: Fix the drift test's assumption and add a guard (fails first)**

In `tests/unit/lib/embed-drift.test.ts`, replace lines 13-23 with:

```ts
// Prisma model name → EmbeddingEntityType string used in enqueueEmbed calls.
// Note: vendor + reminder + (system) are intentionally absent — not embedded.
// CHECKLIST_ITEM is keyed by ChecklistItem.id, one embedding set per row. A
// checklist write still maps to it (a rename changes every item's text, and a
// delete cascades the items away), but the id passed must be the item's.
const KIND_BY_MODEL: Record<string, string> = {
  item: 'ITEM',
  note: 'NOTE',
  serviceRecord: 'SERVICE_RECORD',
  warranty: 'WARRANTY',
  checklist: 'CHECKLIST_ITEM',
  checklistItem: 'CHECKLIST_ITEM',
  attachment: 'ATTACHMENT',
};
```

Add this case inside `describe('embed drift guard', …)`, after the first `it`:

```ts
  it('CHECKLIST_ITEM is enqueued with a ChecklistItem id, never a checklist id', () => {
    // The loader looks up a ChecklistItem by this id. A checklist id finds
    // nothing, so the job tombstones zero rows and reports success. Every
    // checklist enqueue was a silent no-op until 2026-09 (Q-H1). This catches
    // the shape that bug took; tests/integration/checklist-embedding.test.ts
    // covers the rest.
    const pattern = /enqueueEmbed\(\s*['"`]CHECKLIST_ITEM['"`]\s*,\s*[\w.]*checklistId\b/;
    const offenders = files
      .filter((f) => pattern.test(readFileSync(f, 'utf8')))
      .map((f) => relative(repoRoot, f));
    expect(offenders).toEqual([]);
  });
```

- [ ] **Step 2: Write the failing integration test**

Create `tests/integration/checklist-embedding.test.ts`:

```ts
import type { EmbeddingEntityType } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'u1', name: 'Test' } })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/search/client', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/search/client')>();
  return { ...orig, enqueueSearchIndex: vi.fn(async () => 'job-id') };
});

// Capture what reaches pg-boss. Deliberately NOT mocking @/lib/embedding/enqueue:
// the ASK_ENABLED gate lives inside it (same reasoning as parts-embedding.test.ts).
const enqueued: Array<{ queue: string; data: unknown }> = [];
vi.mock('@/lib/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/queue')>();
  return {
    ...orig,
    getBoss: vi.fn(async () => ({
      send: vi.fn(async (queue: string, data: unknown) => {
        enqueued.push({ queue, data });
        return 'fake-job-id';
      }),
    })),
  };
});

// Never call Voyage. The texts are captured so a test can prove the embedded
// status/name actually changed.
const embeddedTexts: string[][] = [];
vi.mock('@/lib/embedding/voyage', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/embedding/voyage')>();
  return {
    ...orig,
    embedTexts: vi.fn(async (texts: string[]) => {
      embeddedTexts.push(texts);
      return texts.map(() => new Array(1024).fill(0.001));
    }),
  };
});

type EmbedJob = { entityType: EmbeddingEntityType; entityId: string };

function embedJobs(): EmbedJob[] {
  return enqueued.filter((e) => e.queue === 'embed.content').map((e) => e.data as EmbedJob);
}

function checklistItemJobIds(): string[] {
  return embedJobs()
    .filter((j) => j.entityType === 'CHECKLIST_ITEM')
    .map((j) => j.entityId);
}

let ctx: IntegrationContext;
let actions: typeof import('@/lib/checklists/actions');
let suggest: typeof import('@/lib/ai/suggest/checklist');
let embedding: typeof import('@/lib/embedding');

/** Play the captured jobs through the real consumer, as the worker would. */
async function runEmbedJobs(): Promise<void> {
  for (const job of embedJobs()) await embedding.embedEntity(job.entityType, job.entityId);
}

async function embeddingCount(checklistItemId: string): Promise<number> {
  return ctx.prisma.embedding.count({
    where: { entityType: 'CHECKLIST_ITEM', entityId: checklistItemId },
  });
}

async function checklistWith(titles: string[]) {
  const checklist = await ctx.prisma.checklist.create({ data: { name: 'Spring prep' } });
  const items = await Promise.all(
    titles.map((title, position) =>
      ctx.prisma.checklistItem.create({ data: { checklistId: checklist.id, title, position } }),
    ),
  );
  return { checklist, items };
}

beforeAll(async () => {
  ctx = await setupIntegration();
  actions = await import('@/lib/checklists/actions');
  suggest = await import('@/lib/ai/suggest/checklist');
  embedding = await import('@/lib/embedding');
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
  delete process.env.ASK_ENABLED;
});

beforeEach(async () => {
  enqueued.length = 0;
  embeddedTexts.length = 0;
  process.env.ASK_ENABLED = 'true';
  await ctx.prisma.$executeRaw`DELETE FROM embeddings`;
  await ctx.prisma.checklistItem.deleteMany();
  await ctx.prisma.checklist.deleteMany();
  await ctx.prisma.aISuggestionLog.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@x', name: 'Test' } });
});

describe('checklist mutations enqueue CHECKLIST_ITEM by ChecklistItem.id (Q-H1)', () => {
  it('createChecklist enqueues nothing — a new checklist has no items', async () => {
    const r = await actions.createChecklist({ name: 'Empty' });
    expect(r.ok).toBe(true);
    expect(checklistItemJobIds()).toEqual([]);
  });

  it('addChecklistItem enqueues the new item, and the job embeds it', async () => {
    const { checklist } = await checklistWith([]);
    const r = await actions.addChecklistItem({
      checklistId: checklist.id,
      title: 'Flush water heater',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(checklistItemJobIds()).toEqual([r.data.id]);

    await runEmbedJobs();
    expect(await embeddingCount(r.data.id)).toBeGreaterThan(0);
    expect(embeddedTexts.flat().join('\n')).toContain('Item: Flush water heater');
  });

  it('toggleChecklistItem re-enqueues the item — completion status is embedded', async () => {
    const { items } = await checklistWith(['Clean gutters']);
    const [ci] = items;
    if (!ci) throw new Error('fixture');

    const r = await actions.toggleChecklistItem({ id: ci.id, done: true });
    expect(r.ok).toBe(true);
    expect(checklistItemJobIds()).toEqual([ci.id]);

    await runEmbedJobs();
    expect(embeddedTexts.flat().join('\n')).toContain('Status: completed');
  });

  it('resetChecklist re-enqueues exactly the items it un-completed', async () => {
    const { checklist, items } = await checklistWith(['A', 'B', 'C']);
    const done = items.slice(0, 2).map((i) => i.id);
    await ctx.prisma.checklistItem.updateMany({
      where: { id: { in: done } },
      data: { completedAt: new Date() },
    });

    await actions.resetChecklist({ id: checklist.id });
    expect(checklistItemJobIds().sort()).toEqual([...done].sort());
  });

  it('updateChecklist re-enqueues every item — the checklist name is embedded', async () => {
    const { checklist, items } = await checklistWith(['A', 'B']);
    await actions.updateChecklist({ id: checklist.id, name: 'Fall prep' });
    expect(checklistItemJobIds().sort()).toEqual(items.map((i) => i.id).sort());

    await runEmbedJobs();
    expect(embeddedTexts.flat().join('\n')).toContain('Checklist: Fall prep');
  });

  it('reorderChecklistItems enqueues nothing — position is not embedded', async () => {
    const { checklist, items } = await checklistWith(['A', 'B']);
    await actions.reorderChecklistItems({
      checklistId: checklist.id,
      orderedItemIds: items.map((i) => i.id).reverse(),
    });
    expect(checklistItemJobIds()).toEqual([]);
  });

  it('deleteChecklistItem enqueues the deleted id, and the job tombstones it', async () => {
    const { items } = await checklistWith(['Doomed']);
    const [ci] = items;
    if (!ci) throw new Error('fixture');
    await embedding.embedEntity('CHECKLIST_ITEM', ci.id);
    expect(await embeddingCount(ci.id)).toBeGreaterThan(0);
    enqueued.length = 0;

    await actions.deleteChecklistItem({ id: ci.id });
    expect(checklistItemJobIds()).toEqual([ci.id]);

    await runEmbedJobs();
    expect(await embeddingCount(ci.id)).toBe(0);
  });

  it('deleteChecklist enqueues every child captured before the cascade', async () => {
    const { checklist, items } = await checklistWith(['A', 'B']);
    for (const ci of items) await embedding.embedEntity('CHECKLIST_ITEM', ci.id);
    enqueued.length = 0;

    await actions.deleteChecklist(checklist.id);
    expect(checklistItemJobIds().sort()).toEqual(items.map((i) => i.id).sort());

    await runEmbedJobs();
    for (const ci of items) expect(await embeddingCount(ci.id)).toBe(0);
  });

  it('saveAcceptedChecklist enqueues each created item', async () => {
    const log = await ctx.prisma.aISuggestionLog.create({
      data: {
        userId: 'u1',
        kind: 'checklist',
        systemPromptVersion: 'v1',
        model: 'm',
        inventorySnapshotIds: [],
      },
    });
    const r = await suggest.saveAcceptedChecklist({
      logId: log.id,
      name: 'Winterize',
      items: [
        { title: 'Drain hoses', itemId: null, rationale: 'r' },
        { title: 'Cover the AC unit', itemId: null, rationale: 'r' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const created = await ctx.prisma.checklistItem.findMany({
      where: { checklistId: r.data.checklistId },
      select: { id: true },
    });
    expect(checklistItemJobIds().sort()).toEqual(created.map((c) => c.id).sort());
  });
});
```

- [ ] **Step 3: Run both and confirm they fail**

```bash
pnpm exec vitest run tests/unit/lib/embed-drift.test.ts tests/integration/checklist-embedding.test.ts
```

Expected:
- the drift guard fails with `offenders` = `['lib/ai/suggest/checklist.ts', 'lib/checklists/actions.ts']` (order per walk).
- every integration case fails. Create, add, update, reorder and both deletes plus suggest see the checklist id instead of item ids. Toggle and reset see `[]`.

- [ ] **Step 4: Implement in `lib/checklists/actions.ts`**

After `requireUser` (line 20), add:

```ts
// CHECKLIST_ITEM embeddings are keyed by ChecklistItem.id, because the loader
// in lib/embedding/index.ts looks up a *ChecklistItem* by it. A checklist id
// finds nothing, and the job tombstones zero rows and reports success (Q-H1).
// Sequential, not Promise.all: concurrent first calls to getBoss() each start
// their own pg-boss instance (A-M1).
async function enqueueChecklistItemEmbeds(itemIds: string[]): Promise<void> {
  for (const itemId of itemIds) await enqueueEmbed('CHECKLIST_ITEM', itemId);
}

async function itemIdsOf(checklistId: string): Promise<string[]> {
  const rows = await prisma.checklistItem.findMany({
    where: { checklistId },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
```

Then make these per-function changes:

`createChecklist`: delete `await enqueueEmbed('CHECKLIST_ITEM', created.id);` (line 34). A new checklist has no items, so there is nothing to embed until `addChecklistItem`.

`updateChecklist`: replace `await enqueueEmbed('CHECKLIST_ITEM', id);` (line 52) with:

```ts
  // The checklist name is part of every item's embedded text.
  await enqueueChecklistItemEmbeds(await itemIdsOf(id));
```

`deleteChecklist`: replace the body from `await prisma.checklist.delete` through `await enqueueEmbed(...)` (lines 61-63) with:

```ts
  // Capture BEFORE the delete: the FK cascade removes the items, and no cascade
  // reaches the polymorphic embeddings table. Each job then finds its row gone
  // and tombstones it.
  const itemIds = await itemIdsOf(id);
  await prisma.checklist.delete({ where: { id } });
  await enqueueSearchIndex('checklist', id, 'delete');
  await enqueueChecklistItemEmbeds(itemIds);
```

`addChecklistItem`: replace `await enqueueEmbed('CHECKLIST_ITEM', checklistId);` (line 89) with `await enqueueEmbed('CHECKLIST_ITEM', created.id);`.

`deleteChecklistItem`: replace `await enqueueEmbed('CHECKLIST_ITEM', row.checklistId);` (line 102) with:

```ts
  // The job finds the row gone and tombstones its embeddings.
  await enqueueEmbed('CHECKLIST_ITEM', input.id);
```

`toggleChecklistItem`: after the `prisma.checklistItem.update(...)` (line 122), change the comment and add the enqueue:

```ts
  // Don't reindex search — completion status isn't a search field. It IS part
  // of the embedded text ("Status: completed"), so re-embed.
  await enqueueEmbed('CHECKLIST_ITEM', id);
```

`resetChecklist`: replace the `updateMany` call (lines 131-134) with:

```ts
  const reset = await prisma.checklistItem.updateManyAndReturn({
    where: { checklistId: input.id, completedAt: { not: null } },
    data: { completedAt: null },
    select: { id: true },
  });
  // Status is embedded; only the rows this call actually flipped changed.
  await enqueueChecklistItemEmbeds(reset.map((r) => r.id));
```

`reorderChecklistItems`: delete `await enqueueEmbed('CHECKLIST_ITEM', checklistId);` (line 175). Position is not part of the embedded text.

- [ ] **Step 5: Implement in `lib/ai/suggest/checklist.ts`**

Directly above `let checklistId: string;` (line 229), add:

```ts
  const createdItemIds: string[] = [];
```

Replace the item-create loop body (lines 251-260) with:

```ts
      for (let i = 0; i < input.items.length; i++) {
        const row = input.items[i];
        const ci = await tx.checklistItem.create({
          data: {
            checklistId: target.id,
            position: target.nextPosition + i,
            title: row.title,
            itemId: row.itemId,
          },
          select: { id: true },
        });
        createdItemIds.push(ci.id);
      }
```

Replace `await enqueueEmbed('CHECKLIST_ITEM', checklistId);` (line 286) with:

```ts
  // One job per new ChecklistItem, not the checklist id (Q-H1). On the append
  // path the existing items' text is unchanged, so they need nothing.
  for (const itemId of createdItemIds) await enqueueEmbed('CHECKLIST_ITEM', itemId);
```

(Keep `const row = input.items[i];` exactly as it is today. If `row` is typed possibly-undefined, the existing code already handles it the same way.)

- [ ] **Step 6: Update the stale comment in `lib/rename-cascade.ts:59-60`**

Replace:

```
 *   - Not covered yet (smaller surface): Checklist.name → CHECKLIST_ITEM,
 *     ServiceRecord.summary → ATTACHMENT (via serviceRecordId),
```

with:

```
 *   - Not covered yet (smaller surface): ServiceRecord.summary → ATTACHMENT
 *     (via serviceRecordId),
```

Then, after the sentence ending "until the nightly search.reindex rebuilds the index.", add one line: ` *     (Checklist.name → CHECKLIST_ITEM is handled in updateChecklist itself, and the nightly embed.backfill stale scan repairs the embedding half of the rest.)`

- [ ] **Step 7: Run and confirm they pass**

```bash
pnpm exec vitest run tests/unit/lib/embed-drift.test.ts tests/integration/checklist-embedding.test.ts tests/integration/checklists.test.ts tests/integration/ai/save-accepted.test.ts tests/integration/rename-cascade.test.ts
pnpm typecheck
```

Expected: all green. `checklists.test.ts` and `save-accepted.test.ts` run with `ASK_ENABLED` unset, so the enqueues no-op there.

- [ ] **Step 8: Commit**

```bash
git add lib/checklists/actions.ts lib/ai/suggest/checklist.ts lib/rename-cascade.ts tests/unit/lib/embed-drift.test.ts tests/integration/checklist-embedding.test.ts
git commit -m "fix(checklists): enqueue CHECKLIST_ITEM embeds by item id and re-embed on toggle/reset"
git log --oneline -1
```

---

### Task 4: Retrieval never returns a dead source (Q-H2 prompt-path guard)

**Files:**
- Create: `lib/embedding/live-source.ts`
- Modify: `lib/ask/retrieve.ts` (whole file)
- Test: `tests/integration/embedding-liveness.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/integration/embedding-liveness.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { EmbeddingEntityType } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;
let retrieve: typeof import('@/lib/ask/retrieve');
let categoryId: string;

// Every seeded chunk and the query share one direction, so the result does not
// depend on which IVFFlat list a row lands in. The index was built on an empty
// table with 100 lists and is queried at probes=1 (P-H1, deferred), and
// identical vectors land in the query's list whatever the plan.
const VEC = `[${new Array(1024).fill(0.001).join(',')}]`;
const QUERY = new Float32Array(1024).fill(0.001);

async function seedEmbedding(
  entityType: EmbeddingEntityType,
  entityId: string,
  contentHash = 'seeded',
): Promise<void> {
  await ctx.prisma.$executeRaw`
    INSERT INTO embeddings (id, "entityType", "entityId", "chunkIndex", text, embedding, "tokenCount", "contentHash", "createdAt")
    VALUES (${randomUUID()}, ${entityType}::"EmbeddingEntityType", ${entityId}, 0, ${`text for ${entityId}`}, ${VEC}::vector(1024), 1, ${contentHash}, NOW())
  `;
}

async function seedAttachment(parent: { noteId?: string; itemId?: string }, aiIndexable = true) {
  const id = randomUUID();
  return ctx.prisma.attachment.create({
    data: {
      id,
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      storagePath: `${id}/original.pdf`,
      uploadedById: 'u1',
      extractedText: 'Invoice total $450',
      aiIndexable,
      ...parent,
    },
  });
}

beforeAll(async () => {
  ctx = await setupIntegration();
  retrieve = await import('@/lib/ask/retrieve');
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'liveness' },
    create: { slug: 'liveness', name: 'Liveness', sortOrder: 41 },
    update: {},
  });
  categoryId = cat.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.$executeRaw`DELETE FROM embeddings`;
  await ctx.prisma.attachment.deleteMany();
  await ctx.prisma.checklistItem.deleteMany();
  await ctx.prisma.checklist.deleteMany();
  await ctx.prisma.note.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@x', name: 'Test' } });
});

describe('retrieveTopK only returns chunks whose source is live (Q-H2)', () => {
  it('drops deleted, archived and opted-out sources and keeps live ones', async () => {
    const note = await ctx.prisma.note.create({ data: { title: 'Furnace filter', body: '20x25x1' } });
    const archived = await ctx.prisma.item.create({
      data: { name: 'Old fridge', categoryId, archivedAt: new Date() },
    });
    const optedOut = await seedAttachment({ noteId: note.id }, false);
    const checklist = await ctx.prisma.checklist.create({
      data: { name: 'Spring', items: { create: [{ title: 'Gutters', position: 0 }] } },
      include: { items: true },
    });
    const [ci] = checklist.items;
    if (!ci) throw new Error('fixture');

    await seedEmbedding('NOTE', note.id);
    await seedEmbedding('CHECKLIST_ITEM', ci.id);
    await seedEmbedding('NOTE', 'note-that-was-deleted');
    await seedEmbedding('CHECKLIST_ITEM', 'checklist-item-that-was-deleted');
    await seedEmbedding('ITEM', archived.id);
    await seedEmbedding('ATTACHMENT', optedOut.id);

    const chunks = await retrieve.retrieveTopK(QUERY, { k: 10 });
    expect(chunks.map((c) => c.entityId).sort()).toEqual([note.id, ci.id].sort());
  });

  it('a source removed by DB cascade vanishes from retrieval at once, before any sweep', async () => {
    const note = await ctx.prisma.note.create({ data: { title: 'Water heater', body: 'Invoice' } });
    const att = await seedAttachment({ noteId: note.id });
    await seedEmbedding('NOTE', note.id);
    await seedEmbedding('ATTACHMENT', att.id);
    expect(await retrieve.retrieveTopK(QUERY, { k: 10 })).toHaveLength(2);

    await ctx.prisma.note.delete({ where: { id: note.id } }); // cascades the attachment row
    expect(await retrieve.retrieveTopK(QUERY, { k: 10 })).toEqual([]);
    // The rows are still there. Removing them is the sweep's job (Task 5).
    expect(await ctx.prisma.embedding.count()).toBe(2);
  });

  it('still honours k and the entityTypes filter', async () => {
    const notes = await Promise.all(
      ['a', 'b', 'c'].map((t) => ctx.prisma.note.create({ data: { title: t, body: t } })),
    );
    for (const n of notes) await seedEmbedding('NOTE', n.id);

    expect(await retrieve.retrieveTopK(QUERY, { k: 2 })).toHaveLength(2);
    expect(await retrieve.retrieveTopK(QUERY, { k: 10, entityTypes: ['ITEM'] })).toEqual([]);
    expect(await retrieve.retrieveTopK(QUERY, { k: 10, entityTypes: ['NOTE'] })).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm exec vitest run tests/integration/embedding-liveness.test.ts
```

Expected: the first case returns 6 ids instead of 2. The second case returns 2 chunks after the delete instead of `[]`. The third case passes, and it stays as a regression guard for the rewrite.

- [ ] **Step 3: Create `lib/embedding/live-source.ts`**

```ts
import { type EmbeddingEntityType, Prisma } from '@prisma/client';

/**
 * Is the source of an `embeddings` row still something Ask may answer from?
 *
 * `embeddings` is polymorphic (entityType + entityId, no FK), so no cascade ever
 * reaches it. Deleting a note, a checklist or an attachment's parent leaves its
 * chunks behind, and those chunks used to flow straight into the chat prompt
 * (Q-H2). This predicate is the one definition of "live", shared by retrieval
 * (keep where true) and the embed.backfill orphan sweep (delete where false).
 * It must agree with `buildCanonical` in ./index.ts: the rows that function
 * returns null for are exactly the rows that are not live here.
 *   - ITEM / PART: the row exists and is not archived
 *   - ATTACHMENT: the row exists and aiIndexable (the user's opt-out)
 *   - everything else: the row exists
 *
 * It is a Record over the enum, so adding an EmbeddingEntityType fails typecheck
 * here until it gets a rule. That makes the ELSE unreachable. It is `true` so
 * that, if it ever were reached, the sweep would keep rows rather than delete
 * what it cannot judge.
 *
 * Callers must alias the embeddings row as `e`. ChecklistItem has no @@map, so
 * its table keeps Prisma's quoted PascalCase name.
 */
const SOURCE_IS_LIVE: Record<EmbeddingEntityType, Prisma.Sql> = {
  ITEM: Prisma.sql`EXISTS (SELECT 1 FROM items s WHERE s.id = e."entityId" AND s."archivedAt" IS NULL)`,
  NOTE: Prisma.sql`EXISTS (SELECT 1 FROM notes s WHERE s.id = e."entityId")`,
  SERVICE_RECORD: Prisma.sql`EXISTS (SELECT 1 FROM service_records s WHERE s.id = e."entityId")`,
  CHECKLIST_ITEM: Prisma.sql`EXISTS (SELECT 1 FROM "ChecklistItem" s WHERE s.id = e."entityId")`,
  WARRANTY: Prisma.sql`EXISTS (SELECT 1 FROM warranties s WHERE s.id = e."entityId")`,
  ATTACHMENT: Prisma.sql`EXISTS (SELECT 1 FROM attachments s WHERE s.id = e."entityId" AND s."aiIndexable" = true)`,
  PART: Prisma.sql`EXISTS (SELECT 1 FROM parts s WHERE s.id = e."entityId" AND s."archivedAt" IS NULL)`,
};

export const LIVE_SOURCE_SQL: Prisma.Sql = Prisma.sql`(CASE e."entityType" ${Prisma.join(
  (Object.keys(SOURCE_IS_LIVE) as EmbeddingEntityType[]).map(
    (type) => Prisma.sql`WHEN ${type}::"EmbeddingEntityType" THEN ${SOURCE_IS_LIVE[type]}`,
  ),
  ' ',
)} ELSE true END)`;
```

- [ ] **Step 4: Rewrite `lib/ask/retrieve.ts`**

Replace the whole file with:

```ts
import { type EmbeddingEntityType, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { LIVE_SOURCE_SQL } from '@/lib/embedding/live-source';

export type RetrievedChunk = {
  embeddingId: string;
  entityType: EmbeddingEntityType;
  entityId: string;
  chunkIndex: number;
  text: string;
  /** Cosine distance: 0 = identical, 2 = opposite. Lower is more relevant. */
  distance: number;
};

export type RetrieveOptions = {
  /** Number of chunks to return (top-k). */
  k: number;
  /** Optional filter on entity types. Defaults to all. */
  entityTypes?: EmbeddingEntityType[];
};

/**
 * Nearest candidates handed from the ANN scan to the liveness filter, per
 * requested chunk. Dead sources are rare once embed.backfill sweeps them, so
 * 2× rarely comes up short. When it does, the result is just shorter than k,
 * never wrong.
 */
const CANDIDATE_MULTIPLIER = 2;

/**
 * Cosine top-k retrieval against the `embeddings` table, restricted to chunks
 * whose source is live (lib/embedding/live-source.ts).
 *
 * Two layers on purpose. The inner query is the same nearest-neighbour scan as
 * before (pgvector `<=>`, with the optional entityType filter), so the
 * planner's choice for it does not move (the IVFFlat question, P-H1, is
 * deliberately out of scope). The outer query drops chunks whose source row is
 * gone, archived or opted out. It runs one indexed EXISTS per candidate rather
 * than per row in the table. That makes a deleted invoice unreachable from the
 * chat prompt the moment its row goes, not only after the next sweep (Q-H2).
 *
 * The question embedding is passed as a `vector(1024)` literal. Voyage gives a
 * plain number array, which is stringified as `[v1,v2,…]`.
 */
export async function retrieveTopK(
  questionEmbedding: Float32Array,
  opts: RetrieveOptions,
): Promise<RetrievedChunk[]> {
  if (opts.k <= 0) return [];
  const vectorLiteral = `[${Array.from(questionEmbedding).join(',')}]`;
  const typeFilter =
    opts.entityTypes && opts.entityTypes.length > 0
      ? Prisma.sql`WHERE "entityType"::text = ANY(${opts.entityTypes.map((t) => t.toString())}::text[])`
      : Prisma.empty;

  return prisma.$queryRaw<RetrievedChunk[]>`
    SELECT e."embeddingId", e."entityType", e."entityId", e."chunkIndex", e.text, e.distance
    FROM (
      SELECT
        id AS "embeddingId",
        "entityType",
        "entityId",
        "chunkIndex",
        text,
        embedding <=> ${vectorLiteral}::vector(1024) AS distance
      FROM embeddings
      ${typeFilter}
      ORDER BY distance ASC
      LIMIT ${opts.k * CANDIDATE_MULTIPLIER}
    ) e
    WHERE ${LIVE_SOURCE_SQL}
    ORDER BY e.distance ASC
    LIMIT ${opts.k}
  `;
}
```

- [ ] **Step 5: Run and confirm they pass**

```bash
pnpm exec vitest run tests/integration/embedding-liveness.test.ts tests/integration/chat/turn.test.ts
pnpm typecheck
```

Expected: green. `chat/turn.test.ts` mocks `retrieveTopK`, and is run to prove the import graph still resolves.

- [ ] **Step 6: Commit**

```bash
git add lib/embedding/live-source.ts lib/ask/retrieve.ts tests/integration/embedding-liveness.test.ts
git commit -m "fix(ask): never retrieve chunks whose source was deleted, archived or opted out"
git log --oneline -1
```

---

### Task 5: embed.backfill reconciles orphans and stale hashes, nightly (Q-H2, P-H2)

**Files:**
- Modify: `lib/embedding/live-source.ts` (add sweep)
- Modify: `lib/embedding/index.ts:116` (export `currentContentHash`)
- Modify: `worker/jobs/embed-backfill.ts:1-48` (+ new `enqueueStale`)
- Modify: `worker/index.ts:189-195`
- Test: `tests/integration/embedding-liveness.test.ts` (extend)

- [ ] **Step 1: Extend the test file (fails first)**

In `tests/integration/embedding-liveness.test.ts`:

Change the vitest import to `import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';`.

Below the imports, add:

```ts
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ ASK_ENABLED: process.env.ASK_ENABLED === 'true' }),
}));

// Capture what reaches pg-boss (the backfill's only side channel).
const enqueued: Array<{ queue: string; data: unknown }> = [];
vi.mock('@/lib/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/queue')>();
  return {
    ...orig,
    getBoss: vi.fn(async () => ({
      send: vi.fn(async (queue: string, data: unknown) => {
        enqueued.push({ queue, data });
        return 'fake-job-id';
      }),
    })),
  };
});

type EmbedJob = { entityType: EmbeddingEntityType; entityId: string };

function embedJobs(): EmbedJob[] {
  return enqueued.filter((e) => e.queue === 'embed.content').map((e) => e.data as EmbedJob);
}
```

Next to `let retrieve …`, add:

```ts
let backfill: typeof import('@/worker/jobs/embed-backfill');
let embedding: typeof import('@/lib/embedding');
```

In `beforeAll`, after `retrieve = await import(...)`:

```ts
  backfill = await import('@/worker/jobs/embed-backfill');
  embedding = await import('@/lib/embedding');
```

In `afterAll`, add `delete process.env.ASK_ENABLED;`. At the top of `beforeEach`, add `enqueued.length = 0;` and `process.env.ASK_ENABLED = 'true';`.

Append:

```ts
describe('embed.backfill reconciles the embeddings table', () => {
  it('sweeps embeddings of sources removed by DB cascade, even with Ask off', async () => {
    process.env.ASK_ENABLED = 'false';
    const keep = await ctx.prisma.note.create({ data: { title: 'Keep', body: 'k' } });
    const doomed = await ctx.prisma.note.create({ data: { title: 'Doomed', body: 'd' } });
    const att = await seedAttachment({ noteId: doomed.id });
    const checklist = await ctx.prisma.checklist.create({
      data: { name: 'Spring', items: { create: [{ title: 'Gutters', position: 0 }] } },
      include: { items: true },
    });
    const [ci] = checklist.items;
    if (!ci) throw new Error('fixture');
    await seedEmbedding('NOTE', keep.id);
    await seedEmbedding('ATTACHMENT', att.id);
    await seedEmbedding('CHECKLIST_ITEM', ci.id);

    // Both removals are FK-level cascades. No app code sees these rows go.
    await ctx.prisma.note.delete({ where: { id: doomed.id } });
    await ctx.prisma.checklist.delete({ where: { id: checklist.id } });

    await backfill.handleEmbedBackfill();

    const left = await ctx.prisma.embedding.findMany({
      select: { entityType: true, entityId: true },
    });
    expect(left).toEqual([{ entityType: 'NOTE', entityId: keep.id }]);
    expect(embedJobs()).toEqual([]); // Ask off: the sweep ran, nothing was enqueued
  });

  it('re-enqueues an entity whose stored hash no longer matches its text (P-H2)', async () => {
    const stale = await ctx.prisma.note.create({ data: { title: 'Edited', body: 'new body' } });
    const fresh = await ctx.prisma.note.create({ data: { title: 'Untouched', body: 'same' } });
    await seedEmbedding('NOTE', stale.id, 'hash-of-the-text-before-a-failed-re-embed');
    const freshHash = await embedding.currentContentHash('NOTE', fresh.id);
    if (!freshHash) throw new Error('fixture');
    await seedEmbedding('NOTE', fresh.id, freshHash);

    await backfill.handleEmbedBackfill();

    const noteJobs = embedJobs()
      .filter((j) => j.entityType === 'NOTE')
      .map((j) => j.entityId);
    expect(noteJobs).toContain(stale.id);
    expect(noteJobs).not.toContain(fresh.id);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm exec vitest run tests/integration/embedding-liveness.test.ts
```

Expected: the sweep case leaves 3 rows, because the handler returns early with Ask off and nothing sweeps. The stale case fails with `embedding.currentContentHash is not a function`. The Task 4 cases still pass.

- [ ] **Step 3: Add the sweep to `lib/embedding/live-source.ts`**

Add the import `import { prisma } from '@/lib/db';` (Biome sorts it below `@prisma/client`), and append:

```ts
/**
 * Delete every embedding whose source is not live (see LIVE_SOURCE_SQL). This
 * is the reconciliation backstop for Q-H2. The tombstones enqueued at delete
 * sites are best-effort, and this is the guarantee. Returns rows removed per
 * entity type (types with none are absent).
 */
export async function sweepOrphanEmbeddings(): Promise<Record<string, number>> {
  const rows = await prisma.$queryRaw<{ entityType: EmbeddingEntityType; count: number }[]>`
    WITH swept AS (
      DELETE FROM embeddings e
      WHERE NOT ${LIVE_SOURCE_SQL}
      RETURNING e."entityType"
    )
    SELECT "entityType", count(*)::int AS count FROM swept GROUP BY "entityType"
  `;
  return Object.fromEntries(rows.map((r) => [r.entityType, r.count]));
}
```

- [ ] **Step 4: Export `currentContentHash` from `lib/embedding/index.ts`**

Insert directly above `function sha256` (line 117):

```ts
/**
 * The hash `embedEntity` would store for this entity right now, or null when it
 * would store nothing (gone, archived, opted out, or blank text). DB reads only,
 * no Voyage call, which is what lets embed.backfill find stale rows cheaply.
 */
export async function currentContentHash(
  entityType: EmbeddingEntityType,
  entityId: string,
): Promise<string | null> {
  const canonical = await buildCanonical(entityType, entityId);
  if (canonical === null || canonical.trim().length === 0) return null;
  return sha256(canonical);
}
```

- [ ] **Step 5: Rework `worker/jobs/embed-backfill.ts`**

Replace the imports (lines 1-4) with:

```ts
import type { EmbeddingEntityType } from '@prisma/client';
import { prisma } from '@/lib/db';
import { currentContentHash } from '@/lib/embedding';
import { sweepOrphanEmbeddings } from '@/lib/embedding/live-source';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { getBoss, Queue } from '@/lib/queue';
```

Replace the doc comment and `handleEmbedBackfill` (lines 14-48) with:

```ts
/**
 * The embedding pipeline's reconciliation pass, and the thing that makes
 * "eventually consistent" true. Three steps, in order:
 *
 *   1. Sweep: delete embeddings whose source is gone, archived or opted out
 *      (lib/embedding/live-source.ts). This runs even with ASK_ENABLED=false.
 *      It calls no API, and deleted content should not sit in the database
 *      either way.
 *   2. Missing: enqueue an embed for every live row that has none.
 *   3. Stale: for every embedded entity, rebuild its canonical text (DB reads
 *      only) and re-enqueue it when the hash differs from the stored one. This
 *      catches an edit whose embed job failed or was never sent, and renames no
 *      cascade reaches. Voyage is only called for the mismatches.
 *
 * Fired at worker boot, nightly at 03:30 UTC, and by the admin Rebuild button.
 * Bounded: at most MAX_ENQUEUE_PER_KIND per entity type for step 2, and the
 * same cap in total for step 3. The next run picks up the rest.
 */
export async function handleEmbedBackfill(): Promise<void> {
  const swept = await sweepOrphanEmbeddings();
  if (Object.keys(swept).length > 0) {
    log.info({ swept }, 'embed-backfill: swept embeddings of deleted sources');
  }

  const { ASK_ENABLED } = getEnv();
  if (!ASK_ENABLED) {
    log.debug('embed-backfill: ASK_ENABLED=false, skipping the embed passes');
    return;
  }

  const boss = await getBoss();
  const counts = await Promise.all([
    enqueueMissing('ITEM', () => itemIdsMissingEmbeddings(), boss),
    enqueueMissing('NOTE', () => noteIdsMissingEmbeddings(), boss),
    enqueueMissing('SERVICE_RECORD', () => serviceRecordIdsMissingEmbeddings(), boss),
    enqueueMissing('CHECKLIST_ITEM', () => checklistItemIdsMissingEmbeddings(), boss),
    enqueueMissing('WARRANTY', () => warrantyIdsMissingEmbeddings(), boss),
    enqueueMissing('ATTACHMENT', () => attachmentIdsMissingEmbeddings(), boss),
    enqueueMissing('PART', () => partIdsMissingEmbeddings(), boss),
  ]);
  const stale = await enqueueStale(boss);

  const total = counts.reduce((s, c) => s + c, 0);
  log.info({ total, perKind: counts, stale }, 'embed-backfill: complete');
}

async function enqueueStale(boss: Awaited<ReturnType<typeof getBoss>>): Promise<number> {
  // One row per embedded entity. Every chunk of an entity carries the same hash,
  // because embedEntity rewrites all of them in one transaction.
  const rows = await prisma.$queryRaw<
    { entityType: EmbeddingEntityType; entityId: string; contentHash: string }[]
  >`
    SELECT DISTINCT ON ("entityType", "entityId") "entityType", "entityId", "contentHash"
    FROM embeddings
  `;
  let queued = 0;
  for (const row of rows) {
    if (queued >= MAX_ENQUEUE_PER_KIND) break;
    // Sequential on purpose: this is a background pass, and each call is a
    // handful of indexed reads. A null (the source went away since the sweep)
    // also mismatches, and the job then tombstones it.
    const hash = await currentContentHash(row.entityType, row.entityId);
    if (hash === row.contentHash) continue;
    await boss.send(Queue.EmbedContent, { entityType: row.entityType, entityId: row.entityId });
    queued += 1;
  }
  log.info({ scanned: rows.length, queued }, 'embed-backfill: stale scan');
  return queued;
}
```

Leave `enqueueMissing` and the seven `*MissingEmbeddings` queries unchanged.

- [ ] **Step 6: Schedule it nightly in `worker/index.ts`**

Replace lines 189-195 with:

```ts
  // Embedding reconciliation (Plan 4c; sweep + stale scan added 2026-09):
  // deletes embeddings of deleted sources, enqueues missing ones, and
  // re-enqueues any whose text changed since they were stored. Idempotent.
  // Fired nightly, by the admin Rebuild button, and by the startup send below.
  // 03:30, clear of the 03:00 pg-dump + search.reindex pair.
  await boss.schedule(Queue.EmbedBackfill, '30 3 * * *');
  await boss.work(Queue.EmbedBackfill, { batchSize: 1 }, async () => {
    await handleEmbedBackfill();
  });
```

- [ ] **Step 7: Run and confirm they pass**

```bash
pnpm exec vitest run tests/integration/embedding-liveness.test.ts tests/integration/parts-embedding.test.ts tests/unit/lib/queue-worker-parity.test.ts
pnpm typecheck
pnpm lint:worker-graph
```

Expected: green. `lint:worker-graph` passes, because the new worker-reachable file is under `lib/` and imports only `@prisma/client` and `@/lib/db`.

- [ ] **Step 8: Commit**

```bash
git add lib/embedding/live-source.ts lib/embedding/index.ts worker/jobs/embed-backfill.ts worker/index.ts tests/integration/embedding-liveness.test.ts
git commit -m "fix(embedding): sweep orphan embeddings and repair stale hashes in a nightly backfill"
git log --oneline -1
```

---

### Task 6: Eager tombstones and re-embeds at delete and re-parent sites (Q-H2 hygiene)

This layer is **best-effort**. Its enqueues are skipped when `ASK_ENABLED=false` and lost if pg-boss is down. The guarantee is Task 5's sweep and stale scan, and the prompt path is already safe from Task 4. We deliberately do not chase every cascade (for example `IncomingEmail`, which has no delete path, or a future item hard-delete). Using `enqueueEmbed` rather than a synchronous `embedding.deleteMany` means one path handles both outcomes. It tombstones rows that are gone, and it re-embeds rows that survive with a different parent. That second case covers PR C's unlinked email attachments and the inbox → service-record link, whose canonical text names the parent (see Background).

**Files:**
- Modify: `lib/attachments/actions.ts` (`deleteAttachment`: PR C's unlink branch, and after the successful DB delete)
- Modify: `lib/notes/actions.ts:93-111`, `lib/warranties/actions.ts:108-126`, `lib/service-records/actions.ts` (`deleteServiceRecord`, as restructured by PR C)
- Modify: `lib/incoming-email/create-service-record.ts` (`createServiceRecordForEmail` link step + result type)
- Modify: `lib/incoming-email/actions.ts` (`createServiceRecordFromEmail`, after the `enqueueEmbed('SERVICE_RECORD', …)` line), `worker/jobs/classify-incoming-email.ts` (`autoStub`, same spot)
- Modify: `tests/unit/lib/embed-drift.test.ts` (the `create-service-record.ts` / `ATTACHMENT` ALLOWED reason)
- Test: `tests/integration/embedding-delete-cleanup.test.ts` (create)

- [ ] **Step 0: Hard precondition — PR C is on `main`, and the shared functions are re-read**

```bash
gh pr list --state merged --limit 20 --json number,title   # PR C must be listed
git fetch origin && git rebase origin/main
grep -n "detachEmailOwnedAttachments\|incomingEmailId && row.serviceRecordId" lib/attachments/actions.ts lib/service-records/actions.ts lib/incoming-email/create-service-record.ts
```

The grep must show PR C's unlink branch in `deleteAttachment`, `detachEmailOwnedAttachments` in the helper, and its use in `deleteServiceRecord`. If it doesn't, stop, because this task depends on them. Re-read `deleteAttachment`, `deleteServiceRecord` and `createServiceRecordForEmail` in full. The anchors below quote PR C's plan (data-integrity plan, Task 2 Steps 3-5), so adapt them to what actually merged. Every enqueue goes **after** the DB write commits. Neither the file-removal code nor the unlink/detach code is touched.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/embedding-delete-cleanup.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmbeddingEntityType } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calDaysOut,
  type IntegrationContext,
  setupIntegration,
  teardownIntegration,
  todayCal,
} from './helpers';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'u1', name: 'Test' } })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// deleteAttachment reads FILES_DIR. The full Zod env would demand unrelated secrets.
vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    ASK_ENABLED: process.env.ASK_ENABLED === 'true',
    FILES_DIR: process.env.FILES_DIR,
  }),
}));
vi.mock('@/lib/search/client', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/search/client')>();
  return { ...orig, enqueueSearchIndex: vi.fn(async () => 'job-id') };
});

const enqueued: Array<{ queue: string; data: unknown }> = [];
vi.mock('@/lib/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/queue')>();
  return {
    ...orig,
    getBoss: vi.fn(async () => ({
      send: vi.fn(async (queue: string, data: unknown) => {
        enqueued.push({ queue, data });
        return 'fake-job-id';
      }),
    })),
  };
});

// Never call Voyage. The texts are captured so a re-parent test can prove the
// "Linked to <parent>" line actually changed.
const embeddedTexts: string[][] = [];
vi.mock('@/lib/embedding/voyage', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/embedding/voyage')>();
  return {
    ...orig,
    embedTexts: vi.fn(async (texts: string[]) => {
      embeddedTexts.push(texts);
      return texts.map(() => new Array(1024).fill(0.001));
    }),
  };
});

type EmbedJob = { entityType: EmbeddingEntityType; entityId: string };

function embedJobs(): EmbedJob[] {
  return enqueued.filter((e) => e.queue === 'embed.content').map((e) => e.data as EmbedJob);
}

let ctx: IntegrationContext;
let attachments: typeof import('@/lib/attachments/actions');
let notes: typeof import('@/lib/notes/actions');
let warranties: typeof import('@/lib/warranties/actions');
let serviceRecords: typeof import('@/lib/service-records/actions');
let inbox: typeof import('@/lib/incoming-email/actions');
let embedding: typeof import('@/lib/embedding');
let itemId: string;
const originalFilesDir = process.env.FILES_DIR;

/** Play the captured jobs through the real consumer, as the worker would. */
async function runEmbedJobs(): Promise<void> {
  for (const job of embedJobs()) await embedding.embedEntity(job.entityType, job.entityId);
}

async function count(entityType: EmbeddingEntityType, entityId: string): Promise<number> {
  return ctx.prisma.embedding.count({ where: { entityType, entityId } });
}

async function seedAttachment(
  parent: Partial<Record<'noteId' | 'warrantyId' | 'serviceRecordId', string>>,
) {
  const id = randomUUID();
  const att = await ctx.prisma.attachment.create({
    data: {
      id,
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      storagePath: `${id}/original.pdf`,
      uploadedById: 'u1',
      extractedText: 'Invoice #123 — total $450',
      ...parent,
    },
  });
  // A real embedding, written the way the worker writes it.
  await embedding.embedEntity('ATTACHMENT', att.id);
  expect(await count('ATTACHMENT', att.id)).toBeGreaterThan(0);
  return att;
}

/** An inbound-email attachment, optionally already linked to a service record. */
async function seedEmailAttachment(serviceRecordId: string | null = null) {
  const vendor = await ctx.prisma.vendor.create({ data: { name: `Acme ${randomUUID()}` } });
  const email = await ctx.prisma.incomingEmail.create({
    data: {
      messageId: `<${randomUUID()}@example.com>`,
      fromAddress: 'dispatch@acme.example',
      subject: 'Spring HVAC tune-up',
      receivedAt: new Date(),
      headersJson: {},
      vendorId: vendor.id,
      // A calendar date, so createServiceRecordFromEmail never falls back to
      // receivedAt + getHouseTimezone().
      aiExtractedPerformedOn: todayCal(),
      targets: { create: [{ itemId }] },
    },
  });
  const id = randomUUID();
  const att = await ctx.prisma.attachment.create({
    data: {
      id,
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      storagePath: `${id}/original.pdf`,
      uploadedById: 'u1',
      extractedText: 'Invoice #456 — total $180',
      incomingEmailId: email.id,
      serviceRecordId,
    },
  });
  await embedding.embedEntity('ATTACHMENT', att.id);
  return { email, att };
}

/** Run the captured jobs, then return only the text they embedded. */
async function embeddedTextOfJobs(): Promise<string> {
  embeddedTexts.length = 0;
  await runEmbedJobs();
  return embeddedTexts.flat().join('\n');
}

beforeAll(async () => {
  ctx = await setupIntegration();
  process.env.FILES_DIR = await mkdtemp(join(tmpdir(), 'embed-cleanup-'));
  attachments = await import('@/lib/attachments/actions');
  notes = await import('@/lib/notes/actions');
  warranties = await import('@/lib/warranties/actions');
  serviceRecords = await import('@/lib/service-records/actions');
  inbox = await import('@/lib/incoming-email/actions');
  embedding = await import('@/lib/embedding');
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
  process.env.FILES_DIR = originalFilesDir;
  delete process.env.ASK_ENABLED;
});

beforeEach(async () => {
  process.env.ASK_ENABLED = 'true';
  await ctx.prisma.$executeRaw`DELETE FROM embeddings`;
  await ctx.prisma.attachment.deleteMany();
  await ctx.prisma.incomingEmail.deleteMany();
  await ctx.prisma.warranty.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.vendor.deleteMany();
  await ctx.prisma.note.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@x', name: 'Test' } });
  embeddedTexts.length = 0;
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'cleanup' },
    create: { slug: 'cleanup', name: 'Cleanup', sortOrder: 42 },
    update: {},
  });
  itemId = (await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId: cat.id } })).id;
  enqueued.length = 0;
});

describe('delete actions tombstone every embeddable row they remove (Q-H2)', () => {
  it('deleteAttachment enqueues ATTACHMENT, and the job removes its embeddings', async () => {
    const note = await ctx.prisma.note.create({ data: { title: 'Furnace', body: 'b' } });
    const att = await seedAttachment({ noteId: note.id });
    enqueued.length = 0;

    const r = await attachments.deleteAttachment(att.id);
    expect(r.ok).toBe(true);
    expect(embedJobs()).toContainEqual(
      expect.objectContaining({ entityType: 'ATTACHMENT', entityId: att.id }),
    );

    await runEmbedJobs();
    expect(await count('ATTACHMENT', att.id)).toBe(0);
  });

  it('deleteNote also tombstones the attachments its FK cascade removes', async () => {
    const note = await ctx.prisma.note.create({ data: { title: 'Water heater', body: 'b' } });
    await embedding.embedEntity('NOTE', note.id);
    const att = await seedAttachment({ noteId: note.id });
    enqueued.length = 0;

    await notes.deleteNote(note.id);
    expect(embedJobs()).toContainEqual(
      expect.objectContaining({ entityType: 'ATTACHMENT', entityId: att.id }),
    );

    await runEmbedJobs();
    expect(await count('NOTE', note.id)).toBe(0);
    expect(await count('ATTACHMENT', att.id)).toBe(0);
  });

  it('deleteWarranty also tombstones the attachments its FK cascade removes', async () => {
    const w = await ctx.prisma.warranty.create({
      data: {
        provider: 'Acme',
        startsOn: todayCal(),
        endsOn: calDaysOut(365),
        targets: { create: [{ itemId }] },
      },
    });
    const att = await seedAttachment({ warrantyId: w.id });
    enqueued.length = 0;

    await warranties.deleteWarranty(w.id);
    expect(embedJobs()).toContainEqual(
      expect.objectContaining({ entityType: 'ATTACHMENT', entityId: att.id }),
    );

    await runEmbedJobs();
    expect(await count('ATTACHMENT', att.id)).toBe(0);
  });

  it('deleteServiceRecord also re-embeds or tombstones its attachments', async () => {
    const sr = await ctx.prisma.serviceRecord.create({
      data: { summary: 'Tune-up', performedOn: todayCal(), targets: { create: [{ itemId }] } },
    });
    const att = await seedAttachment({ serviceRecordId: sr.id });
    enqueued.length = 0;

    await serviceRecords.deleteServiceRecord(sr.id);
    expect(embedJobs()).toContainEqual(
      expect.objectContaining({ entityType: 'ATTACHMENT', entityId: att.id }),
    );

    await runEmbedJobs();
    // A plain SR attachment cascades away.
    expect(await count('ATTACHMENT', att.id)).toBe(0);
  });
});

// The canonical text names the attachment's parent ("Linked to serviceRecord:
// <summary>"), so a link or unlink changes what should be embedded even though
// extractedText is untouched.
describe('re-parenting an email attachment re-embeds it (handed over from PR C)', () => {
  it('createServiceRecordFromEmail re-embeds the attachments it links', async () => {
    const { email, att } = await seedEmailAttachment();
    enqueued.length = 0;

    const r = await inbox.createServiceRecordFromEmail({ id: email.id });
    expect(r.ok).toBe(true);
    expect(embedJobs()).toContainEqual(
      expect.objectContaining({ entityType: 'ATTACHMENT', entityId: att.id }),
    );

    expect(await embeddedTextOfJobs()).toContain('Linked to serviceRecord: Spring HVAC tune-up');
  });

  it('deleteAttachment on an email-owned attachment unlinks it and re-embeds it', async () => {
    const sr = await ctx.prisma.serviceRecord.create({
      data: { summary: 'Tune-up', performedOn: todayCal(), targets: { create: [{ itemId }] } },
    });
    const { att } = await seedEmailAttachment(sr.id);
    enqueued.length = 0;

    const r = await attachments.deleteAttachment(att.id);
    expect(r.ok).toBe(true);
    // PR C's unlink branch: the row survives, detached from the record.
    expect(
      (await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: att.id } })).serviceRecordId,
    ).toBeNull();
    expect(embedJobs()).toContainEqual(
      expect.objectContaining({ entityType: 'ATTACHMENT', entityId: att.id }),
    );

    const text = await embeddedTextOfJobs();
    expect(text).toContain('Invoice #456');
    expect(text).not.toContain('Linked to serviceRecord');
    expect(await count('ATTACHMENT', att.id)).toBeGreaterThan(0);
  });

  it('deleteServiceRecord re-embeds the email attachments it detaches', async () => {
    const sr = await ctx.prisma.serviceRecord.create({
      data: { summary: 'Tune-up', performedOn: todayCal(), targets: { create: [{ itemId }] } },
    });
    const { att } = await seedEmailAttachment(sr.id);
    enqueued.length = 0;

    await serviceRecords.deleteServiceRecord(sr.id);
    expect(embedJobs()).toContainEqual(
      expect.objectContaining({ entityType: 'ATTACHMENT', entityId: att.id }),
    );

    const text = await embeddedTextOfJobs();
    expect(text).not.toContain('Linked to serviceRecord');
    expect(await count('ATTACHMENT', att.id)).toBeGreaterThan(0);
  });
});
```

If a call path in this file reads an env key the `@/lib/env` mock doesn't provide, add that key to the mock rather than widening it to the full env.

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm exec vitest run tests/integration/embedding-delete-cleanup.test.ts
```

Expected: all seven fail on `toContainEqual(… ATTACHMENT …)`. No `ATTACHMENT` job is enqueued. `deleteNote`, `deleteWarranty`, `deleteServiceRecord` and `createServiceRecordFromEmail` enqueue only their own type, and neither `deleteAttachment` branch enqueues anything. The unlink test's `serviceRecordId` precondition passes, because PR C is on `main`.

- [ ] **Step 3: `deleteAttachment` in `lib/attachments/actions.ts` — both branches**

Add `import { enqueueEmbed } from '@/lib/embedding/enqueue';` to the imports.

**(a) PR C's unlink branch** (`if (row.incomingEmailId && row.serviceRecordId) { … }`). Immediately after its `await enqueueSearchIndex('attachment', id, 'upsert');`, add:

```ts
    // Re-embed: the canonical text names the parent ("Linked to serviceRecord:
    // …"), and it just lost that parent. The nightly stale scan would catch
    // it, but only after up to a day of stale retrieval.
    await enqueueEmbed('ATTACHMENT', id);
```

**(b) The delete path.** Immediately after `await enqueueSearchIndex('attachment', id, 'delete');`, add:

```ts
  // Tombstone its chunks: `embeddings` has no FK to attachments, so the row
  // delete above does not reach them. The job finds the row gone and deletes
  // them. The embed.backfill sweep is the backstop if this enqueue is lost.
  await enqueueEmbed('ATTACHMENT', id);
```

Do not change anything else in the function: not the select, the unlink update, the revalidations, or the file removal.

- [ ] **Step 4: `deleteNote` in `lib/notes/actions.ts`**

Change the `existing` lookup's select from `{ itemId: true }` to:

```ts
    select: { itemId: true, attachments: { select: { id: true } } },
```

After `await enqueueEmbed('NOTE', id);`, add:

```ts
  // The FK cascade removed these attachment rows. Their embeddings need an
  // explicit tombstone, because nothing cascades into `embeddings`.
  for (const a of existing.attachments) await enqueueEmbed('ATTACHMENT', a.id);
```

- [ ] **Step 5: `deleteWarranty` in `lib/warranties/actions.ts`**

Change the select to:

```ts
    select: {
      targets: { select: { itemId: true, systemId: true } },
      attachments: { select: { id: true } },
    },
```

After `await enqueueEmbed('WARRANTY', id);`, add the same loop as Step 4:

```ts
  // The FK cascade removed these attachment rows. Their embeddings need an
  // explicit tombstone, because nothing cascades into `embeddings`.
  for (const a of existing.attachments) await enqueueEmbed('ATTACHMENT', a.id);
```

- [ ] **Step 6: `deleteServiceRecord` in `lib/service-records/actions.ts`**

Add `attachments: { select: { id: true } },` to the `existing` select, which today has `vendorId` and `targets`. That pre-delete read runs *before* PR C's `$transaction(detachEmailOwnedAttachments + delete)`, so it sees every attachment, detached or cascaded. After `await enqueueEmbed('SERVICE_RECORD', id);`, add:

```ts
  // Each attachment either cascaded away (tombstone) or, if email-owned, was
  // detached by detachEmailOwnedAttachments and survives without this parent
  // (re-embed). The same job handles both.
  for (const a of existing.attachments) await enqueueEmbed('ATTACHMENT', a.id);
```

Keep PR C's `detached` loop (search upserts, inbox revalidation) exactly as it is.

- [ ] **Step 7: The inbox → service-record link re-embeds what it re-parents**

In `lib/incoming-email/create-service-record.ts`, add a field to `CreateServiceRecordFromEmailResult`:

```ts
  /**
   * Attachments this call re-parented onto the new record. Their embedded text
   * names the parent, so callers must enqueue an ATTACHMENT re-embed for each
   * after the transaction commits (not inside it, where the job could read the
   * pre-commit row).
   */
  linkedAttachmentIds: string[];
```

In `createServiceRecordForEmail`, replace the link step and the return:

```ts
  const linked = await tx.attachment.updateMany({
    where: { incomingEmailId: input.incomingEmailId, serviceRecordId: null },
    data: { serviceRecordId: sr.id },
  });

  return { serviceRecordId: sr.id, attachmentsLinked: linked.count };
```

with:

```ts
  const linked = await tx.attachment.updateManyAndReturn({
    where: { incomingEmailId: input.incomingEmailId, serviceRecordId: null },
    data: { serviceRecordId: sr.id },
    select: { id: true },
  });

  return {
    serviceRecordId: sr.id,
    attachmentsLinked: linked.length,
    linkedAttachmentIds: linked.map((a) => a.id),
  };
```

Keep PR C's comment above it and its `detachEmailOwnedAttachments` export unchanged.

In **both** callers, directly after `await enqueueEmbed('SERVICE_RECORD', created.serviceRecordId);`, add:

```ts
  // The linked attachments now read "Linked to serviceRecord: …".
  for (const attachmentId of created.linkedAttachmentIds) {
    await enqueueEmbed('ATTACHMENT', attachmentId);
  }
```

The two callers are `createServiceRecordFromEmail` in `lib/incoming-email/actions.ts` and `autoStub` in `worker/jobs/classify-incoming-email.ts`, where the code is indented one level deeper inside the `try`. Both files already import `enqueueEmbed`. Two callers of one helper is exactly the drift shape PR #399 fixed, which is why the ids come *from* the helper rather than being re-queried by each caller.

In `tests/unit/lib/embed-drift.test.ts`, replace the ALLOWED entry for `lib/incoming-email/create-service-record.ts` / `ATTACHMENT`, whose reason is now false, with:

```ts
  {
    file: 'lib/incoming-email/create-service-record.ts',
    kind: 'ATTACHMENT',
    reason:
      'shared transactional link (createServiceRecordForEmail) / unlink ' +
      '(detachEmailOwnedAttachments) of inbox attachments. The embedded text names the ' +
      'parent, so it DOES change — but enqueueing inside the transaction could embed the ' +
      'pre-commit row. Both link callers enqueue ATTACHMENT for linkedAttachmentIds after ' +
      'commit; deleteServiceRecord enqueues every pre-delete attachment (covers detached rows)',
  },
```

The entry stays, rather than the file enqueuing itself, for the same reason as the existing `SERVICE_RECORD` entry beside it: the helper only ever runs inside a caller's transaction.

- [ ] **Step 8: Run and confirm they pass**

```bash
pnpm exec vitest run tests/integration/embedding-delete-cleanup.test.ts tests/integration/notes.test.ts tests/integration/warranties.test.ts tests/integration/service-records.test.ts tests/integration/part-attachments.test.ts tests/integration/incoming-email-actions.test.ts tests/integration/incoming-email-classify-job.test.ts tests/integration/attachment-ownership.test.ts tests/unit/lib/embed-drift.test.ts
pnpm typecheck
pnpm lint:worker-graph
```

Expected: green. `attachment-ownership.test.ts` is PR C's suite and proves the unlink/detach behaviour is untouched. The drift test's `lib/attachments/actions.ts` ALLOWED entry stays valid, because the file still writes `attachment`. The worker graph is unchanged, because `classify-incoming-email.ts` already imports `enqueueEmbed`.

- [ ] **Step 9: Commit**

```bash
git add lib/attachments/actions.ts lib/notes/actions.ts lib/warranties/actions.ts lib/service-records/actions.ts lib/incoming-email/create-service-record.ts lib/incoming-email/actions.ts worker/jobs/classify-incoming-email.ts tests/unit/lib/embed-drift.test.ts tests/integration/embedding-delete-cleanup.test.ts
git commit -m "fix(embedding): tombstone or re-embed attachments when they or their parent are deleted, linked or unlinked"
git log --oneline -1
```

---

### Task 7: CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (the Worker section's ticks line ~130, and the "Search and embeddings are eventually consistent" paragraph ~206-212)

- [ ] **Step 1: Ticks line**

Replace:

```
Ticks: `reminders.tick` and `notify-log.sweep` every 5 min, `digest.tick` every 30 min,
`chore-auto-complete.tick` hourly, `search.reindex` and `pg-dump` daily at 03:00 UTC.
```

with:

```
Ticks: `reminders.tick` and `notify-log.sweep` every 5 min, `digest.tick` every 30 min,
`chore-auto-complete.tick` hourly, `search.reindex` and `pg-dump` daily at 03:00 UTC,
`embed.backfill` daily at 03:30 UTC (and at every boot).

Retry policy is per queue in `QUEUE_POLICY` (`lib/queue.ts`); unlisted queues run on
pg-boss defaults (2 retries, no delay). `createQueue` is `ON CONFLICT DO NOTHING`, so a
policy reaches an existing database only through the `updateQueue` call beside it.
```

- [ ] **Step 2: The recovery-path paragraph**

Replace the paragraph beginning `**Search and embeddings are eventually consistent by design.**` (through `…doesn't burn budget in a loop.`) with:

```
**Search and embeddings are eventually consistent by design.** `enqueueSearchIndex` and
`enqueueEmbed` swallow their errors and log a warning — a failed enqueue must never fail
the user's mutation. Recovery is the nightly `search.reindex` (rebuilds the single `house`
Meili index in place) and `embed.backfill` (every boot, nightly, plus the admin Rebuild
button). The backfill is the embedding pipeline's actual guarantee: it deletes chunks
whose source is gone, archived or opted out; enqueues live rows with none; and re-enqueues
any whose stored `contentHash` no longer matches the canonical text (DB reads only —
Voyage is called just for the mismatches). `embeddings` is polymorphic with no FK, so **no
cascade ever reaches it** — delete actions enqueue tombstones as a courtesy, and retrieval
filters on the same liveness predicate (`lib/embedding/live-source.ts`) so a deleted source
never reaches the chat prompt in between. A new `EmbeddingEntityType` needs a rule there
(typecheck enforces it) and a rung in `buildCanonical`. `CHECKLIST_ITEM` is keyed by
`ChecklistItem.id`, never the checklist's. Embeddings are gated on `ASK_ENABLED` at both
producer and consumer (the orphan sweep is not — it calls no API). Voyage transport
failures and timeouts are `VoyageRetryableError`, rethrown so pg-boss retries with backoff;
`VoyageFatalError` is swallowed so it doesn't burn budget in a loop.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): document the embedding reconciliation pass and queue retry policy"
git log --oneline -1
```

---

### Task 8: Full verification

**Files:** none

- [ ] **Step 1: The local gate**

```bash
pnpm verify
```

Expected: biome, `lint:tokens`, `lint:worker-graph`, `lint:knip`, `tsc` and `test:unit` all green. For knip: `LIVE_SOURCE_SQL`, `sweepOrphanEmbeddings` and `currentContentHash` each have a non-test consumer, and `QUEUE_POLICY` is not exported.

- [ ] **Step 2: Every touched integration file**

```bash
pnpm exec vitest run \
  tests/integration/checklist-embedding.test.ts \
  tests/integration/embedding-liveness.test.ts \
  tests/integration/embedding-delete-cleanup.test.ts \
  tests/integration/parts-embedding.test.ts \
  tests/integration/part-attachments.test.ts \
  tests/integration/checklists.test.ts \
  tests/integration/checklist-index.test.ts \
  tests/integration/ai/save-accepted.test.ts \
  tests/integration/rename-cascade.test.ts \
  tests/integration/notes.test.ts \
  tests/integration/warranties.test.ts \
  tests/integration/service-records.test.ts \
  tests/integration/extract-attachment-text.test.ts \
  tests/integration/incoming-email-actions.test.ts \
  tests/integration/incoming-email-classify-job.test.ts \
  tests/integration/attachment-ownership.test.ts \
  tests/integration/chat/turn.test.ts
```

Expected: all green.

- [ ] **Step 3: Worker boot smoke check**

`embed-backfill` gained imports, so boot the worker once against the dev DB and confirm it registers and runs the startup backfill without `ERR_MODULE_NOT_FOUND`:

```bash
pnpm worker:dev
```

Expected log lines: `embed-backfill enqueued`, then (with `ASK_ENABLED` on) `embed-backfill: stale scan` and `embed-backfill: complete`. Ctrl-C.

- [ ] **Step 4: Optional — the full pre-merge umbrella**

`pnpm test:local` (unit → integration → e2e → coverage floor). Never lower a threshold to pass.

---

### Task 9: PR

**Files:**
- Create: `docs/superpowers/plans/2026-09-24-embedding-pipeline-fixes.md` (copy of this plan)

- [ ] **Step 1: Rebase onto main after PRs A and C have merged**

```bash
gh pr list --state merged --limit 20 --json number,title   # confirm A and C are in
git fetch origin && git rebase origin/main
```

If `lib/attachments/actions.ts` or `lib/service-records/actions.ts` conflict, keep PR C's logic intact and re-apply only this PR's enqueue lines (see Task 6 Step 0). Re-run Task 8 Steps 1-2 after the rebase.

- [ ] **Step 2: Commit the plan into the repo**

```bash
cp .full-review/plans/2026-09-24-embedding-pipeline-fixes.md docs/superpowers/plans/2026-09-24-embedding-pipeline-fixes.md
git add docs/superpowers/plans/2026-09-24-embedding-pipeline-fixes.md
git commit -m "docs(plans): embedding pipeline fixes plan"
git log --oneline -1
```

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin fix/embedding-pipeline
gh pr create --title "fix(embedding): correct checklist ids, purge deleted sources, retry transient Voyage failures" --body "$(cat <<'EOF'
## Summary
- **Q-H1:** CHECKLIST_ITEM embeds are enqueued by `ChecklistItem.id` (they were keyed by the checklist id, so the loader found nothing and tombstoned zero rows); toggle/reset now re-embed.
- **Q-H2:** retrieval filters on a shared liveness predicate, so deleted/archived/opted-out sources never reach the chat prompt; `embed.backfill` sweeps orphan embeddings (at boot, nightly 03:30 UTC, Rebuild); delete actions enqueue tombstones for rows their cascades remove, and the inbox → service-record link/unlink re-embeds the attachments whose parent line changed.
- **P-H2 / A-M2:** Voyage network errors and timeouts are `VoyageRetryableError`; every request has a 30s timeout; `embed.content` retries 5× with backoff and a 30-min expiry sized to a 2-batch worst case, applied through `updateQueue` so it reaches existing databases; the backfill re-enqueues entities whose stored `contentHash` no longer matches their text.

Plan: `docs/superpowers/plans/2026-09-24-embedding-pipeline-fixes.md`. Not in this PR: IVFFlat/probes (P-H1).

## Test plan
- [ ] `pnpm verify`
- [ ] integration: checklist-embedding, embedding-liveness, embedding-delete-cleanup + touched suites
- [ ] worker boots and logs `embed-backfill: complete`
EOF
)"
```

- [ ] **Step 4: Watch the Sourcery review in the background and address it**

Watch **only** the `Sourcery review` check, polling for up to 20 min (run with `run_in_background`):

```bash
PR=$(gh pr view --json number -q .number)
for i in $(seq 1 40); do
  s=$(gh pr checks "$PR" --json name,state -q '.[] | select(.name=="Sourcery review") | .state')
  [ -n "$s" ] && [ "$s" != "PENDING" ] && [ "$s" != "QUEUED" ] && [ "$s" != "IN_PROGRESS" ] && { echo "sourcery: $s"; break; }
  sleep 30
done
```

The check reports pass/skipping even when Sourcery hit its rate limit. Read the actual review:

```bash
gh api "repos/{owner}/{repo}/pulls/$PR/reviews" --jq '.[] | select(.user.login | test("sourcery")) | .body'
gh api "repos/{owner}/{repo}/pulls/$PR/comments" --jq '.[] | select(.user.login | test("sourcery")) | {path, line, body}'
```

Address the substantive comments (superpowers:receiving-code-review), commit, push, and check `HEAD` moved. If Sourcery doesn't show up, go straight to Step 5.

- [ ] **Step 5: Enable auto-merge, then watch CI in the background**

```bash
gh pr merge "$PR" --auto --squash
gh pr checks "$PR" --watch --fail-fast   # run_in_background
```

On a CI failure, fix it, push, and watch again. Once auto-merge fires:

```bash
gh pr view "$PR" --json state -q .state   # expect MERGED
git checkout main && git pull --ff-only && git branch -d fix/embedding-pipeline
```

---

## Not in this PR

- **P-H1 / A-M6: the IVFFlat index built on an empty table and queried at `probes=1`.** Deferred. Task 4 deliberately leaves the inner ANN query's plan unchanged, and the retrieval tests use identical vectors so they don't depend on it.
- **The P-M6 remainder: chat's inline 429 sleeps.** `embedTexts` still sleeps up to 5 × ≤60s on 429 in-request, so a chat turn can stall behind a backfill-drained rate limit. The obvious fix is a smaller 429 budget for `inputType: 'query'`. This PR makes chat strictly no worse (it bounds hung sockets and fails fast on transport errors) but doesn't change the 429 loop.
- **A-M1 / P-M1: the `getBoss()` first-call race.** New code avoids triggering it with sequential enqueues, but the race itself is untouched.
- **`part` is missing from the drift test's `KIND_BY_MODEL`.** Adding it needs ALLOWED entries for regex false positives in `lib/chat/schema.ts` and `lib/chat/resolve.ts`.
- **A persistently failing large attachment hogs the embed worker (known follow-up).** An entity that never succeeds on the Voyage free tier now gets 6 attempts with backoff (`retryLimit: 5`). After those, the stale scan and missing pass re-enqueue it at every boot and every night. Each attempt can hold the single `batchSize: 1` `embed.content` worker for up to about 16 min in inline 429 sleeps (2 batches × about 8 min), delaying every other embed behind it. This is pre-existing (the old policy gave 3 immediate attempts and no nightly re-enqueue) and slightly amplified here. A follow-up could skip entities that failed in the last N runs, or move the 429 wait out of process into pg-boss `startAfter`.
- **One-time re-embed burst after deploy.** The first stale scan re-embeds every row whose text drifted since it was stored, including rows written before canonicalizer changes such as #333 and #335. That is correct and bounded (5000 per run, rate-limited by Voyage's inline 429 handling), but it spends Voyage budget once.
