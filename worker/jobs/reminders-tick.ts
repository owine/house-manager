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
    where: { active: true, kind: 'REMINDER' },
    _max: { leadTimeDays: true },
  });
  const maxLead = Math.min(aggregateLeadTime._max.leadTimeDays ?? 3, 30);

  // Reminder due-state lives on ReminderTarget after Task 4. Query the
  // per-target rows whose nextDueOn falls within the look-ahead window and
  // whose owning reminder is still active. Group results by reminderId so
  // notifications still go out as one digest per reminder regardless of how
  // many targets it has — when a reminder has multiple targets all due
  // around the same time, we use the earliest nextDueOn for the cycle key.
  const dueTargets = await prisma.reminderTarget.findMany({
    where: {
      nextDueOn: { lte: new Date(now.getTime() + maxLead * DAY_MS) },
      // Filter to kind=REMINDER — chores share the same recurrence + targets
      // model but are ambient (no notifications fire). The /chores UI is the
      // user's surface for completing them.
      reminder: { active: true, kind: 'REMINDER' },
    },
    select: {
      reminderId: true,
      nextDueOn: true,
      reminder: {
        select: {
          id: true,
          leadTimeDays: true,
          notifyUserIds: true,
        },
      },
    },
  });

  // Group by reminder, keep the earliest nextDueOn (drives the cycle key).
  type Group = {
    id: string;
    nextDueOn: Date;
    leadTimeDays: number;
    notifyUserIds: string[];
  };
  const grouped = new Map<string, Group>();
  for (const t of dueTargets) {
    const existing = grouped.get(t.reminderId);
    if (!existing) {
      grouped.set(t.reminderId, {
        id: t.reminder.id,
        nextDueOn: t.nextDueOn,
        leadTimeDays: t.reminder.leadTimeDays,
        notifyUserIds: t.reminder.notifyUserIds,
      });
    } else if (t.nextDueOn < existing.nextDueOn) {
      existing.nextDueOn = t.nextDueOn;
    }
  }

  let enqueued = 0;
  for (const r of grouped.values()) {
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
