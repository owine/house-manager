import { describe, expect, it } from 'vitest';
import { parseCalendarDate, resolveAnchorDay } from './dates';

describe('parseCalendarDate', () => {
  it('parses YYYY-MM-DD to UTC midnight', () => {
    const d = parseCalendarDate('2026-07-03');
    expect(d?.toISOString()).toBe('2026-07-03T00:00:00.000Z');
  });

  // The whole point: a calendar date must not shift when the house is behind
  // UTC. Reading 2026-07-03 through America/Chicago would yield July 2.
  it('does not shift the day regardless of house timezone', () => {
    const d = parseCalendarDate('2026-07-03');
    expect(d?.getUTCDate()).toBe(3);
    expect(d?.getUTCMonth()).toBe(6);
    expect(d?.getUTCFullYear()).toBe(2026);
  });

  it('rejects a timestamp, not just a date', () => {
    expect(parseCalendarDate('2026-07-03T20:00:00Z')).toBeNull();
  });

  it('rejects malformed and impossible dates', () => {
    expect(parseCalendarDate('July 3rd')).toBeNull();
    expect(parseCalendarDate('2026-13-01')).toBeNull();
    expect(parseCalendarDate('2026-02-30')).toBeNull();
    expect(parseCalendarDate('')).toBeNull();
  });

  it('accepts a real leap day and rejects a fake one', () => {
    expect(parseCalendarDate('2024-02-29')?.toISOString()).toBe('2024-02-29T00:00:00.000Z');
    expect(parseCalendarDate('2025-02-29')).toBeNull();
  });
});

describe('resolveAnchorDay', () => {
  // 2026-07-04T01:30:00Z is still July 3rd in Chicago (UTC-5).
  it('reads an instant through the house timezone to find "today"', () => {
    const instant = new Date('2026-07-04T01:30:00.000Z');
    expect(resolveAnchorDay(instant, 'America/Chicago')).toBe('2026-07-03');
    expect(resolveAnchorDay(instant, 'UTC')).toBe('2026-07-04');
  });
});
