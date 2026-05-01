import { describe, expect, it } from 'vitest';
import type { NotificationPrefs } from './prefs';
import { isInQuietWindow, nextNonQuietTime } from './quiet-hours';

const utc = (iso: string) => new Date(iso);
const baseline: NotificationPrefs = {
  pushEnabled: true,
  emailEnabled: false,
  quietStart: '22:00',
  quietEnd: '07:00',
  timezone: 'UTC',
};

describe('isInQuietWindow', () => {
  it('returns false when both null', () => {
    const prefs = { ...baseline, quietStart: null, quietEnd: null };
    expect(isInQuietWindow(utc('2026-04-30T03:00:00Z'), prefs)).toBe(false);
  });

  it('returns true when now is inside an overnight window', () => {
    expect(isInQuietWindow(utc('2026-04-30T23:30:00Z'), baseline)).toBe(true);
    expect(isInQuietWindow(utc('2026-04-30T05:00:00Z'), baseline)).toBe(true);
  });

  it('returns false when now is outside the window', () => {
    expect(isInQuietWindow(utc('2026-04-30T12:00:00Z'), baseline)).toBe(false);
    expect(isInQuietWindow(utc('2026-04-30T07:00:00Z'), baseline)).toBe(false);
  });

  it('handles a daytime window (no midnight crossing)', () => {
    const prefs = { ...baseline, quietStart: '13:00', quietEnd: '14:00' };
    expect(isInQuietWindow(utc('2026-04-30T13:30:00Z'), prefs)).toBe(true);
    expect(isInQuietWindow(utc('2026-04-30T15:00:00Z'), prefs)).toBe(false);
  });
});

describe('nextNonQuietTime', () => {
  it('returns now when not in window', () => {
    const now = utc('2026-04-30T12:00:00Z');
    expect(nextNonQuietTime(now, baseline).getTime()).toBe(now.getTime());
  });

  it('returns next quietEnd today when within window before midnight', () => {
    const now = utc('2026-04-30T23:30:00Z');
    const next = nextNonQuietTime(now, baseline);
    expect(next.toISOString()).toBe('2026-05-01T07:00:00.000Z');
  });

  it('returns quietEnd today when within window after midnight', () => {
    const now = utc('2026-04-30T05:00:00Z');
    const next = nextNonQuietTime(now, baseline);
    expect(next.toISOString()).toBe('2026-04-30T07:00:00.000Z');
  });
});
