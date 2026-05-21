import ical, { ICalAlarmType, ICalCalendarMethod } from 'ical-generator';
import type { CalendarEvent } from './assemble';

export function buildIcal(events: CalendarEvent[], appUrl: string): string {
  const cal = ical({
    name: 'House Manager',
    method: ICalCalendarMethod.PUBLISH,
  });
  for (const e of events) {
    const event = cal.createEvent({
      id: e.uid,
      start: e.date,
      end: e.date,
      allDay: true,
      summary: e.title,
      description: e.description,
      url: `${appUrl}/reminders/${e.reminderId}`,
    });
    if (e.alarmSecondsBefore !== null) {
      event.createAlarm({
        type: ICalAlarmType.display,
        // ical-generator reads a positive `trigger` as "N seconds BEFORE the event"
        // (it emits the RFC-5545 negative duration itself) — don't pre-negate this.
        trigger: e.alarmSecondsBefore,
        description: `${e.title} due`,
      });
    }
  }
  return cal.toString();
}
