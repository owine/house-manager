import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { sendEmail } from '@/lib/notifications/email';
import { readNotificationPrefs } from '@/lib/notifications/prefs';
import { sendPush } from '@/lib/notifications/push';
import { isInQuietWindow, nextNonQuietTime } from '@/lib/notifications/quiet-hours';

export type NotifyJob = {
  reminderId: string;
  userId: string;
  channel: 'push' | 'email';
  cycle: string;
};

export async function handleNotify(
  payload: NotifyJob,
  deps?: {
    enqueueLater?: (delay: Date) => Promise<void>;
  },
): Promise<void> {
  const reminder = await prisma.reminder.findUnique({
    where: { id: payload.reminderId },
    select: { id: true, title: true, description: true, active: true, itemId: true },
  });
  if (!reminder?.active) return;

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, email: true, notificationPrefs: true },
  });
  if (!user) return;

  const prefs = readNotificationPrefs(user.notificationPrefs);
  const now = new Date();

  if (isInQuietWindow(now, prefs)) {
    if (deps?.enqueueLater) await deps.enqueueLater(nextNonQuietTime(now, prefs));
    return;
  }

  // Insert log first; rely on unique constraint to dedupe.
  let logId: string;
  try {
    const log = await prisma.notificationLog.create({
      data: { ...payload, status: 'queued' },
      select: { id: true },
    });
    logId = log.id;
  } catch {
    // Unique-constraint violation = already notified for this cycle.
    return;
  }

  const env = getEnv();
  const url = `${env.APP_URL ?? ''}/reminders/${reminder.id}`;

  if (payload.channel === 'push') {
    const subs = await prisma.pushSubscription.findMany({
      where: { userId: payload.userId },
    });
    if (subs.length === 0) {
      await prisma.notificationLog.update({
        where: { id: logId },
        data: { status: 'skipped', errorReason: 'no subscriptions' },
      });
      return;
    }
    let anyOk = false;
    for (const sub of subs) {
      const r = await sendPush(sub, {
        title: reminder.title,
        body: reminder.description?.slice(0, 200) ?? 'Due soon',
        url,
      });
      if (r.ok) {
        anyOk = true;
        await prisma.pushSubscription.update({
          where: { id: sub.id },
          data: { lastUsedAt: new Date() },
        });
      } else if (r.reason === 'subscription-gone') {
        await prisma.pushSubscription.delete({ where: { id: sub.id } });
      }
    }
    await prisma.notificationLog.update({
      where: { id: logId },
      data: { status: anyOk ? 'sent' : 'skipped' },
    });
    return;
  }

  // email
  if (!user.email) {
    await prisma.notificationLog.update({
      where: { id: logId },
      data: { status: 'skipped', errorReason: 'no email' },
    });
    return;
  }
  const subject = `Reminder: ${reminder.title}`;
  const body = `${reminder.description ?? ''}\n\n${url}`;
  const html = `<p>${escapeHtml(reminder.description ?? '')}</p><p><a href="${url}">Mark complete</a></p>`;
  const r = await sendEmail(user.email, { subject, text: body, html });
  await prisma.notificationLog.update({
    where: { id: logId },
    data: r.ok ? { status: 'sent' } : { status: 'failed', errorReason: r.reason },
  });
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    // biome-ignore lint/style/noNonNullAssertion: regex matches exactly these 5 chars
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
