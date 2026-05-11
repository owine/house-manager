import type { EmbeddingEntityType } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { getBoss, Queue } from '@/lib/queue';

const log = getLogger('worker.embed-backfill');

// Hard cap to avoid runaway enqueues on a misconfigured corpus. The Phase
// G admin Rebuild button + worker boot both fire this job; either path
// should be bounded.
const MAX_ENQUEUE_PER_KIND = 5_000;

/**
 * Scan each indexable entity table for rows that have no `Embedding`
 * (or where the table is empty for that entity). Enqueue a per-entity
 * `embed-content` job for every miss. Idempotent — running this on a
 * fresh corpus enqueues everything; running on an already-indexed
 * corpus is essentially a no-op (the embed-content handler skips when
 * the content hash matches).
 *
 * Bounded: at most {@link MAX_ENQUEUE_PER_KIND} rows per entity type.
 * Beyond that the next run picks up the rest. Logs progress every 100
 * enqueues so a long-running backfill is observable.
 *
 * Skips entirely when ASK_ENABLED=false.
 */
export async function handleEmbedBackfill(): Promise<void> {
  const { ASK_ENABLED } = getEnv();
  if (!ASK_ENABLED) {
    log.debug('embed-backfill: ASK_ENABLED=false, skipping');
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
  ]);

  const total = counts.reduce((s, c) => s + c, 0);
  log.info({ total, perKind: counts }, 'embed-backfill: complete');
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
