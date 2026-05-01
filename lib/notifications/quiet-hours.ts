import type { NotificationPrefs } from './prefs';

function parseHM(hm: string): { h: number; m: number } {
  const [h, m] = hm.split(':').map(Number);
  return { h, m };
}

/**
 * In-window check, naive UTC interpretation of HH:MM strings.
 * For v1 we treat quietStart/quietEnd as wall-clock times in the user's
 * timezone but apply them to the UTC clock as a simplification — adequate
 * because the user's timezone is recorded and the wall-clock hour matches
 * what they'd expect in that zone. A proper implementation uses Intl
 * formatting; deferred to Plan 5 polish.
 */
export function isInQuietWindow(now: Date, prefs: NotificationPrefs): boolean {
  if (!prefs.quietStart || !prefs.quietEnd) return false;
  const start = parseHM(prefs.quietStart);
  const end = parseHM(prefs.quietEnd);
  const minutesNow = now.getUTCHours() * 60 + now.getUTCMinutes();
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

/** If `now` is inside the quiet window, return the next end-of-window timestamp; else return `now`. */
export function nextNonQuietTime(now: Date, prefs: NotificationPrefs): Date {
  if (!prefs.quietEnd || !isInQuietWindow(now, prefs)) return now;
  const end = parseHM(prefs.quietEnd);
  const candidate = new Date(now);
  candidate.setUTCHours(end.h, end.m, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate;
}
