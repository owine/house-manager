import { prisma } from '@/lib/db';
import { getLogger } from '@/lib/logger';

export type ClassifyIncomingEmailJob = { id: string };

const log = getLogger('classify-incoming-email');

/**
 * Stub. Phase D replaces the body with the real heuristic classifier and
 * the auto-stub ServiceRecord creation. For now we just confirm the row is
 * reachable from the worker and the queue plumbing is wired up.
 */
export async function handleClassifyIncomingEmail(
  jobs: { data: ClassifyIncomingEmailJob }[],
): Promise<void> {
  for (const { data } of jobs) {
    const row = await prisma.incomingEmail.findUnique({
      where: { id: data.id },
      select: { id: true, subject: true },
    });
    if (!row) {
      log.warn({ id: data.id }, 'classify-incoming-email: row not found');
      continue;
    }
    log.info({ id: row.id, subject: row.subject }, 'classify-incoming-email: stub (no-op)');
  }
}
