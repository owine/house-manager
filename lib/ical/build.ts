import ical, { ICalAlarmType, ICalCalendarMethod } from 'ical-generator';
import { previewOccurrences } from '@/lib/reminders/recurrence';
import type { Recurrence } from '@/lib/reminders/schema';

export type IcalReminderRow = {
  id: string;
  title: string;
  description: string | null;
  recurrence: Recurrence;
  nextDueOn: Date;
  leadTimeDays: number;
};

export function buildIcal(reminders: IcalReminderRow[], appUrl: string): string {
  const cal = ical({
    name: 'House Manager',
    method: ICalCalendarMethod.PUBLISH,
  });
  for (const r of reminders) {
    const occurrences = [r.nextDueOn, ...previewOccurrences(r.recurrence, r.nextDueOn, 11)];
    for (const date of occurrences) {
      const dateOnly = new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
      );
      cal.createEvent({
        id: `reminder-${r.id}-${dateOnly.toISOString().slice(0, 10)}`,
        start: dateOnly,
        end: dateOnly,
        allDay: true,
        summary: r.title,
        description: r.description ?? '',
        url: `${appUrl}/reminders/${r.id}`,
        alarms: [
          {
            type: ICalAlarmType.display,
            trigger: r.leadTimeDays * 86_400, // seconds before
            description: `${r.title} due`,
          },
        ],
      });
    }
  }
  return cal.toString();
}
