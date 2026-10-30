import { nextWallClockAfter, tzParts } from '@/lib/time/tz';
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
 * If `now` is inside the quiet window, return the next instant after `now` at
 * which the wall clock in the house timezone `tz` reads `quietEnd`; otherwise
 * return `now`.
 *
 * nextWallClockAfter does the DST work: it reads the offset at quietEnd itself
 * (now's offset put deferrals an hour out on transition nights), takes the
 * second pass of a repeated quietEnd once the first is behind `now`, and
 * releases a quietEnd inside a spring-forward gap when the clock jumps past it.
 */
export function nextNonQuietTime(now: Date, prefs: NotificationPrefs, tz: string): Date {
  if (!prefs.quietEnd || !isInQuietWindow(now, prefs, tz)) return now;
  const end = parseHM(prefs.quietEnd);
  return nextWallClockAfter(now, end.h, end.m, tz);
}
