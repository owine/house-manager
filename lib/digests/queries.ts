import { prisma } from '@/lib/db';
import { tzOffsetMinutes, tzParts } from '@/lib/time/tz';

export type DigestItem = {
  reminderId: string;
  title: string;
  dueOn: Date;
  daysOverdue: number; // 0 if not yet overdue
  targets: Array<{ kind: 'item' | 'system'; id: string; name: string }>;
};

/**
 * Compute the start of "today" in the given IANA timezone, returned as a UTC
 * Date suitable for Prisma comparison. Example: timezone='America/New_York'
 * at 2026-05-20T15:00Z returns 2026-05-20T04:00Z (00:00 EDT).
 */
function startOfTodayInTz(timezone: string, now: Date): Date {
  const { year, month, day } = tzParts(now, timezone);
  const offsetMinutes = tzOffsetMinutes(now, timezone);
  // Midnight wall-clock in tz, expressed as the equivalent UTC instant.
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMinutes * 60_000);
}

function daysBetween(later: Date, earlier: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / (24 * 60 * 60 * 1000));
}

async function findAndProject(
  userId: string,
  where: { lt?: Date; gte?: Date; lte?: Date },
  sort: 'asc' | 'desc',
  now: Date,
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
      daysOverdue: Math.max(0, daysBetween(now, t.nextDueOn)),
      targets: target ? [target] : [],
    };
  });
}

export async function getOverdueForUser(
  userId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<DigestItem[]> {
  const start = startOfTodayInTz(timezone, now);
  return findAndProject(userId, { lt: start }, 'asc', now);
}

export async function getWeeklyForUser(
  userId: string,
  _timezone: string,
  now: Date = new Date(),
): Promise<DigestItem[]> {
  const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  return findAndProject(userId, { gte: now, lte: end }, 'asc', now);
}
