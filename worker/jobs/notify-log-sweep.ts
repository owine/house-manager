import { prisma } from '@/lib/db';
import { getLogger } from '@/lib/logger';

const logger = getLogger('worker.notify-log-sweep');
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Deletes NotificationLog rows that have been stuck in 'queued' for >10 min.
 *
 * The notify handler INSERTs a row with status='queued' before sending, then
 * UPDATEs to 'sent' on success. If the worker hard-crashes between the INSERT
 * and the UPDATE, the row stays 'queued' forever and the unique constraint
 * (reminderId, userId, channel, cycle) blocks the next tick from retrying.
 *
 * Tradeoff: in the rare case where the channel send actually succeeded but the
 * status update failed before crash, deleting the row causes a duplicate
 * notification on retry. Acceptable; missing is worse than duplicate.
 */
export async function handleNotifyLogSweep(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const result = await prisma.notificationLog.deleteMany({
    where: {
      status: 'queued',
      sentAt: { lt: cutoff },
    },
  });

  if (result.count > 0) {
    const level: 'info' | 'warn' = result.count > 5 ? 'warn' : 'info';
    logger[level]({ deleted: result.count }, 'swept stale notification logs');
  }

  return { deleted: result.count };
}
