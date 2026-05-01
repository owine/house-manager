import { Meilisearch } from 'meilisearch';

import { getEnv } from '@/lib/env';

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
