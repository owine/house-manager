import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from './assemble';
import { buildIcal } from './build';

function ev(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    uid: 'reminder-r1-2026-06-30',
    reminderId: 'r1',
    date: new Date('2026-06-30T00:00:00Z'),
    title: 'Replace HVAC filter',
    description: 'use MERV 13',
    kind: 'due',
    alarmSecondsBefore: 3 * 86_400,
    ...overrides,
  };
}

describe('buildIcal', () => {
  it('returns one VEVENT per event with an all-day SUMMARY', () => {
    const text = buildIcal([ev({}), ev({ uid: 'reminder-r1-2026-07-30' })], 'https://example.com');
    expect(text).toContain('BEGIN:VCALENDAR');
    expect((text.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
    expect(text).toContain('SUMMARY:Replace HVAC filter');
  });

  it('renders the ✅ prefix from a completed event title', () => {
    const text = buildIcal(
      [ev({ title: '✅ Replace HVAC filter', kind: 'completed', alarmSecondsBefore: null })],
      'https://example.com',
    );
    expect(text).toContain('SUMMARY:✅ Replace HVAC filter');
  });

  it('emits a VALARM only when alarmSecondsBefore is set', () => {
    const withAlarm = buildIcal([ev({ alarmSecondsBefore: 3 * 86_400 })], 'https://example.com');
    expect(withAlarm).toContain('TRIGGER:-P3D');

    const noAlarm = buildIcal([ev({ alarmSecondsBefore: null })], 'https://example.com');
    expect(noAlarm).not.toContain('BEGIN:VALARM');
  });

  it('ends each all-day event the next day (DTEND is exclusive), not on its start', () => {
    // RFC 5545: an all-day event's DTEND is the day AFTER it. DTEND == DTSTART is
    // a zero-length event, which some clients drop or draw as nothing.
    const text = buildIcal(
      [ev({}), ev({ uid: 'reminder-r1-2026-12-31', date: new Date('2026-12-31T00:00:00Z') })],
      'https://example.com',
    );
    expect(text).toContain('DTSTART;VALUE=DATE:20260630\r\nDTEND;VALUE=DATE:20260701');
    expect(text).toContain('DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101');
  });

  it('returns no VEVENT for an empty list', () => {
    const text = buildIcal([], 'https://example.com');
    expect(text).not.toContain('BEGIN:VEVENT');
  });
});
