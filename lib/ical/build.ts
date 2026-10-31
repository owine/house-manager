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
      // DTEND of an all-day event is exclusive (RFC 5545), so a one-day event
      // ends the next day; `end: e.date` was a zero-length event. `e.date` is a
      // UTC-midnight calendar date, which has no DST, so +24h is exactly one day.
      end: new Date(e.date.getTime() + 86_400_000),
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
