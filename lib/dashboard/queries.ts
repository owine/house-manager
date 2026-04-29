import { prisma } from '@/lib/db';

// NOTE: "item-restored" events are deferred until an event log table exists.
// Plan 3 reminders/notifications work may introduce one; add the 5th event type then.

export type ActivityEvent = {
  kind: 'item-created' | 'service-logged' | 'note-added' | 'item-archived';
  occurredAt: Date;
  label: string;
  href: string;
  icon: string; // emoji
};

export async function recentActivity(limit = 10): Promise<ActivityEvent[]> {
  const [items, services, notes, archived] = await Promise.all([
    prisma.item.findMany({
      where: { archivedAt: null },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, name: true, createdAt: true },
    }),
    prisma.serviceRecord.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        summary: true,
        createdAt: true,
        item: { select: { name: true } },
      },
    }),
    prisma.note.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, title: true, createdAt: true },
    }),
    prisma.item.findMany({
      where: { archivedAt: { not: null } },
      orderBy: { archivedAt: 'desc' },
      take: limit,
      select: { id: true, name: true, archivedAt: true },
    }),
  ]);

  const events: ActivityEvent[] = [
    ...items.map((i) => ({
      kind: 'item-created' as const,
      occurredAt: i.createdAt,
      label: `Added ${i.name}`,
      href: `/items/${i.id}`,
      icon: '📦',
    })),
    ...services.map((s) => ({
      kind: 'service-logged' as const,
      occurredAt: s.createdAt,
      label: s.item
        ? `Logged service for ${s.item.name}: ${s.summary}`
        : `Logged service: ${s.summary}`,
      href: `/service/${s.id}`,
      icon: '🔧',
    })),
    ...notes.map((n) => ({
      kind: 'note-added' as const,
      occurredAt: n.createdAt,
      label: `Note: ${n.title}`,
      href: `/notes/${n.id}`,
      icon: '📝',
    })),
    ...archived.flatMap((i) =>
      i.archivedAt
        ? [
            {
              kind: 'item-archived' as const,
              occurredAt: i.archivedAt,
              label: `Archived ${i.name}`,
              href: `/items/${i.id}`,
              icon: '📥',
            },
          ]
        : [],
    ),
  ];

  return events.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()).slice(0, limit);
}

export type QuickStats = {
  activeItems: number;
  vendors: number;
  serviceThisYear: number;
};

export async function quickStats(): Promise<QuickStats> {
  const startOfYear = new Date(new Date().getFullYear(), 0, 1);
  const [activeItems, vendors, serviceThisYear] = await Promise.all([
    prisma.item.count({ where: { archivedAt: null } }),
    prisma.vendor.count(),
    prisma.serviceRecord.count({ where: { performedOn: { gte: startOfYear } } }),
  ]);
  return { activeItems, vendors, serviceThisYear };
}
