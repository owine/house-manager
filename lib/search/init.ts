import { getMeili, SEARCH_INDEX_NAME, searchIndex } from './client';
import { INDEX_SETTINGS } from './schema';

/**
 * Idempotently ensure the index exists with our canonical settings.
 * Called once at worker startup. Safe to call repeatedly.
 */
export async function ensureSearchIndex(): Promise<void> {
  const meili = getMeili();
  try {
    await meili.createIndex(SEARCH_INDEX_NAME, { primaryKey: 'id' });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== 'index_already_exists') throw e;
  }
  // The settings type from the meilisearch client is structural and awkward to
  // type against the as-const INDEX_SETTINGS. A single cast keeps the call site
  // readable; the runtime payload is correct.
  // biome-ignore lint/suspicious/noExplicitAny: see comment above
  await searchIndex().updateSettings(INDEX_SETTINGS as any);
}
