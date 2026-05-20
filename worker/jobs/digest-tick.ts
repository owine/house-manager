import { prisma } from '@/lib/db';
import { getOverdueForUser, getWeeklyForUser } from '@/lib/digests/queries';
import { digestEmail } from '@/lib/email/templates/digest';
import { getEnv } from '@/lib/env';
import { sendEmail } from '@/lib/notifications/email';
import { readNotificationPrefs } from '@/lib/notifications/prefs';

type DigestKind = 'overdue' | 'weekly';

/**
 * Local-time parts for "now" in the given tz. Uses Intl.DateTimeFormat only
 * (no new dependency). `week` is the ISO week key (YYYY-Www).
 */
function localParts(timezone: string): { hour: number; day: number; date: string; week: string } {
  const now = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      weekday: 'short',
      hour12: false,
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  // hour12:false yields 00-23, but some runtimes emit '24' for midnight — guard it.
  const hour = Number(parts.hour === '24' ? '00' : parts.hour);
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = dayMap[parts.weekday as string] ?? 0;
  // ISO week (Thursday-based).
  const [y, m, d] = [Number(parts.year), Number(parts.month), Number(parts.day)] as [
    number,
    number,
    number,
  ];
  const dUtc = new Date(Date.UTC(y, m - 1, d));
  const dow = dUtc.getUTCDay() || 7;
  // Shift to the Thursday of this week, THEN read the year — ISO 8601 weeks
  // belong to the year of their Thursday, so the year-start anchor and the
  // label must both use the post-shift year (they already do).
  dUtc.setUTCDate(dUtc.getUTCDate() + 4 - dow);
  const isoYear = dUtc.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const weekNum = Math.ceil(((dUtc.getTime() - yearStart) / 86_400_000 + 1) / 7);
  const week = `${isoYear}-W${String(weekNum).padStart(2, '0')}`;
  return { hour, day, date, week };
}

async function maybeSend(
  userId: string,
  userEmail: string,
  kind: DigestKind,
  cycle: string,
  appUrl: string,
  timezone: string,
): Promise<void> {
  // Write-log-first-then-catch: the unique constraint is the dedup primitive.
  // Initial status 'queued' (mirrors notify.ts) so a crash between create and
  // update doesn't leave a misleading 'sent' row.
  let logId: string;
  try {
    const log = await prisma.digestLog.create({
      data: { userId, kind, cycle, status: 'queued' },
      select: { id: true },
    });
    logId = log.id;
  } catch (err) {
    // P2002 = unique-constraint violation = already handled this (userId, kind,
    // cycle) — the normal dedup path. Anything else is an unexpected DB error:
    // log it (don't silently drop the digest) and skip this one.
    if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
      return;
    }
    console.error(`digest-tick: failed to create DigestLog for ${userId}/${kind}/${cycle}:`, err);
    return;
  }
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
  const { subject, html, text } = digestEmail({ mode: kind, items, appUrl, timezone });
  const r = await sendEmail(userEmail, { subject, text, html });
  await prisma.digestLog.update({
    where: { id: logId },
    data: r.ok ? { status: 'sent' } : { status: 'failed', errorReason: r.reason },
  });
}

export async function handleDigestTick(): Promise<void> {
  const env = getEnv();
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
      const local = localParts(prefs.timezone);
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
        for (const [kind, cycle] of skips) {
          try {
            await prisma.digestLog.create({
              data: {
                userId: u.id,
                kind,
                cycle,
                status: 'skipped',
                errorReason: 'APP_URL not configured',
              },
            });
          } catch {
            // already logged this cycle
          }
        }
        if (skips.length > 0) {
          console.warn(
            `digest-tick: APP_URL not configured; skipped ${skips.length} digest(s) for user ${u.id}`,
          );
        }
        continue;
      }

      if (overdueDue) {
        await maybeSend(u.id, u.email, 'overdue', local.date, env.APP_URL, prefs.timezone);
      }
      if (weeklyDue) {
        await maybeSend(u.id, u.email, 'weekly', local.week, env.APP_URL, prefs.timezone);
      }
    } catch (err) {
      console.error(`digest-tick: failed processing user ${u.id}:`, err);
    }
  }
}
