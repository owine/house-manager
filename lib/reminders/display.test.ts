import { describe, expect, it } from 'vitest';
import { asCalendarDate } from '@/lib/time/tz';
import { formatNextDue } from './display';
import { FAR_FUTURE } from './recurrence';

describe('formatNextDue', () => {
  it('formats a real due date as its calendar day', () => {
    expect(formatNextDue(asCalendarDate(new Date('2026-07-15T00:00:00Z')))).toBe('Jul 15, 2026');
  });

  it('shows a dash for a completed one-time reminder, not Dec 31, 9999', () => {
    expect(formatNextDue(FAR_FUTURE)).toBe('—');
  });

  it('shows a dash when there is no due date', () => {
    expect(formatNextDue(null)).toBe('—');
  });
});
