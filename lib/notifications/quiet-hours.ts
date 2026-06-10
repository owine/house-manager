import { tzOffsetMinutes, tzParts } from '@/lib/time/tz';
import type { NotificationPrefs } from './prefs';

function parseHM(hm: string): { h: number; m: number } {
  const [h, m] = hm.split(':').map(Number);
  return { h, m };
}

/**
 * Returns true when `now` falls within the user's quiet window, evaluated
 * against the wall-clock time in `prefs.timezone`.
 */
export function isInQuietWindow(now: Date, prefs: NotificationPrefs): boolean {
  if (!prefs.quietStart || !prefs.quietEnd) return false;
  const start = parseHM(prefs.quietStart);
  const end = parseHM(prefs.quietEnd);
  const { hour, minute } = tzParts(now, prefs.timezone);
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
 * the next `quietEnd` wall-clock time in `prefs.timezone`; otherwise return `now`.
 *
 * DST note: uses the current tz offset (same simplification as
 * endOfCalendarDayInTz in lib/time/tz.ts); a DST transition right at quietEnd
 * would shift the result by ≤1 h, which is acceptable for notification deferral.
 */
export function nextNonQuietTime(now: Date, prefs: NotificationPrefs): Date {
  if (!prefs.quietEnd || !isInQuietWindow(now, prefs)) return now;
  const end = parseHM(prefs.quietEnd);

  // Wall-clock Y/M/D in the user's timezone.
  const { year: y, month: mo, day: d } = tzParts(now, prefs.timezone);
  const offsetMins = tzOffsetMinutes(now, prefs.timezone);
  // quietEnd wall-clock time on the user's current calendar date, as UTC instant.
  let candidate = Date.UTC(y, mo - 1, d, end.h, end.m, 0) - offsetMins * 60_000;
  if (candidate <= now.getTime()) {
    // End time already passed today — advance one calendar day.
    candidate += 86_400_000;
  }
  return new Date(candidate);
}
