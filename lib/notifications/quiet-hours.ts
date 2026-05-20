import type { NotificationPrefs } from './prefs';

function parseHM(hm: string): { h: number; m: number } {
  const [h, m] = hm.split(':').map(Number);
  return { h, m };
}

/**
 * Minutes-of-day for `date` in the given IANA timezone.
 * Uses Intl.DateTimeFormat only (no new dependency) — same pattern as
 * `localParts` in worker/jobs/digest-tick.ts.
 */
function minutesOfDayInTz(date: Date, timezone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  // hour12:false yields 00-23, but some runtimes emit '24' for midnight — guard it.
  const h = Number(parts.hour === '24' ? '00' : parts.hour);
  const m = Number(parts.minute);
  return h * 60 + m;
}

/**
 * Current UTC offset for the given IANA timezone, in minutes.
 * Positive = east of UTC (e.g. +05:30 → 330), negative = west (e.g. -04:00 → -240).
 * Uses the same offset-extraction technique as `startOfTodayInTz` in
 * lib/digests/queries.ts.
 */
function tzOffsetMinutes(date: Date, timezone: string): number {
  const offsetName = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value; // e.g. 'GMT-04:00' or 'GMT+05:30'
  const m = offsetName?.match(/GMT([+-])(\d{2}):(\d{2})/);
  const sign = m?.[1] === '-' ? -1 : 1;
  return m ? sign * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

/**
 * Returns true when `now` falls within the user's quiet window, evaluated
 * against the wall-clock time in `prefs.timezone`.
 */
export function isInQuietWindow(now: Date, prefs: NotificationPrefs): boolean {
  if (!prefs.quietStart || !prefs.quietEnd) return false;
  const start = parseHM(prefs.quietStart);
  const end = parseHM(prefs.quietEnd);
  const minutesNow = minutesOfDayInTz(now, prefs.timezone);
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
 * DST note: uses the current tz offset (same simplification as startOfTodayInTz
 * in lib/digests/queries.ts); a DST transition right at quietEnd would shift the
 * result by ≤1 h, which is acceptable for notification deferral.
 */
export function nextNonQuietTime(now: Date, prefs: NotificationPrefs): Date {
  if (!prefs.quietEnd || !isInQuietWindow(now, prefs)) return now;
  const end = parseHM(prefs.quietEnd);

  // Wall-clock Y/M/D in the user's timezone.
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: prefs.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now); // 'YYYY-MM-DD'
  const [y, mo, d] = ymd.split('-').map(Number) as [number, number, number];

  const offsetMins = tzOffsetMinutes(now, prefs.timezone);
  // quietEnd wall-clock time on the user's current calendar date, as UTC instant.
  let candidate = Date.UTC(y, mo - 1, d, end.h, end.m, 0) - offsetMins * 60_000;
  if (candidate <= now.getTime()) {
    // End time already passed today — advance one calendar day.
    candidate += 86_400_000;
  }
  return new Date(candidate);
}
