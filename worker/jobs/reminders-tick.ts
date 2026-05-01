import { prisma } from '@/lib/db';
import { readNotificationPrefs } from '@/lib/notifications/prefs';

const DAY_MS = 86_400_000;

export async function handleRemindersTick(deps: {
  enqueue: (job: {
    reminderId: string;
    userId: string;
    channel: 'push' | 'email';
    cycle: string;
  }) => Promise<void>;
}): Promise<{ enqueued: number }> {
  const now = new Date();

  // Cap our look-ahead window to the largest active leadTimeDays (bounded for sanity).
  const aggregateLeadTime = await prisma.reminder.aggregate({
    where: { active: true },
    _max: { leadTimeDays: true },
  });
  const maxLead = Math.min(aggregateLeadTime._max.leadTimeDays ?? 3, 30);

  const dueSoon = await prisma.reminder.findMany({
    where: {
      active: true,
      nextDueOn: { lte: new Date(now.getTime() + maxLead * DAY_MS) },
    },
    select: {
      id: true,
      nextDueOn: true,
      leadTimeDays: true,
      notifyUserIds: true,
    },
  });

  let enqueued = 0;
  for (const r of dueSoon) {
    const cycle = `reminder-${r.id}-${r.nextDueOn.toISOString().slice(0, 10)}`;
    const notifyAt = new Date(r.nextDueOn.getTime() - r.leadTimeDays * DAY_MS);
    if (notifyAt.getTime() > now.getTime()) continue; // not yet within lead window

    for (const uid of r.notifyUserIds) {
      const user = await prisma.user.findUnique({
        where: { id: uid },
        select: { notificationPrefs: true },
      });
      if (!user) continue;
      const prefs = readNotificationPrefs(user.notificationPrefs);
      const channels: ('push' | 'email')[] = [];
      if (prefs.pushEnabled) channels.push('push');
      if (prefs.emailEnabled) channels.push('email');

      for (const channel of channels) {
        const existing = await prisma.notificationLog.findUnique({
          where: {
            reminderId_userId_channel_cycle: { reminderId: r.id, userId: uid, channel, cycle },
          },
        });
        if (existing) continue;
        await deps.enqueue({ reminderId: r.id, userId: uid, channel, cycle });
        enqueued++;
      }
    }
  }
  return { enqueued };
}
