import { describe, expect, it } from 'vitest';
import {
  endOfCalendarDayInTz,
  isOverdue,
  isoWeek,
  startOfDayUtc,
  tzOffsetMinutes,
  tzParts,
} from './tz';

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

const CHI = 'America/Chicago';
const UTC = 'UTC';

// nextDueOn is a date-only value stored at UTC midnight (see computeNextDueOn ->
// toUtcMidnight, and lib/format/date.ts). These helpers build values the way
// production actually stores them: Date.UTC(y, m-1, d) with NO timezone offset.
const dueOn = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe('isOverdue', () => {
  it('returns false when due date is today in tz (chore stored at UTC midnight)', () => {
    // The reported bug: a chore "due today" stored at UTC midnight must NOT be
    // overdue in a negative-offset zone. 2026-06-10 09:00 CDT, due 2026-06-10.
    const now = new Date('2026-06-10T14:00:00Z'); // 09:00 CDT Jun-10
    expect(isOverdue(dueOn(2026, 6, 10), now, CHI)).toBe(false);
  });

  it('returns false even late on the due day in tz (just before local midnight)', () => {
    // 2026-06-10 23:30 CDT = 2026-06-11T04:30Z. Still the 10th locally → not overdue.
    const now = new Date('2026-06-11T04:30:00Z');
    expect(isOverdue(dueOn(2026, 6, 10), now, CHI)).toBe(false);
  });

  it('returns true when due date is yesterday in tz', () => {
    const now = new Date('2026-06-10T14:00:00Z'); // 09:00 CDT Jun-10
    expect(isOverdue(dueOn(2026, 6, 9), now, CHI)).toBe(true);
  });

  it('returns false when due is tomorrow', () => {
    const now = new Date('2026-06-10T14:00:00Z');
    expect(isOverdue(dueOn(2026, 6, 11), now, CHI)).toBe(false);
  });

  it('flips to overdue at local midnight, not UTC midnight (Chicago, UTC-5 in summer)', () => {
    const due = dueOn(2026, 6, 10);
    // 2026-06-11 00:30 UTC = 2026-06-10 19:30 CDT → still the 10th locally → NOT overdue.
    expect(isOverdue(due, new Date('2026-06-11T00:30:00Z'), CHI)).toBe(false);
    // 2026-06-11 05:30 UTC = 2026-06-11 00:30 CDT → now the 11th locally → overdue.
    expect(isOverdue(due, new Date('2026-06-11T05:30:00Z'), CHI)).toBe(true);
  });

  it('handles DST spring-forward (2026-03-08 in Chicago)', () => {
    // Due on the 8th, "now" later on the 8th — same calendar day, not overdue.
    const now = new Date('2026-03-08T18:00:00Z'); // 13:00 CDT post spring-forward
    expect(isOverdue(dueOn(2026, 3, 8), now, CHI)).toBe(false);
  });

  it('handles DST fall-back (2026-11-01 in Chicago)', () => {
    const now = new Date('2026-11-01T22:00:00Z'); // 16:00 CST post fall-back
    expect(isOverdue(dueOn(2026, 11, 1), now, CHI)).toBe(false);
  });

  it('compares by calendar date in UTC for the UTC tz', () => {
    const now = new Date('2026-05-27T15:00:00Z');
    expect(isOverdue(dueOn(2026, 5, 27), now, UTC)).toBe(false);
    expect(isOverdue(dueOn(2026, 5, 26), now, UTC)).toBe(true);
  });
});

describe('startOfDayUtc', () => {
  it('returns UTC midnight of the calendar day the instant falls on in tz', () => {
    // 2026-06-10 09:00 CDT (= 14:00Z) → calendar day Jun-10 → UTC-midnight Jun-10.
    const start = startOfDayUtc(new Date('2026-06-10T14:00:00Z'), CHI);
    expect(start.toISOString()).toBe('2026-06-10T00:00:00.000Z');
  });

  it('uses the LOCAL calendar day, not the UTC one, near local midnight', () => {
    // 2026-06-11 04:30Z = 2026-06-10 23:30 CDT → local day is still Jun-10.
    const start = startOfDayUtc(new Date('2026-06-11T04:30:00Z'), CHI);
    expect(start.toISOString()).toBe('2026-06-10T00:00:00.000Z');
  });

  it('UTC tz returns UTC midnight of the same UTC date', () => {
    const start = startOfDayUtc(new Date('2026-05-27T15:00:00Z'), UTC);
    expect(start.toISOString()).toBe('2026-05-27T00:00:00.000Z');
  });
});

describe('endOfCalendarDayInTz', () => {
  it('returns 23:59:59.999 wall-clock in tz on the value’s UTC calendar date', () => {
    // Calendar date Jun-10; 23:59:59.999 CDT (UTC-5) = 2026-06-11T04:59:59.999Z.
    const eod = endOfCalendarDayInTz(dueOn(2026, 6, 10), CHI);
    expect(eod.toISOString()).toBe('2026-06-11T04:59:59.999Z');
  });

  it('UTC returns 23:59:59.999Z of the same UTC date', () => {
    const eod = endOfCalendarDayInTz(dueOn(2026, 5, 27), UTC);
    expect(eod.toISOString()).toBe('2026-05-27T23:59:59.999Z');
  });
});
