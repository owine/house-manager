import { isSentinelDate, previewOccurrences } from '@/lib/reminders/recurrence';
import type { Recurrence } from '@/lib/reminders/schema';
import { type CalendarDate, isOverdue, startOfDayUtc } from '@/lib/time/tz';

type CalendarEventKind = 'completed' | 'due' | 'projected';

export type CalendarEvent = {
  uid: string;
  reminderId: string;
  date: Date; // UTC midnight (all-day)
  title: string; // already prefixed with "✅ " when completed
  description: string; // reminder description ?? '' — same for all kinds
  kind: CalendarEventKind;
  alarmSecondsBefore: number | null; // null = emit no VALARM
};

export type AssembleInput = {
  id: string;
  title: string;
  description: string | null;
  recurrence: Recurrence;
  nextDueOn: CalendarDate;
  leadTimeDays: number;
  completions: Date[]; // completedOn values, merged across targets
};

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Turn one reminder's state into the flat list of calendar events the feed should show:
 * a ✅ event per completion (on its completedOn date), the current due event (unless it is
 * the year-9999 sentinel a completed one-shot carries), and future projections.
 * `now` and `tz` together decide whether the due event is overdue (no alarm) or upcoming
 * (lead-time alarm). The calendar-day boundary is evaluated in `tz` so that a due-today
 * entry that crossed UTC midnight remains alarmed until end-of-day in the house timezone.
 */
export function assembleReminderEvents(
  input: AssembleInput,
  now: Date,
  tz: string,
): CalendarEvent[] {
  const description = input.description ?? '';
  const leadSeconds = input.leadTimeDays * 86_400;
  const events: CalendarEvent[] = [];

  const seenDays = new Set<string>();
  for (const completedOn of input.completions) {
    // `completedOn` is an INSTANT; bucket it by the day it fell on in the HOUSE.
    // utcMidnight() read it in UTC, so an evening completion landed a day late --
    // and auto-completed chores, stamped at 04:59:59.999Z the next UTC day, landed
    // a day late EVERY time, systematically.
    const date = startOfDayUtc(completedOn, tz);
    const key = isoDate(date);
    if (seenDays.has(key)) continue;
    seenDays.add(key);
    events.push({
      uid: `reminder-${input.id}-done-${key}`,
      reminderId: input.id,
      date,
      title: `✅ ${input.title}`,
      description,
      kind: 'completed',
      alarmSecondsBefore: null,
    });
  }

  if (!isSentinelDate(input.nextDueOn)) {
    const date = input.nextDueOn;
    events.push({
      uid: `reminder-${input.id}-${isoDate(date)}`,
      reminderId: input.id,
      date,
      title: input.title,
      description,
      kind: 'due',
      alarmSecondsBefore: isOverdue(input.nextDueOn, now, tz) ? null : leadSeconds,
    });

    for (const occ of previewOccurrences(input.recurrence, input.nextDueOn, 11)) {
      const d = occ;
      events.push({
        uid: `reminder-${input.id}-proj-${isoDate(d)}`,
        reminderId: input.id,
        date: d,
        title: input.title,
        description,
        kind: 'projected',
        alarmSecondsBefore: leadSeconds,
      });
    }
  }

  return events;
}
