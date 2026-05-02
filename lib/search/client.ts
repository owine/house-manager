import { Meilisearch } from 'meilisearch';
import { getEnv } from '@/lib/env';
import { getBoss, Queue } from '@/lib/queue';
import type { SearchKind } from './schema';

export const SEARCH_INDEX_NAME = 'house';

let _client: Meilisearch | undefined;

export function getMeili(): Meilisearch {
  if (!_client)
    _client = new Meilisearch({ host: getEnv().MEILI_HOST, apiKey: getEnv().MEILI_KEY });
  return _client;
}

/** Lazy handle to the unified index. Cheap — does not perform I/O. */
export function searchIndex() {
  return getMeili().index(SEARCH_INDEX_NAME);
}

/**
 * Fire-and-forget enqueue. Errors are logged but never thrown — Server Actions
 * must remain successful even if the queue is down. Reindex-all is the
 * recovery path for any drift.
 */
export async function enqueueSearchIndex(
  kind: SearchKind,
  id: string,
  op: 'upsert' | 'delete',
): Promise<void> {
  try {
    const boss = await getBoss();
    await boss.send(Queue.SearchIndex, { kind, id, op });
  } catch (e) {
    console.warn('search index enqueue failed (will recover via reindex-all)', {
      kind,
      id,
      op,
      error: (e as Error).message,
    });
  }
}
