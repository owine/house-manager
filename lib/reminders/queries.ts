import { prisma } from '@/lib/db';
import type { ListParams } from '@/lib/url-params';

const TARGETS_INCLUDE = {
  targets: {
    include: {
      item: { select: { id: true, name: true } },
      system: { select: { id: true, name: true } },
    },
  },
} as const;

// Helper: derive a single primary `item` field from a reminder's targets so
// that existing per-item-page rendering (one item-target per reminder after
// backfill) keeps working tactically. Multi-target rendering is introduced
// in a later task.
function withDerived<
  R extends {
    targets: {
      itemId: string | null;
      nextDueOn: Date;
      item: { id: string; name: string } | null;
    }[];
  },
>(
  reminder: R,
): R & {
  item: { id: string; name: string } | null;
  itemId: string | null;
  nextDueOn: Date | null;
} {
  const itemTarget = reminder.targets.find((t) => t.item !== null);
  const earliest = reminder.targets.reduce<Date | null>(
    (acc, t) => (acc === null || t.nextDueOn < acc ? t.nextDueOn : acc),
    null,
  );
  return {
    ...reminder,
    item: itemTarget?.item ?? null,
    itemId: itemTarget?.itemId ?? null,
    nextDueOn: earliest,
  };
}

export async function getReminder(id: string) {
  const row = await prisma.reminder.findUnique({
    where: { id },
    include: {
      ...TARGETS_INCLUDE,
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
  if (!row) return null;
  return withDerived(row);
}

export async function listReminders(params: ListParams) {
  const where = {
    AND: [
      params.filters.itemId?.length
        ? { targets: { some: { itemId: { in: params.filters.itemId } } } }
        : {},
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

  // Prisma can't `orderBy` an aggregate over a related table, and we want
  // each reminder ordered by its earliest target's nextDueOn. We fetch the
  // full filtered set with targets included (already cheap — bounded for a
  // self-hosted single-household app) and sort + paginate in memory.
  // Inactive reminders (no upcoming due date) and any reminders that
  // somehow have no targets sort last.
  const [allRows, total] = await Promise.all([
    prisma.reminder.findMany({ where, include: TARGETS_INCLUDE }),
    prisma.reminder.count({ where }),
  ]);

  const derived = allRows.map(withDerived);
  const FAR_FUTURE = Number.POSITIVE_INFINITY;
  derived.sort((a, b) => {
    const aDue = a.nextDueOn?.getTime() ?? FAR_FUTURE;
    const bDue = b.nextDueOn?.getTime() ?? FAR_FUTURE;
    if (aDue !== bDue) return aDue - bDue;
    // Stable secondary order so reminders with same/no due dates have a
    // predictable ordering across requests.
    return a.title.localeCompare(b.title);
  });

  const start = (params.page - 1) * params.pageSize;
  const reminders = derived.slice(start, start + params.pageSize);
  return { reminders, total };
}

export async function listRemindersForItem(itemId: string) {
  const rows = await prisma.reminder.findMany({
    where: { active: true, targets: { some: { itemId } } },
    include: TARGETS_INCLUDE,
  });
  return rows
    .map(withDerived)
    .sort((a, b) => (a.nextDueOn?.getTime() ?? 0) - (b.nextDueOn?.getTime() ?? 0));
}

/**
 * Reminders targeted at a system, either directly (target.systemId) or
 * indirectly via an item that belongs to the system (target.item.systemId).
 */
export async function getRemindersForSystem(systemId: string) {
  const rows = await prisma.reminder.findMany({
    where: {
      active: true,
      targets: { some: { OR: [{ systemId }, { item: { systemId } }] } },
    },
    include: TARGETS_INCLUDE,
  });
  return rows
    .map(withDerived)
    .sort((a, b) => (a.nextDueOn?.getTime() ?? 0) - (b.nextDueOn?.getTime() ?? 0));
}

export async function listUpcomingReminders(limit = 5) {
  // Multi-target reminders are surfaced once per reminder. We fetch the
  // earliest target rows up to `limit * 2` to compensate for de-dup, then
  // group by reminderId and project the earliest nextDueOn.
  const targets = await prisma.reminderTarget.findMany({
    where: { reminder: { active: true } },
    orderBy: { nextDueOn: 'asc' },
    take: limit * 4,
    include: {
      reminder: {
        select: {
          id: true,
          title: true,
          autoCreateServiceRecord: true,
          active: true,
          targets: {
            select: {
              id: true,
              itemId: true,
              systemId: true,
              item: { select: { id: true, name: true } },
              system: { select: { id: true, name: true } },
            },
          },
        },
      },
      item: { select: { id: true, name: true } },
    },
  });

  const seen = new Set<string>();
  const out: {
    id: string;
    title: string;
    nextDueOn: Date;
    autoCreateServiceRecord: boolean;
    itemId: string | null;
    item: { id: string; name: string } | null;
    targets: {
      id: string;
      itemId: string | null;
      systemId: string | null;
      item: { id: string; name: string } | null;
      system: { id: string; name: string } | null;
    }[];
  }[] = [];
  for (const t of targets) {
    if (seen.has(t.reminderId)) continue;
    seen.add(t.reminderId);
    out.push({
      id: t.reminder.id,
      title: t.reminder.title,
      nextDueOn: t.nextDueOn,
      autoCreateServiceRecord: t.reminder.autoCreateServiceRecord,
      itemId: t.itemId,
      item: t.item,
      targets: t.reminder.targets,
    });
    if (out.length >= limit) break;
  }
  return out;
}
