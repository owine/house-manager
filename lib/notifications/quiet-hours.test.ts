import { describe, expect, it } from 'vitest';
import type { NotificationPrefs } from './prefs';
import { isInQuietWindow, nextNonQuietTime } from './quiet-hours';

const utc = (iso: string) => new Date(iso);
const UTC = 'UTC';
const NY = 'America/New_York';
const baseline: NotificationPrefs = {
  pushEnabled: true,
  emailEnabled: false,
  quietStart: '22:00',
  quietEnd: '07:00',
  overdueDigestEnabled: false,
  overdueDigestHour: 8,
  weeklySummaryEnabled: false,
  weeklySummaryDay: 1,
  weeklySummaryHour: 8,
};

describe('isInQuietWindow', () => {
  it('returns false when both null', () => {
    const prefs = { ...baseline, quietStart: null, quietEnd: null };
    expect(isInQuietWindow(utc('2026-04-30T03:00:00Z'), prefs, UTC)).toBe(false);
  });

  it('returns true when now is inside an overnight window', () => {
    expect(isInQuietWindow(utc('2026-04-30T23:30:00Z'), baseline, UTC)).toBe(true);
    expect(isInQuietWindow(utc('2026-04-30T05:00:00Z'), baseline, UTC)).toBe(true);
  });

  it('returns false when now is outside the window', () => {
    expect(isInQuietWindow(utc('2026-04-30T12:00:00Z'), baseline, UTC)).toBe(false);
    expect(isInQuietWindow(utc('2026-04-30T07:00:00Z'), baseline, UTC)).toBe(false);
  });

  it('handles a daytime window (no midnight crossing)', () => {
    const prefs = { ...baseline, quietStart: '13:00', quietEnd: '14:00' };
    expect(isInQuietWindow(utc('2026-04-30T13:30:00Z'), prefs, UTC)).toBe(true);
    expect(isInQuietWindow(utc('2026-04-30T15:00:00Z'), prefs, UTC)).toBe(false);
  });
});

describe('nextNonQuietTime', () => {
  it('returns now when not in window', () => {
    const now = utc('2026-04-30T12:00:00Z');
    expect(nextNonQuietTime(now, baseline, UTC).getTime()).toBe(now.getTime());
  });

  it('returns next quietEnd today when within window before midnight', () => {
    const now = utc('2026-04-30T23:30:00Z');
    const next = nextNonQuietTime(now, baseline, UTC);
    expect(next.toISOString()).toBe('2026-05-01T07:00:00.000Z');
  });

  it('returns quietEnd today when within window after midnight', () => {
    const now = utc('2026-04-30T05:00:00Z');
    const next = nextNonQuietTime(now, baseline, UTC);
    expect(next.toISOString()).toBe('2026-04-30T07:00:00.000Z');
  });
});

describe('isInQuietWindow — timezone aware', () => {
  it('uses the house tz wall-clock, not UTC', () => {
    // America/New_York is UTC-4 in summer (EDT). Quiet 22:00-07:00 local.
    const prefs = { ...baseline, quietStart: '22:00', quietEnd: '07:00' };
    // 2026-07-01T10:00:00Z = 06:00 EDT → INSIDE quiet window (UTC hour=10 would be outside).
    expect(isInQuietWindow(utc('2026-07-01T10:00:00Z'), prefs, NY)).toBe(true);
    // 2026-07-01T18:00:00Z = 14:00 EDT → OUTSIDE quiet window.
    expect(isInQuietWindow(utc('2026-07-01T18:00:00Z'), prefs, NY)).toBe(false);
  });
});

describe('nextNonQuietTime — timezone aware', () => {
  it('returns the next quietEnd wall-clock time in the house tz as a UTC instant', () => {
    const prefs = { ...baseline, quietStart: '22:00', quietEnd: '07:00' };
    // At 2026-07-01T02:00:00Z (22:00 EDT on Jun-30, inside window),
    // next 07:00 EDT = 2026-07-01T07:00 EDT = 2026-07-01T11:00:00Z.
    expect(nextNonQuietTime(utc('2026-07-01T02:00:00Z'), prefs, NY).toISOString()).toBe(
      '2026-07-01T11:00:00.000Z',
    );
  });
});

describe('nextNonQuietTime — across a DST change', () => {
  const CHI = 'America/Chicago';
  const prefs = { ...baseline, quietStart: '22:00', quietEnd: '07:00' };

  it('fall-back night: 07:00 CST, not 06:00 (offset read at quietEnd, not now)', () => {
    // 22:30 CDT on Oct-31; quiet ends at 07:00 CST on Nov-1 = 13:00Z.
    expect(nextNonQuietTime(utc('2026-11-01T03:30:00Z'), prefs, CHI).toISOString()).toBe(
      '2026-11-01T13:00:00.000Z',
    );
  });

  it('spring-forward night: 07:00 CDT, not 08:00', () => {
    // 22:30 CST on Mar-7; quiet ends at 07:00 CDT on Mar-8 = 12:00Z.
    expect(nextNonQuietTime(utc('2026-03-08T04:30:00Z'), prefs, CHI).toISOString()).toBe(
      '2026-03-08T12:00:00.000Z',
    );
  });

  it('quietEnd inside the spring-forward gap releases when the clock jumps past it', () => {
    // 02:30 never happens on Mar-8: at 01:45 CST the next non-quiet moment is
    // 03:00 CDT (08:00Z), not 02:30 tomorrow.
    const gapPrefs = { ...baseline, quietStart: '22:00', quietEnd: '02:30' };
    expect(nextNonQuietTime(utc('2026-03-08T07:45:00Z'), gapPrefs, CHI).toISOString()).toBe(
      '2026-03-08T08:00:00.000Z',
    );
  });

  it('quietEnd inside the repeated hour releases at its second occurrence', () => {
    // 01:15 CST is the second pass through 01:xx; the first 01:30 (CDT, 06:30Z)
    // is already past, so quiet ends at 01:30 CST (07:30Z), not tomorrow.
    const repeatPrefs = { ...baseline, quietStart: '22:00', quietEnd: '01:30' };
    expect(nextNonQuietTime(utc('2026-11-01T07:15:00Z'), repeatPrefs, CHI).toISOString()).toBe(
      '2026-11-01T07:30:00.000Z',
    );
  });
});
