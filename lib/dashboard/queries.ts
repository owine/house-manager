import { prisma } from '@/lib/db';
import { listUpcomingReminders } from '@/lib/reminders/queries';
import { tzParts } from '@/lib/time/tz';

type ActivityTarget = {
  id: string;
  itemId: string | null;
  systemId: string | null;
  item: { id: string; name: string } | null;
  system: { id: string; name: string } | null;
};

export type ActivityEvent = {
  kind:
    | 'item-created'
    | 'service-logged'
    | 'note-added'
    | 'item-archived'
    | 'item-restored'
    | 'attachment-added'
    | 'reminder-completed';
  occurredAt: Date;
  label: string;
  href: string;
  icon: string; // emoji
  /** Optional targets for richer rendering (currently set for service-logged). */
  targets?: ActivityTarget[];
};

export async function recentActivity(limit = 10): Promise<ActivityEvent[]> {
  const [items, services, notes, archived, restored, attachments, completions] = await Promise.all([
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
    prisma.item.findMany({
      where: { restoredAt: { not: null } },
      orderBy: { restoredAt: 'desc' },
      take: limit,
      select: { id: true, name: true, restoredAt: true },
    }),
    prisma.attachment.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        filename: true,
        externalUrl: true,
        displayLabel: true,
        createdAt: true,
        item: { select: { id: true, name: true } },
        warranty: { select: { id: true, provider: true } },
        serviceRecord: { select: { id: true, summary: true } },
        note: { select: { id: true, title: true } },
      },
    }),
    prisma.reminderCompletion.findMany({
      orderBy: { completedOn: 'desc' },
      take: limit,
      select: {
        id: true,
        completedOn: true,
        reminder: {
          select: { id: true, title: true },
        },
      },
    }),
  ]);

  function attachmentLabelText(a: {
    filename: string | null;
    externalUrl: string | null;
    displayLabel: string | null;
  }): { verb: string; name: string; icon: string } {
    if (a.externalUrl) {
      let hostname: string;
      try {
        hostname = new URL(a.externalUrl).hostname;
      } catch {
        hostname = a.externalUrl;
      }
      return { verb: 'Linked', name: a.displayLabel || hostname, icon: '🔗' };
    }
    return { verb: 'Added', name: a.filename ?? '(file)', icon: '📎' };
  }

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
      label: `Logged service: ${s.summary}`,
      href: `/service/${s.id}`,
      icon: '🔧',
      targets: s.targets,
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
    ...restored.flatMap((i) =>
      i.restoredAt
        ? [
            {
              kind: 'item-restored' as const,
              occurredAt: i.restoredAt,
              label: `Restored ${i.name}`,
              href: `/items/${i.id}`,
              icon: '📤',
            },
          ]
        : [],
    ),
    ...attachments.flatMap((a) => {
      if (a.item) {
        const { verb, name, icon } = attachmentLabelText(a);
        return [
          {
            kind: 'attachment-added' as const,
            occurredAt: a.createdAt,
            label: `${verb} ${name} to ${a.item.name}`,
            href: `/items/${a.item.id}?tab=files`,
            icon,
          },
        ];
      }
      if (a.warranty) {
        const { verb, name, icon } = attachmentLabelText(a);
        return [
          {
            kind: 'attachment-added' as const,
            occurredAt: a.createdAt,
            label: `${verb} ${name} to warranty (${a.warranty.provider})`,
            href: `/warranties/${a.warranty.id}`,
            icon,
          },
        ];
      }
      if (a.serviceRecord) {
        const { verb, name, icon } = attachmentLabelText(a);
        return [
          {
            kind: 'attachment-added' as const,
            occurredAt: a.createdAt,
            label: `${verb} ${name} to service: ${a.serviceRecord.summary}`,
            href: `/service/${a.serviceRecord.id}`,
            icon,
          },
        ];
      }
      if (a.note) {
        const { verb, name, icon } = attachmentLabelText(a);
        return [
          {
            kind: 'attachment-added' as const,
            occurredAt: a.createdAt,
            label: `${verb} ${name} to note: ${a.note.title}`,
            href: `/notes/${a.note.id}`,
            icon,
          },
        ];
      }
      return [];
    }),
    ...completions.map((c) => ({
      kind: 'reminder-completed' as const,
      occurredAt: c.completedOn,
      label: `Completed: ${c.reminder.title}`,
      href: `/reminders/${c.reminder.id}`,
      icon: '✅',
    })),
  ];

  return events.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()).slice(0, limit);
}

export type QuickStats = {
  activeItems: number;
  vendors: number;
  serviceThisYear: number;
};

export async function quickStats(tz: string): Promise<QuickStats> {
  // `performedOn` is a calendar date at UTC midnight, so the cutoff must be one
  // too. The old `new Date(new Date().getFullYear(), 0, 1)` used the LOCAL Date
  // ctor and the LOCAL year -- correct only because the containers happen to run
  // UTC. Set TZ on the app container and every Jan-1 service record silently
  // dropped out of the count (or Dec-31 of the prior year silently joined it).
  const { year } = tzParts(new Date(), tz);
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const [activeItems, vendors, serviceThisYear] = await Promise.all([
    prisma.item.count({ where: { archivedAt: null } }),
    prisma.vendor.count(),
    prisma.serviceRecord.count({ where: { performedOn: { gte: startOfYear } } }),
  ]);
  return { activeItems, vendors, serviceThisYear };
}

export async function upcomingReminders(limit = 5) {
  return listUpcomingReminders(limit);
}
