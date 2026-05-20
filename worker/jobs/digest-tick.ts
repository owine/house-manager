import { prisma } from '@/lib/db';
import { getOverdueForUser, getWeeklyForUser } from '@/lib/digests/queries';
import { digestEmail } from '@/lib/email/templates/digest';
import { getEnv } from '@/lib/env';
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
          } catch (err) {
            // P2002 = already logged this (userId, kind, cycle) — expected.
            // Surface anything else so a real DB problem isn't hidden in the
            // audit table (matches the dedup catch in maybeSend).
            if (!(err && typeof err === 'object' && 'code' in err && err.code === 'P2002')) {
              console.error(
                `digest-tick: failed to log APP_URL skip for ${u.id}/${kind}/${cycle}:`,
                err,
              );
            }
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
