import { prisma } from '@/lib/db';
import { getMeili, SEARCH_INDEX_NAME, searchIndex } from '@/lib/search/client';
import { buildDocument } from '@/lib/search/document';
import { INDEX_SETTINGS, SEARCH_KINDS, type SearchKind } from '@/lib/search/schema';

const BATCH_SIZE = 1000;

/**
 * Drops the index, recreates it, applies settings, then streams every row
 * from Postgres for all kinds. Idempotent. Returns the count processed and
 * the last Meilisearch task UID so callers (and tests) can wait for the
 * full rebuild to land.
 */
export async function handleSearchReindex(): Promise<{
  processed: number;
  lastTaskUid: number | null;
}> {
  const meili = getMeili();
  const idx = searchIndex();
  let lastTaskUid: number | null = null;

  // deleteIndex may 404 if the index was never created; ignore.
  await meili.deleteIndex(SEARCH_INDEX_NAME).catch(() => {});
  lastTaskUid = (await meili.createIndex(SEARCH_INDEX_NAME, { primaryKey: 'id' })).taskUid;
  lastTaskUid = (
    await idx.updateSettings(INDEX_SETTINGS as unknown as Parameters<typeof idx.updateSettings>[0])
  ).taskUid;

  let processed = 0;
  for (const kind of SEARCH_KINDS) {
    const ids = await listAllIds(kind);
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const slice = ids.slice(i, i + BATCH_SIZE);
      const docs = (await Promise.all(slice.map((id) => buildDocument(kind, id)))).filter(
        (d): d is NonNullable<typeof d> => d !== null,
      );
      if (docs.length > 0) {
        lastTaskUid = (await idx.addDocuments(docs)).taskUid;
        processed += docs.length;
      }
    }
  }
  return { processed, lastTaskUid };
}

async function listAllIds(kind: SearchKind): Promise<string[]> {
  switch (kind) {
    case 'item':
      return (await prisma.item.findMany({ select: { id: true } })).map((r) => r.id);
    case 'vendor':
      return (await prisma.vendor.findMany({ select: { id: true } })).map((r) => r.id);
    case 'note':
      return (await prisma.note.findMany({ select: { id: true } })).map((r) => r.id);
    case 'service':
      return (await prisma.serviceRecord.findMany({ select: { id: true } })).map((r) => r.id);
    case 'reminder':
      return (await prisma.reminder.findMany({ select: { id: true } })).map((r) => r.id);
    case 'attachment':
      return (await prisma.attachment.findMany({ select: { id: true } })).map((r) => r.id);
  }
}
