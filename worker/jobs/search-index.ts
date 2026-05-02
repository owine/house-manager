import { searchIndex } from '@/lib/search/client';
import { buildDocument, listChildIdsForItem } from '@/lib/search/document';
import type { SearchKind } from '@/lib/search/schema';

export type SearchIndexJob = {
  kind: SearchKind;
  id: string;
  op: 'upsert' | 'delete';
};

/**
 * Upsert or delete a single document. Returns the Meilisearch task uid
 * so callers (and tests) can wait for indexing to complete.
 */
export async function handleSearchIndex(job: SearchIndexJob): Promise<number> {
  const idx = searchIndex();
  const docId = `${job.kind}-${job.id}`;

  if (job.op === 'delete') {
    if (job.kind === 'item') {
      const children = await listChildIdsForItem(job.id);
      const childDocIds = children.map((c) => `${c.kind}-${c.id}`);
      if (childDocIds.length > 0) {
        await idx.deleteDocuments(childDocIds);
      }
    }
    const task = await idx.deleteDocument(docId);
    return task.taskUid;
  }

  // upsert
  const doc = await buildDocument(job.kind, job.id);
  if (doc === null) {
    const task = await idx.deleteDocument(docId);
    return task.taskUid;
  }

  let lastTaskUid = (await idx.addDocuments([doc])).taskUid;
  if (job.kind === 'item') {
    const children = await listChildIdsForItem(job.id);
    const childDocs = (await Promise.all(children.map((c) => buildDocument(c.kind, c.id)))).filter(
      (d): d is NonNullable<typeof d> => d !== null,
    );
    if (childDocs.length > 0) {
      lastTaskUid = (await idx.addDocuments(childDocs)).taskUid;
    }
  }
  return lastTaskUid;
}
