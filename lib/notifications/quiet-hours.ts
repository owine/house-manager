import { tzParts, wallClockToUtc } from '@/lib/time/tz';
import type { NotificationPrefs } from './prefs';

function parseHM(hm: string): { h: number; m: number } {
  const [h, m] = hm.split(':').map(Number);
  return { h, m };
}

/**
 * Returns true when `now` falls within the user's quiet window, evaluated
 * against the wall-clock time in the house timezone `tz`.
 */
export function isInQuietWindow(now: Date, prefs: NotificationPrefs, tz: string): boolean {
  if (!prefs.quietStart || !prefs.quietEnd) return false;
  const start = parseHM(prefs.quietStart);
  const end = parseHM(prefs.quietEnd);
  const { hour, minute } = tzParts(now, tz);
  const minutesNow = hour * 60 + minute;
  const minutesStart = start.h * 60 + start.m;
  const minutesEnd = end.h * 60 + end.m;

  if (minutesStart === minutesEnd) return false; // zero-length window
  if (minutesStart < minutesEnd) {
    // daytime window
    return minutesNow >= minutesStart && minutesNow < minutesEnd;
  }
  // overnight (e.g. 22:00 - 07:00)
  return minutesNow >= minutesStart || minutesNow < minutesEnd;
}

/**
 * If `now` is inside the quiet window, return the UTC instant corresponding to
 * the next `quietEnd` wall-clock time in the house timezone `tz`; otherwise
 * return `now`.
 *
 * Both candidates are converted with wallClockToUtc, which reads the offset at
 * quietEnd itself. Using now's offset, or adding 24h to step a day, put the
 * deferral an hour out on DST nights (06:00 on fall-back, 08:00 on spring-forward).
 */
export function nextNonQuietTime(now: Date, prefs: NotificationPrefs, tz: string): Date {
  if (!prefs.quietEnd || !isInQuietWindow(now, prefs, tz)) return now;
  const end = parseHM(prefs.quietEnd);

  // Wall-clock Y/M/D in the house timezone.
  const { year, month, day } = tzParts(now, tz);
  const today = wallClockToUtc({ year, month, day, hour: end.h, minute: end.m }, tz);
  if (today.getTime() > now.getTime()) return today;
  // End time already passed today: the same wall clock on the next calendar
  // day. Date.UTC rolls month/year overflow, so day + 1 is safe at month end.
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return wallClockToUtc(
    {
      year: next.getUTCFullYear(),
      month: next.getUTCMonth() + 1,
      day: next.getUTCDate(),
      hour: end.h,
      minute: end.m,
    },
    tz,
  );
}
