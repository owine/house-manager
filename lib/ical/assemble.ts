import { isSentinelDate, previewOccurrences } from '@/lib/reminders/recurrence';
import type { Recurrence } from '@/lib/reminders/schema';

export type CalendarEventKind = 'completed' | 'due' | 'projected';

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
  nextDueOn: Date;
  leadTimeDays: number;
  completions: Date[]; // completedOn values, merged across targets
};

/** Normalize any timestamp to UTC midnight, matching the all-day convention in build.ts. */
function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Turn one reminder's state into the flat list of calendar events the feed should show:
 * a ✅ event per completion (on its completedOn date), the current due event (unless it is
 * the year-9999 sentinel a completed one-shot carries), and future projections.
 * `now` decides whether the due event is overdue (no alarm) or upcoming (lead-time alarm).
 */
export function assembleReminderEvents(input: AssembleInput, now: Date): CalendarEvent[] {
  const description = input.description ?? '';
  const leadSeconds = input.leadTimeDays * 86_400;
  const events: CalendarEvent[] = [];

  input.completions.forEach((completedOn, i) => {
    const date = utcMidnight(completedOn);
    events.push({
      uid: `reminder-${input.id}-done-${isoDate(date)}-${i}`,
      reminderId: input.id,
      date,
      title: `✅ ${input.title}`,
      description,
      kind: 'completed',
      alarmSecondsBefore: null,
    });
  });

  if (!isSentinelDate(input.nextDueOn)) {
    const date = utcMidnight(input.nextDueOn);
    events.push({
      uid: `reminder-${input.id}-${isoDate(date)}`,
      reminderId: input.id,
      date,
      title: input.title,
      description,
      kind: 'due',
      alarmSecondsBefore: input.nextDueOn.getTime() >= now.getTime() ? leadSeconds : null,
    });

    for (const occ of previewOccurrences(input.recurrence, input.nextDueOn, 11)) {
      const d = utcMidnight(occ);
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
