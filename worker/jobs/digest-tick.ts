import { prisma } from '@/lib/db';
import { groupBySystem } from '@/lib/digests/group';
import { getOverdueForUser, getWeeklyForUser } from '@/lib/digests/queries';
import { digestEmail } from '@/lib/email/templates/digest';
import { getEnv } from '@/lib/env';
import { getHouseTimezone } from '@/lib/house-profile/queries';
import { sendEmail } from '@/lib/notifications/email';
import { readNotificationPrefs } from '@/lib/notifications/prefs';
import { isoWeek, tzParts } from '@/lib/time/tz';

type DigestKind = 'overdue' | 'weekly';

/**
 * Hours after the chosen one in which a digest may still go out, so a missed
 * hour does not mean a missed digest. The chosen hour can be skipped outright
 * (02:00 on spring-forward Sunday in Chicago, where ticks read 01:30 then
 * 03:00), and a worker down across both of its ticks used to lose that day's
 * or week's digest. DigestLog's unique (userId, kind, cycle) makes every later
 * tick in the window a no-op, so it still sends once.
 */
const CATCH_UP_HOURS = 3;

/**
 * True from `chosen` until CATCH_UP_HOURS later, on the same house day. It does
 * not wrap past midnight: the cycle key is the house date (or ISO week), so a
 * 23:00 digest caught up at 00:30 would be filed as the NEXT day's and then
 * send again at that day's 23:00.
 */
function inSendWindow(hour: number, chosen: number): boolean {
  return hour >= chosen && hour < chosen + CATCH_UP_HOURS;
}

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
  // One row per ReminderTarget: a multi-target reminder appears several times.
  const rows =
    kind === 'overdue'
      ? await getOverdueForUser(userId, timezone)
      : await getWeeklyForUser(userId, timezone);
  const groups = groupBySystem(rows);
  if (groups.length === 0) {
    await prisma.digestLog.update({
      where: { id: logId },
      data: { status: 'skipped', errorReason: 'nothing to report' },
    });
    return;
  }
  // `timezone` scopes the queries above (which "today" the overdue/weekly window
  // is anchored to); the template renders each due date from its stored calendar
  // date, so it needs no tz.
  const { subject, html, text } = digestEmail({ mode: kind, groups, appUrl });
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
      const overdueDue =
        prefs.overdueDigestEnabled && inSendWindow(local.hour, prefs.overdueDigestHour);
      const weeklyDue =
        prefs.weeklySummaryEnabled &&
        local.day === prefs.weeklySummaryDay &&
        inSendWindow(local.hour, prefs.weeklySummaryHour);

      if (!env.APP_URL) {
        // Log a skipped row only for the kinds whose window is open now,
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
