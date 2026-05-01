import { prisma } from '@/lib/db';
import type { ListParams } from '@/lib/url-params';

const STANDARD_INCLUDE = {
  item: { select: { id: true, name: true } },
};

export async function getReminder(id: string) {
  return prisma.reminder.findUnique({
    where: { id },
    include: {
      ...STANDARD_INCLUDE,
      completions: {
        orderBy: { completedOn: 'desc' },
        take: 20,
        include: {
          completedBy: { select: { id: true, name: true } },
          createdServiceRecord: { select: { id: true, summary: true } },
        },
      },
    },
  });
}

export async function listReminders(params: ListParams) {
  const where = {
    AND: [
      params.filters.itemId?.length ? { itemId: { in: params.filters.itemId } } : {},
      params.filters.active?.length ? { active: params.filters.active[0] === 'true' } : {},
      params.q
        ? {
            OR: [
              { title: { contains: params.q, mode: 'insensitive' as const } },
              { description: { contains: params.q, mode: 'insensitive' as const } },
            ],
          }
        : {},
    ],
  };

  const [reminders, total] = await Promise.all([
    prisma.reminder.findMany({
      where,
      orderBy: { nextDueOn: 'asc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      include: STANDARD_INCLUDE,
    }),
    prisma.reminder.count({ where }),
  ]);

  return { reminders, total };
}

export async function listRemindersForItem(itemId: string) {
  return prisma.reminder.findMany({
    where: { itemId, active: true },
    orderBy: { nextDueOn: 'asc' },
  });
}

export async function listUpcomingReminders(limit = 5) {
  return prisma.reminder.findMany({
    where: { active: true },
    orderBy: { nextDueOn: 'asc' },
    take: limit,
    select: {
      id: true,
      title: true,
      nextDueOn: true,
      autoCreateServiceRecord: true,
      itemId: true,
      item: { select: { id: true, name: true } },
    },
  });
}
