/** Wall-clock calendar/clock parts for an instant in a given IANA timezone. */
export type TzParts = {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  weekday: number; // 0=Sunday .. 6=Saturday
};

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Decompose `date` into wall-clock parts in `timeZone` using Intl (no deps).
 */
export function tzParts(date: Date, timeZone: string): TzParts {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  // hour12:false yields 00-23, but some runtimes emit '24' for midnight — guard it.
  const hour = Number(parts.hour === '24' ? '00' : parts.hour);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    weekday: WEEKDAY_MAP[parts.weekday as string] ?? 0,
  };
}

/**
 * Offset of `timeZone` from UTC at `date`, in minutes (e.g. America/New_York
 * in summer → -240; Asia/Kolkata → +330). Parsed from Intl's `longOffset`
 * (`GMT±HH:MM`). Returns 0 if the format can't be parsed (degrades to UTC —
 * the safe fallback). NOTE: this is the offset AT `date`; callers converting a
 * *different* wall-clock instant accept a ≤1h skew across a DST transition.
 */
export function tzOffsetMinutes(date: Date, timeZone: string): number {
  const offsetName = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value; // e.g. 'GMT-04:00' or 'GMT+05:30'
  const m = offsetName?.match(/GMT([+-])(\d{2}):(\d{2})/);
  const sign = m?.[1] === '-' ? -1 : 1;
  return m ? sign * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

/**
 * True iff `nextDueOn`'s calendar date in `tz` is strictly before `now`'s
 * calendar date in `tz`. Due-today (any wall-clock time) returns false.
 */
export function isOverdue(nextDueOn: Date, now: Date, tz: string): boolean {
  const a = tzParts(nextDueOn, tz);
  const b = tzParts(now, tz);
  // Lex compare (year, month, day).
  if (a.year !== b.year) return a.year < b.year;
  if (a.month !== b.month) return a.month < b.month;
  return a.day < b.day;
}

/**
 * The UTC instant of 23:59:59.999 wall-clock on the calendar day that contains
 * `d` in `tz`. Used to stamp `completedOn` when a chore auto-completes at
 * end-of-due-day.
 */
export function endOfDayInTz(d: Date, tz: string): Date {
  const { year, month, day } = tzParts(d, tz);
  const offsetMinutes = tzOffsetMinutes(d, tz);
  return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999) - offsetMinutes * 60_000);
}

/** ISO-8601 week key 'YYYY-Www' for the given wall-clock parts (Thursday-based). */
export function isoWeek(parts: Pick<TzParts, 'year' | 'month' | 'day'>): string {
  const { year: y, month: m, day: d } = parts;
  const dUtc = new Date(Date.UTC(y, m - 1, d));
  const dow = dUtc.getUTCDay() || 7;
  // Shift to the Thursday of this week, THEN read the year — ISO 8601 weeks
  // belong to the year of their Thursday, so the year-start anchor and the
  // label must both use the post-shift year (they already do).
  dUtc.setUTCDate(dUtc.getUTCDate() + 4 - dow);
  const isoYear = dUtc.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const weekNum = Math.ceil(((dUtc.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(weekNum).padStart(2, '0')}`;
}
