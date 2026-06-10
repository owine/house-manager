import { prisma } from '@/lib/db';
import { getLogger } from '@/lib/logger';
import { computeNextDueOn } from '@/lib/reminders/recurrence';
import { parseRecurrence } from '@/lib/reminders/schema';
import { SYSTEM_AUTO_COMPLETE_USER_ID } from '@/lib/reminders/system-user';
import { enqueueSearchIndex } from '@/lib/search/client';
import { endOfCalendarDayInTz, startOfDayUtc } from '@/lib/time/tz';

const logger = getLogger('chore-auto-complete-tick');

/**
 * Scan for CHORE-kind reminders with autoComplete=true whose targets have
 * nextDueOn strictly before today (house tz). For each, write a system-
 * attributed ReminderCompletion and advance the target's nextDueOn one cycle.
 *
 * Skipped side-effects (vs. manual completion):
 *  - autoCreateServiceRecord (never fires on auto-complete)
 *  - NotificationLog (chores don't notify regardless)
 */
export async function handleChoreAutoCompleteTick(now: Date = new Date()): Promise<void> {
  const profile = await prisma.houseProfile.findFirst({ select: { timezone: true } });
  const tz = profile?.timezone ?? 'UTC';
  const startToday = startOfDayUtc(now, tz);

  const candidates = await prisma.reminderTarget.findMany({
    where: {
      nextDueOn: { lt: startToday },
      reminder: { kind: 'CHORE', autoComplete: true, active: true },
    },
    include: {
      reminder: { select: { id: true, recurrence: true } },
    },
  });

  if (candidates.length === 0) return;

  const reindexReminderIds = new Set<string>();

  let advancedCount = 0;
  for (const t of candidates) {
    const completedOn = endOfCalendarDayInTz(t.nextDueOn, tz);
    const recurrence = parseRecurrence(t.reminder.recurrence);
    const nextDueOn = computeNextDueOn(recurrence, completedOn);

    const advanced = await prisma.$transaction(async (tx) => {
      // Compare-and-swap: only proceed if nextDueOn is still what we selected.
      // Protects against double-processing if a second worker (or a manual
      // completion racing the tick) advanced the target between findMany and
      // here. updateMany returns count, update would throw on missing row.
      const result = await tx.reminderTarget.updateMany({
        where: { id: t.id, nextDueOn: t.nextDueOn },
        data: { lastCompletedOn: completedOn, nextDueOn },
      });
      if (result.count === 0) return false;
      await tx.reminderCompletion.create({
        data: {
          reminderId: t.reminderId,
          targetId: t.id,
          completedById: SYSTEM_AUTO_COMPLETE_USER_ID,
          completedOn,
          notes: 'Auto-completed',
        },
      });
      return true;
    });

    if (advanced) {
      advancedCount++;
      reindexReminderIds.add(t.reminderId);
    }
  }

  for (const id of reindexReminderIds) {
    await enqueueSearchIndex('reminder', id, 'upsert');
  }

  logger.info({ candidates: candidates.length, advanced: advancedCount }, 'auto-completed chores');
}
