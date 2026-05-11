import type { EmbeddingEntityType } from '@prisma/client';
import { getLogger } from '@/lib/logger';
import { getBoss, Queue } from '@/lib/queue';

const log = getLogger('embedding.enqueue');

/**
 * Fire-and-forget enqueue helper for the Ask/RAG indexer. Server Actions
 * call this after a successful write so the worker can re-embed the
 * entity asynchronously. Errors are caught + logged but never thrown:
 * a worker enqueue failure should never break the user's create / update
 * action. The worker's startup backfill (Phase G) catches anything
 * dropped here.
 *
 * `ASK_ENABLED` is read from `process.env` directly (not via `getEnv()`)
 * so the helper is no-op-safe even in environments that haven't fully
 * configured the env schema (e.g. integration tests that only set
 * DATABASE_URL). The worker is the source of truth for whether the job
 * actually runs; this early return just avoids spamming logs in disabled
 * deployments.
 */
function askEnabled(): boolean {
  const v = process.env.ASK_ENABLED;
  return v === 'true' || v === '1';
}

export async function enqueueEmbed(
  entityType: EmbeddingEntityType,
  entityId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (!askEnabled()) return;
  try {
    const boss = await getBoss();
    await boss.send(Queue.EmbedContent, { entityType, entityId, force: opts.force ?? false });
  } catch (err) {
    log.warn({ err, entityType, entityId }, 'embedding.enqueue: failed (non-fatal)');
  }
}
