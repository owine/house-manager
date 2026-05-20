import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { buildIcal } from '@/lib/ical/build';
import { parseRecurrence } from '@/lib/reminders/schema';

type Params = Promise<{ token: string }>;

export async function GET(_req: Request, { params }: { params: Params }) {
  const { token: raw } = await params;
  const token = raw.endsWith('.ics') ? raw.slice(0, -4) : raw;

  const user = await prisma.user.findUnique({ where: { icsToken: token }, select: { id: true } });
  if (!user) return new Response('Not found', { status: 404 });

  // Reminder due-state lives on ReminderTarget. Fetch active reminders (with
  // their targets) for this user; the iCal builder receives one row per
  // reminder with the earliest target's nextDueOn (one event series per
  // reminder is the existing UX).
  const reminders = await prisma.reminder.findMany({
    where: {
      active: true,
      notifyUserIds: { has: user.id },
    },
    select: {
      id: true,
      title: true,
      description: true,
      recurrence: true,
      leadTimeDays: true,
      targets: { select: { nextDueOn: true }, orderBy: { nextDueOn: 'asc' }, take: 1 },
    },
  });

  const env = getEnv();
  const body = buildIcal(
    reminders
      .filter((r) => r.targets.length > 0)
      .map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        recurrence: parseRecurrence(r.recurrence),
        nextDueOn: r.targets[0].nextDueOn,
        leadTimeDays: r.leadTimeDays,
      })),
    env.APP_URL ?? '',
  );

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
