import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { buildIcal } from '@/lib/ical/build';
import type { Recurrence } from '@/lib/reminders/schema';

type Params = Promise<{ token: string }>;

export async function GET(_req: Request, { params }: { params: Params }) {
  const { token: raw } = await params;
  const token = raw.endsWith('.ics') ? raw.slice(0, -4) : raw;

  const user = await prisma.user.findUnique({ where: { icsToken: token }, select: { id: true } });
  if (!user) return new Response('Not found', { status: 404 });

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
      nextDueOn: true,
      leadTimeDays: true,
    },
  });

  const env = getEnv();
  const body = buildIcal(
    reminders.map((r) => ({
      ...r,
      recurrence: r.recurrence as unknown as Recurrence,
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
