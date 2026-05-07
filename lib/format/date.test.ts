import { describe, expect, it } from 'vitest';
import { formatCalendarDate } from './date';

describe('formatCalendarDate', () => {
  it('returns empty string for null', () => {
    expect(formatCalendarDate(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(formatCalendarDate(undefined)).toBe('');
  });

  it('formats a Date object correctly with UTC timezone', () => {
    const date = new Date('2024-01-15T00:00:00Z');
    expect(formatCalendarDate(date)).toBe('Jan 15, 2024');
  });

  it('formats an ISO string correctly with UTC timezone', () => {
    expect(formatCalendarDate('2024-01-15T00:00:00Z')).toBe('Jan 15, 2024');
  });

  it('anchors to UTC even when the instant straddles midnight in other TZs', () => {
    // 23:30 UTC on Jun 20 is Jun 21 in Tokyo (UTC+9) and Jun 20 in LA (UTC-8).
    // A non-UTC formatter would yield Jun 21 in Tokyo. Forcing UTC must yield Jun 20.
    expect(formatCalendarDate('2024-06-20T23:30:00Z')).toBe('Jun 20, 2024');
    // 00:30 UTC on Jun 20 is Jun 19 in LA (UTC-8). Forcing UTC must yield Jun 20.
    expect(formatCalendarDate('2024-06-20T00:30:00Z')).toBe('Jun 20, 2024');
  });

  it('handles dates from different months and years', () => {
    expect(formatCalendarDate('2025-12-31T00:00:00Z')).toBe('Dec 31, 2025');
    expect(formatCalendarDate('2000-02-29T00:00:00Z')).toBe('Feb 29, 2000');
  });
});
