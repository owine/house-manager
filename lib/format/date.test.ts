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

import { parseDateInput, toDateInputValue } from './date';

describe('toDateInputValue', () => {
  it('returns empty string for null/undefined', () => {
    expect(toDateInputValue(null)).toBe('');
    expect(toDateInputValue(undefined)).toBe('');
  });

  it('formats a Date as YYYY-MM-DD using UTC components', () => {
    expect(toDateInputValue(new Date('2026-05-31T00:00:00Z'))).toBe('2026-05-31');
  });

  it('preserves UTC date even when the instant is non-midnight', () => {
    // 23:30 UTC on Jun 20 — local-time formatting would shift to Jun 21 in Tokyo
    expect(toDateInputValue(new Date('2026-06-20T23:30:00Z'))).toBe('2026-06-20');
  });

  it('passes through a YYYY-MM-DD string unchanged', () => {
    expect(toDateInputValue('2026-05-31')).toBe('2026-05-31');
  });
});

describe('parseDateInput', () => {
  it('returns null for empty string', () => {
    expect(parseDateInput('')).toBeNull();
  });

  it('parses YYYY-MM-DD as UTC midnight', () => {
    const d = parseDateInput('2026-05-31');
    expect(d).toBeInstanceOf(Date);
    expect(d?.toISOString()).toBe('2026-05-31T00:00:00.000Z');
  });
});
