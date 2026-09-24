import type { EmbeddingEntityType } from '@prisma/client';
import { prisma } from '@/lib/db';
import { currentContentHash } from '@/lib/embedding';
import { sweepOrphanEmbeddings } from '@/lib/embedding/live-source';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { getBoss, Queue } from '@/lib/queue';

const log = getLogger('worker.embed-backfill');

// Hard cap to avoid runaway enqueues on a misconfigured corpus. The Phase
// G admin Rebuild button + worker boot both fire this job; either path
// should be bounded.
const MAX_ENQUEUE_PER_KIND = 5_000;

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

async function enqueueMissing(
  entityType: EmbeddingEntityType,
  fetchIds: () => Promise<string[]>,
  boss: Awaited<ReturnType<typeof getBoss>>,
): Promise<number> {
  const ids = (await fetchIds()).slice(0, MAX_ENQUEUE_PER_KIND);
  if (ids.length === 0) return 0;
  for (const [i, entityId] of ids.entries()) {
    await boss.send(Queue.EmbedContent, { entityType, entityId });
    if ((i + 1) % 100 === 0) {
      log.info({ entityType, queued: i + 1, total: ids.length }, 'embed-backfill: progress');
    }
  }
  log.info({ entityType, count: ids.length }, 'embed-backfill: enqueued');
  return ids.length;
}

// Each per-kind query returns IDs of rows that lack a corresponding row in
// `embeddings`. Using raw SQL with a LEFT JOIN is fastest at scale; Prisma's
// `findMany` with a NOT clause would issue a subquery per row.

async function itemIdsMissingEmbeddings(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT i.id FROM items i
    LEFT JOIN embeddings e
      ON e."entityType" = 'ITEM' AND e."entityId" = i.id
    WHERE e.id IS NULL AND i."archivedAt" IS NULL
  `;
  return rows.map((r) => r.id);
}

async function noteIdsMissingEmbeddings(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT n.id FROM notes n
    LEFT JOIN embeddings e
      ON e."entityType" = 'NOTE' AND e."entityId" = n.id
    WHERE e.id IS NULL
  `;
  return rows.map((r) => r.id);
}

async function serviceRecordIdsMissingEmbeddings(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT s.id FROM service_records s
    LEFT JOIN embeddings e
      ON e."entityType" = 'SERVICE_RECORD' AND e."entityId" = s.id
    WHERE e.id IS NULL
  `;
  return rows.map((r) => r.id);
}

async function checklistItemIdsMissingEmbeddings(): Promise<string[]> {
  // ChecklistItem has no @@map directive in schema.prisma, so the table
  // keeps Prisma's default-cased name.
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT c.id FROM "ChecklistItem" c
    LEFT JOIN embeddings e
      ON e."entityType" = 'CHECKLIST_ITEM' AND e."entityId" = c.id
    WHERE e.id IS NULL
  `;
  return rows.map((r) => r.id);
}

async function warrantyIdsMissingEmbeddings(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT w.id FROM warranties w
    LEFT JOIN embeddings e
      ON e."entityType" = 'WARRANTY' AND e."entityId" = w.id
    WHERE e.id IS NULL
  `;
  return rows.map((r) => r.id);
}

async function attachmentIdsMissingEmbeddings(): Promise<string[]> {
  // Only consider attachments where text has been extracted — embeds for
  // attachments still in the OCR queue would be empty anyway. The
  // extract-attachment-text worker enqueues an embed for each successful
  // extraction, so this query mostly catches old attachments uploaded
  // before Phase D existed.
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT a.id FROM attachments a
    LEFT JOIN embeddings e
      ON e."entityType" = 'ATTACHMENT' AND e."entityId" = a.id
    WHERE e.id IS NULL
      AND a."extractedText" IS NOT NULL
      AND a."aiIndexable" = true
  `;
  return rows.map((r) => r.id);
}

async function partIdsMissingEmbeddings(): Promise<string[]> {
  // Archived parts are tombstoned by buildCanonical, so don't enqueue them.
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM parts p
    LEFT JOIN embeddings e
      ON e."entityType" = 'PART' AND e."entityId" = p.id
    WHERE e.id IS NULL AND p."archivedAt" IS NULL
  `;
  return rows.map((r) => r.id);
}
