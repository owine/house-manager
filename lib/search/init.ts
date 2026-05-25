import { getMeili, SEARCH_INDEX_NAME, searchIndex } from './client';
import { INDEX_SETTINGS } from './schema';

/**
 * Idempotently ensure the index exists with our canonical settings.
 * Called once at worker startup. Safe to call repeatedly.
 */
export async function ensureSearchIndex(): Promise<void> {
  const meili = getMeili();
  // Probe before creating: Meili's createIndex enqueues an async task, so a
  // try/catch on the client only catches HTTP errors. If the index already
  // exists, the task fails inside Meili's scheduler and logs "Index `house`
  // already exists." We avoid that noise by only enqueuing when needed and
  // awaiting the resulting task.
  let exists = true;
  try {
    await meili.getIndex(SEARCH_INDEX_NAME);
  } catch (e) {
    if ((e as { cause?: { code?: string } }).cause?.code === 'index_not_found') exists = false;
    else throw e;
  }
  if (!exists) {
    const task = await meili.createIndex(SEARCH_INDEX_NAME, { primaryKey: 'id' });
    await meili.tasks.waitForTask(task.taskUid);
  }
  // The settings type from the meilisearch client is structural and awkward to
  // type against the as-const INDEX_SETTINGS. A single cast keeps the call site
  // readable; the runtime payload is correct.
  // biome-ignore lint/suspicious/noExplicitAny: see comment above
  await searchIndex().updateSettings(INDEX_SETTINGS as any);
}
