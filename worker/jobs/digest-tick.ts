import { prisma } from '@/lib/db';
import { getOverdueForUser, getWeeklyForUser } from '@/lib/digests/queries';
import { digestEmail } from '@/lib/email/templates/digest';
import { getEnv } from '@/lib/env';
import { getHouseTimezone } from '@/lib/house-profile/queries';
import { sendEmail } from '@/lib/notifications/email';
import { readNotificationPrefs } from '@/lib/notifications/prefs';
import { isoWeek, tzParts } from '@/lib/time/tz';

type DigestKind = 'overdue' | 'weekly';

/**
 * Local-time parts for "now" in the given tz. `week` is the ISO week key (YYYY-Www).
 */
function localParts(timezone: string): { hour: number; day: number; date: string; week: string } {
  const now = new Date();
  const p = tzParts(now, timezone);
  const month = String(p.month).padStart(2, '0');
  const day = String(p.day).padStart(2, '0');
  const date = `${p.year}-${month}-${day}`;
  const week = isoWeek(p);
  return { hour: p.hour, day: p.weekday, date, week };
}

async function maybeSend(
  userId: string,
  userEmail: string,
  kind: DigestKind,
  cycle: string,
  appUrl: string,
  timezone: string,
): Promise<void> {
  // Write-log-first via INSERT ... ON CONFLICT DO NOTHING: the unique
  // constraint is the dedup primitive. createMany+skipDuplicates compiles to
  // ON CONFLICT DO NOTHING, so the no-op case doesn't emit a unique-violation
  // error to Postgres or Prisma logs (unlike a plain create+catch-P2002).
  // Initial status 'queued' (mirrors notify.ts) so a crash between create and
  // update doesn't leave a misleading 'sent' row.
  const created = await prisma.digestLog.createMany({
    data: [{ userId, kind, cycle, status: 'queued' }],
    skipDuplicates: true,
  });
  if (created.count === 0) return; // already handled this (userId, kind, cycle)
  const log = await prisma.digestLog.findUniqueOrThrow({
    where: { userId_kind_cycle: { userId, kind, cycle } },
    select: { id: true },
  });
  const logId = log.id;
  const items =
    kind === 'overdue'
      ? await getOverdueForUser(userId, timezone)
      : await getWeeklyForUser(userId, timezone);
  if (items.length === 0) {
    await prisma.digestLog.update({
      where: { id: logId },
      data: { status: 'skipped', errorReason: 'nothing to report' },
    });
    return;
  }
  // `timezone` scopes the queries above (which "today" the overdue/weekly window
  // is anchored to); the template renders each due date from its stored calendar
  // date, so it needs no tz.
  const { subject, html, text } = digestEmail({ mode: kind, items, appUrl });
  const r = await sendEmail(userEmail, { subject, text, html });
  await prisma.digestLog.update({
    where: { id: logId },
    data: r.ok ? { status: 'sent' } : { status: 'failed', errorReason: r.reason },
  });
}

export async function handleDigestTick(): Promise<void> {
  const env = getEnv();
  // One house-wide timezone drives both digest scheduling and the overdue/weekly
  // window — so the email's "today" matches the in-app calendar exactly.
  const tz = await getHouseTimezone();
  // User.email is non-nullable in the schema, so no email-presence filter is
  // needed. We still skip users whose JSON prefs don't enable email delivery.
  const users = await prisma.user.findMany({
    select: { id: true, email: true, notificationPrefs: true },
  });
  for (const u of users) {
    const prefs = readNotificationPrefs(u.notificationPrefs);
    if (!prefs.emailEnabled) continue;
    if (!prefs.overdueDigestEnabled && !prefs.weeklySummaryEnabled) continue;

    try {
      const local = localParts(tz);
      const overdueDue = prefs.overdueDigestEnabled && local.hour === prefs.overdueDigestHour;
      const weeklyDue =
        prefs.weeklySummaryEnabled &&
        local.day === prefs.weeklySummaryDay &&
        local.hour === prefs.weeklySummaryHour;

      if (!env.APP_URL) {
        // Log a skipped row only for the kinds that would have fired this hour,
        // so the user sees exactly why no email arrived (no spurious rows).
        const skips: Array<[DigestKind, string]> = [];
        if (overdueDue) skips.push(['overdue', local.date]);
        if (weeklyDue) skips.push(['weekly', local.week]);
        if (skips.length > 0) {
          // ON CONFLICT DO NOTHING — silent no-op when the row already exists,
          // so we don't emit a unique-violation error per skipped hour.
          await prisma.digestLog.createMany({
            data: skips.map(([kind, cycle]) => ({
              userId: u.id,
              kind,
              cycle,
              status: 'skipped' as const,
              errorReason: 'APP_URL not configured',
            })),
            skipDuplicates: true,
          });
          console.warn(
            `digest-tick: APP_URL not configured; skipped ${skips.length} digest(s) for user ${u.id}`,
          );
        }
        continue;
      }

      if (overdueDue) {
        await maybeSend(u.id, u.email, 'overdue', local.date, env.APP_URL, tz);
      }
      if (weeklyDue) {
        await maybeSend(u.id, u.email, 'weekly', local.week, env.APP_URL, tz);
      }
    } catch (err) {
      console.error(`digest-tick: failed processing user ${u.id}:`, err);
    }
  }
}
