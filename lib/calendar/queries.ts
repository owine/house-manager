import { prisma } from '@/lib/db';
import { collapseDuplicateReminderEvents } from './collapse';

export type CalendarEvent =
  | {
      kind: 'reminder';
      id: string;
      title: string;
      date: Date;
    }
  | {
      kind: 'service';
      id: string;
      title: string;
      date: Date;
    };

/**
 * Reminders due-in-month + service records performed-in-month, in a single
 * pair of queries. Returned together as a flat event list ordered by date so
 * the calendar grid only iterates once.
 *
 * Range is half-open `[start, end)` on the server side; callers compute the
 * month boundaries (UTC) and pass them in. The calendar renders in the user's
 * locale via `formatCalendarDate` at presentation time.
 */
export async function listCalendarEventsInRange(opts: {
  start: Date;
  end: Date;
}): Promise<CalendarEvent[]> {
  const { start, end } = opts;

  // `nextDueOn` lives on ReminderTarget — multiple targets on one reminder can
  // be due on different days, so each target is projected as its own event and
  // duplicates within a day are collapsed below. A reminder spanning 3 items
  // due on 3 days is 3 dots; the same 3 items due on one day is 1 dot.
  const [targets, services] = await Promise.all([
    prisma.reminderTarget.findMany({
      where: { nextDueOn: { gte: start, lt: end }, reminder: { active: true } },
      select: {
        nextDueOn: true,
        reminder: { select: { id: true, title: true } },
      },
      orderBy: { nextDueOn: 'asc' },
    }),
    prisma.serviceRecord.findMany({
      where: { performedOn: { gte: start, lt: end } },
      select: { id: true, summary: true, performedOn: true },
      orderBy: { performedOn: 'asc' },
    }),
  ]);

  const events: CalendarEvent[] = collapseDuplicateReminderEvents([
    ...targets.map(
      (t): CalendarEvent => ({
        kind: 'reminder' as const,
        id: t.reminder.id,
        title: t.reminder.title,
        date: t.nextDueOn,
      }),
    ),
    ...services.map(
      (s): CalendarEvent => ({
        kind: 'service' as const,
        id: s.id,
        title: s.summary,
        date: s.performedOn,
      }),
    ),
  ]);
  events.sort((a, b) => a.date.getTime() - b.date.getTime());
  return events;
}
