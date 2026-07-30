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

  // Rebuild in place rather than drop+recreate: createIndex/deleteIndex are
  // async Meili tasks, and enqueuing them back-to-back without awaiting the
  // delete races the create against the not-yet-deleted index, producing
  // "Index `house` already exists." in Meili's scheduler log. deleteAllDocuments
  // gives the same end state and leaves settings (which we re-assert below)
  // untouched in between.
  let exists = true;
  try {
    await meili.getIndex(SEARCH_INDEX_NAME);
  } catch (e) {
    if ((e as { cause?: { code?: string } }).cause?.code === 'index_not_found') exists = false;
    else throw e;
  }
  if (exists) {
    lastTaskUid = (await idx.deleteAllDocuments()).taskUid;
  } else {
    const t = await meili.createIndex(SEARCH_INDEX_NAME, { primaryKey: 'id' });
    await meili.tasks.waitForTask(t.taskUid);
    lastTaskUid = t.taskUid;
  }
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
    case 'checklist':
      return (await prisma.checklist.findMany({ select: { id: true } })).map((r) => r.id);
    case 'part':
      // Unfiltered, exactly like `item` above: archived rows stay in the index
      // and the search doc carries no archived flag. Note that a part's
      // archived-ness is *derived* — see LIVE_PART / ARCHIVED_PART in
      // lib/parts/queries.ts — so filtering here would need that predicate
      // rather than a bare `archivedAt: null`, and would diverge from every
      // other kind. If archived rows are ever excluded, do it for all kinds
      // at once and use those two exported predicates for parts.
      return (await prisma.part.findMany({ select: { id: true } })).map((r) => r.id);
  }
}
