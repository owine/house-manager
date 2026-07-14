import { prisma } from '@/lib/db';
import { type CalendarDate, startOfDayUtc } from '@/lib/time/tz';

export type DigestItem = {
  reminderId: string;
  title: string;
  dueOn: CalendarDate;
  daysOverdue: number; // 0 if not yet overdue
  targets: Array<{ kind: 'item' | 'system'; id: string; name: string }>;
};

function daysBetween(later: Date, earlier: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / (24 * 60 * 60 * 1000));
}

async function findAndProject(
  userId: string,
  where: { lt?: Date; gte?: Date },
  sort: 'asc' | 'desc',
  now: Date,
  timezone: string,
): Promise<DigestItem[]> {
  const targets = await prisma.reminderTarget.findMany({
    where: {
      nextDueOn: where,
      reminder: { active: true, notifyUserIds: { has: userId } },
    },
    include: {
      reminder: { select: { id: true, title: true } },
      item: { select: { id: true, name: true } },
      system: { select: { id: true, name: true } },
    },
    orderBy: { nextDueOn: sort },
  });
  // `nextDueOn` is a calendar date at UTC midnight, so the day count must be
  // taken against the start of the *house* day -- also UTC midnight. Both
  // operands are then day-aligned and the division is exact. Measuring from the
  // raw instant `now` instead truncated wrong wherever the house offset exceeded
  // the digest hour (Tokyo's 08:00 digest fires at 23:00Z the previous day, so a
  // one-day-overdue item reported "0d overdue").
  const today = startOfDayUtc(now, timezone);
  return targets.map((t) => {
    const target =
      t.item != null
        ? { kind: 'item' as const, id: t.item.id, name: t.item.name }
        : t.system != null
          ? { kind: 'system' as const, id: t.system.id, name: t.system.name }
          : null;
    return {
      reminderId: t.reminder.id,
      title: t.reminder.title,
      dueOn: t.nextDueOn,
      daysOverdue: Math.max(0, daysBetween(today, t.nextDueOn)),
      targets: target ? [target] : [],
    };
  });
}

export async function getOverdueForUser(
  userId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<DigestItem[]> {
  const start = startOfDayUtc(now, timezone);
  return findAndProject(userId, { lt: start }, 'asc', now, timezone);
}

export async function getWeeklyForUser(
  userId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<DigestItem[]> {
  // The window opens at the start of the house day, not at the firing instant.
  // Anchoring it to `now` put today's UTC-midnight due dates in the *past*, so
  // they were dropped here -- and since due-today is correctly not overdue, they
  // landed in neither digest and were never reported at all.
  //
  // Half-open [start, start+7d): exactly 7 calendar days. Closing the far end
  // would make it 8, and consecutive weekly digests would double-report the
  // boundary day.
  const start = startOfDayUtc(now, timezone);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return findAndProject(userId, { gte: start, lt: end }, 'asc', now, timezone);
}
