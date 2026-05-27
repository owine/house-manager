import { describe, expect, it } from 'vitest';
import { endOfDayInTz, isOverdue, isoWeek, tzOffsetMinutes, tzParts } from './tz';

describe('tzParts', () => {
  it('decomposes a UTC instant into EDT wall-clock parts (America/New_York, summer)', () => {
    // 2026-07-01T16:00:00Z = 12:00 EDT (UTC-4) on Wednesday July 1 2026
    const parts = tzParts(new Date('2026-07-01T16:00:00Z'), 'America/New_York');
    expect(parts).toEqual({ year: 2026, month: 7, day: 1, hour: 12, minute: 0, weekday: 3 });
  });

  it('round-trips UTC fields when timeZone is UTC', () => {
    // 2026-03-15T09:30:00Z = 09:30 UTC on Sunday Mar 15 2026
    const parts = tzParts(new Date('2026-03-15T09:30:00Z'), 'UTC');
    expect(parts).toEqual({ year: 2026, month: 3, day: 15, hour: 9, minute: 30, weekday: 0 });
  });

  it('handles a half-hour offset zone (Asia/Kolkata, UTC+5:30)', () => {
    // 2026-07-01T16:00:00Z + 5:30 = 2026-07-01T21:30 IST
    const parts = tzParts(new Date('2026-07-01T16:00:00Z'), 'Asia/Kolkata');
    expect(parts).toEqual({ year: 2026, month: 7, day: 1, hour: 21, minute: 30, weekday: 3 });
  });

  it('handles the midnight-hour quirk: 00:00 in tz parses as hour=0, not 24', () => {
    // 2026-07-01T04:00:00Z = 00:00 EDT on Jul 1 (midnight) — some runtimes emit '24'
    const parts = tzParts(new Date('2026-07-01T04:00:00Z'), 'America/New_York');
    expect(parts.hour).toBe(0);
    expect(parts.minute).toBe(0);
    expect(parts.day).toBe(1);
  });
});

describe('tzOffsetMinutes', () => {
  it('returns -240 for America/New_York in summer (EDT)', () => {
    expect(tzOffsetMinutes(new Date('2026-07-01T16:00:00Z'), 'America/New_York')).toBe(-240);
  });

  it('returns 330 for Asia/Kolkata (IST, always +5:30)', () => {
    expect(tzOffsetMinutes(new Date('2026-07-01T16:00:00Z'), 'Asia/Kolkata')).toBe(330);
  });

  it('returns 0 for UTC', () => {
    expect(tzOffsetMinutes(new Date('2026-07-01T16:00:00Z'), 'UTC')).toBe(0);
  });

  it('returns -300 for America/New_York in winter (EST)', () => {
    // 2026-01-15T12:00:00Z = 07:00 EST (UTC-5)
    expect(tzOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-300);
  });
});

describe('isoWeek', () => {
  it('returns 2026-W01 for 2026-01-01 (Jan 1 2026 is a Thursday — belongs to W01)', () => {
    // Jan 1 2026: dow=4 (Thu). dUtc stays Jan 1. yearStart=Jan 1 2026. diff=0 days.
    // weekNum = ceil((0+1)/7) = 1.
    expect(isoWeek({ year: 2026, month: 1, day: 1 })).toBe('2026-W01');
  });

  it('returns 2026-W53 for 2026-12-28 (2026 is a 53-week ISO year)', () => {
    // 2026 starts on a Thursday, so it has 53 ISO weeks. Dec 28 2026 (Mon)
    // shifts to its Thursday Dec 31 2026, still in ISO year 2026 → W53.
    expect(isoWeek({ year: 2026, month: 12, day: 28 })).toBe('2026-W53');
  });

  it('handles a year-boundary date that belongs to the NEXT ISO year', () => {
    // Dec 31 2018 is a Monday. Its Thursday = Jan 3 2019. isoYear=2019.
    // yearStart = Jan 1 2019. diff = (Jan3 - Jan1) = 2 days.
    // weekNum = ceil((2+1)/7) = ceil(3/7) = ceil(0.43) = 1.
    // So Dec 31 2018 → 2019-W01.
    expect(isoWeek({ year: 2018, month: 12, day: 31 })).toBe('2019-W01');
  });

  it('handles a year-boundary date that belongs to the PRIOR ISO year', () => {
    // Jan 1 2016 is a Friday. Its Thursday = Dec 31 2015. isoYear=2015.
    // yearStart = Jan 1 2015. Dec 31 2015 is day 364 (0-indexed).
    // weekNum = ceil((364+1)/7) = ceil(52.14) = 53.
    // 2015 has 53 ISO weeks (Jan 1 2015 is Thursday, same as 2026 case).
    expect(isoWeek({ year: 2016, month: 1, day: 1 })).toBe('2015-W53');
  });
});

const NY = 'America/New_York';
const UTC = 'UTC';

describe('isOverdue', () => {
  it('returns false when due date is later today in tz (mid-afternoon)', () => {
    // 2026-05-27 15:00 UTC = 2026-05-27 11:00 EDT; due midnight UTC = 2026-05-27 in UTC, 2026-05-26 in NY.
    const now = new Date('2026-05-27T15:00:00Z');
    const dueToday = new Date('2026-05-27T00:00:00Z'); // wall-clock today in UTC
    expect(isOverdue(dueToday, now, UTC)).toBe(false);
  });

  it('returns true when due date is yesterday in tz', () => {
    const now = new Date('2026-05-27T15:00:00Z');
    const dueYesterday = new Date('2026-05-26T00:00:00Z');
    expect(isOverdue(dueYesterday, now, UTC)).toBe(true);
  });

  it('returns false when due is tomorrow', () => {
    const now = new Date('2026-05-27T15:00:00Z');
    const dueTomorrow = new Date('2026-05-28T00:00:00Z');
    expect(isOverdue(dueTomorrow, now, UTC)).toBe(false);
  });

  it('is not overdue at 23:59 local on the due day', () => {
    // 2026-05-27 23:59 EDT = 2026-05-28 03:59 UTC; due date 2026-05-27 in NY tz.
    const now = new Date('2026-05-28T03:59:00Z');
    const due = new Date('2026-05-27T04:00:00Z'); // 00:00 EDT on the 27th
    expect(isOverdue(due, now, NY)).toBe(false);
  });

  it('is overdue at 00:01 local the day after due', () => {
    // 2026-05-28 00:01 EDT = 2026-05-28 04:01 UTC.
    const now = new Date('2026-05-28T04:01:00Z');
    const due = new Date('2026-05-27T04:00:00Z');
    expect(isOverdue(due, now, NY)).toBe(true);
  });

  it('handles DST spring-forward (2026-03-08 in NY)', () => {
    // Due on the 8th, "now" is later on the 8th — same calendar day, not overdue.
    const due = new Date('2026-03-08T05:00:00Z'); // 00:00 EST
    const now = new Date('2026-03-08T18:00:00Z'); // 14:00 EDT post spring-forward
    expect(isOverdue(due, now, NY)).toBe(false);
  });

  it('handles DST fall-back (2026-11-01 in NY)', () => {
    const due = new Date('2026-11-01T04:00:00Z'); // 00:00 EDT
    const now = new Date('2026-11-01T22:00:00Z'); // 17:00 EST post fall-back
    expect(isOverdue(due, now, NY)).toBe(false);
  });
});

describe('endOfDayInTz', () => {
  it('returns 23:59:59.999 wall-clock of the input date in tz, as UTC instant', () => {
    const d = new Date('2026-05-27T10:00:00Z'); // 06:00 EDT on the 27th
    const eod = endOfDayInTz(d, NY);
    // 23:59:59.999 EDT on 2026-05-27 = 03:59:59.999 UTC on 2026-05-28.
    expect(eod.toISOString()).toBe('2026-05-28T03:59:59.999Z');
  });

  it('UTC returns 23:59:59.999Z of the same UTC date', () => {
    const d = new Date('2026-05-27T15:00:00Z');
    expect(endOfDayInTz(d, UTC).toISOString()).toBe('2026-05-27T23:59:59.999Z');
  });
});
