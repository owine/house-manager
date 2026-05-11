'use server';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { getLogger } from '@/lib/logger';
import { getBoss, Queue } from '@/lib/queue';
import type { ActionResult } from '@/lib/result';

const log = getLogger('embedding.admin');

/**
 * Admin-only: kick off a full-corpus embedding backfill. Mirror of
 * search-reindex's Rebuild button — enqueues a one-shot worker job that
 * scans each indexable entity table and enqueues per-entity embed jobs
 * for anything missing or stale. The worker's own startup recovery is
 * the other path that fires this same job.
 */
export async function rebuildAllEmbeddings(): Promise<ActionResult<void>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };
  const role = (session.user as { role?: string }).role;
  if (role !== 'ADMIN') return { ok: false, formError: 'Admin only' };

  try {
    const boss = await getBoss();
    await boss.send(Queue.EmbedBackfill, {});
    log.info({ userId: session.user.id }, 'admin: enqueued embed-backfill');
    revalidatePath('/admin/ai');
    return { ok: true, data: undefined };
  } catch (e) {
    log.error({ err: e }, 'admin: failed to enqueue embed-backfill');
    return { ok: false, formError: 'Could not enqueue rebuild. Check worker connectivity.' };
  }
}
