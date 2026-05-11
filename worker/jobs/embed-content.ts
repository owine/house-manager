import type { EmbeddingEntityType } from '@prisma/client';
import { embedEntity } from '@/lib/embedding';
import { VoyageRetryableError } from '@/lib/embedding/voyage';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';

const log = getLogger('worker.embed-content');

export type EmbedContentJob = {
  entityType: EmbeddingEntityType;
  entityId: string;
  /** When true, replace even when the content hash is unchanged. */
  force?: boolean;
};

/**
 * Compute embeddings for a single (entityType, entityId). The handler is
 * a thin wrapper around `embedEntity` that:
 *
 *   1. Skips entirely when `ASK_ENABLED=false` so deployments that haven't
 *      opted into Ask never burn Voyage tokens.
 *   2. Re-throws {@link VoyageRetryableError} so pg-boss's retry policy can
 *      back off and try again (network blips, 429, 5xx).
 *   3. Lets fatal errors propagate so they surface in Sentry, but does not
 *      retry — re-trying a fatal Voyage error wastes budget.
 *
 * Called by every entity-actions enqueue point (items, notes, service
 * records, warranties, checklists) and by the Phase G admin Rebuild
 * button + startup backfill.
 */
export async function handleEmbedContent(jobs: { data: EmbedContentJob }[]): Promise<void> {
  const { ASK_ENABLED } = getEnv();
  if (!ASK_ENABLED) {
    log.debug({ count: jobs.length }, 'embed-content: ASK_ENABLED=false, skipping');
    return;
  }

  for (const { data } of jobs) {
    try {
      const result = await embedEntity(data.entityType, data.entityId, {
        force: data.force,
      });
      log.info(
        { entityType: data.entityType, entityId: data.entityId, status: result.status },
        'embed-content: complete',
      );
    } catch (err) {
      log.error(
        { err, entityType: data.entityType, entityId: data.entityId },
        'embed-content: failed',
      );
      // pg-boss retries on throw; only retry the transient class so the
      // permanent Voyage 400 doesn't loop.
      if (err instanceof VoyageRetryableError) throw err;
      // Non-retryable: swallow so the job doesn't infinitely retry. Sentry
      // will pick up the error from the structured log above (Pino + Sentry
      // integration in Plan 5a).
    }
  }
}
