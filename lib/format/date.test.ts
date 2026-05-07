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

  it('formats a date consistently regardless of TZ environment', () => {
    // Create a date at UTC midnight; verify it formats as the UTC date
    // regardless of how the system timezone might interpret it.
    const utcDate = new Date('2024-06-20T00:00:00Z');
    const formatted = formatCalendarDate(utcDate);
    // Should always be June 20, because the Date was created at UTC midnight
    expect(formatted).toBe('Jun 20, 2024');
  });

  it('handles dates from different months and years', () => {
    expect(formatCalendarDate('2025-12-31T00:00:00Z')).toBe('Dec 31, 2025');
    expect(formatCalendarDate('2000-02-29T00:00:00Z')).toBe('Feb 29, 2000');
  });
});
