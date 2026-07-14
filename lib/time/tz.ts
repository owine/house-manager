/** Wall-clock calendar/clock parts for an instant in a given IANA timezone. */
export type TzParts = {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  weekday: number; // 0=Sunday .. 6=Saturday
};

/**
 * ===========================================================================
 *  The one rule. Everything in this module follows from it.
 * ===========================================================================
 *
 *  | Value                                    | What it is      | Correct handling                          |
 *  |------------------------------------------|-----------------|-------------------------------------------|
 *  | now, completedOn, receivedAt, occurredAt | an INSTANT      | Interpret it THROUGH the house tz to find |
 *  |                                          |                 | out what day it is: startOfDayUtc(now, tz) |
 *  | nextDueOn, endsOn, performedOn, ...      | a CALENDAR DATE | It is ALREADY a day. Read it in UTC.      |
 *  |                                          |                 | NEVER run it through a tz.                |
 *
 *  The house tz answers "what day is it NOW". It must never reinterpret a value
 *  that is already a day. `tzParts(nextDueOn, tz)` reads 2026-07-15T00:00:00Z as
 *  "Jul 14" in Chicago -- every due date slides back a day. That single mistake,
 *  in both directions, accounted for fifteen bugs and eight separate fixes.
 *
 *  The types below make it a compile error.
 */

declare const CalendarDateBrand: unique symbol;

/**
 * A date-only value: a DAY. Backed by a Postgres `date` column, so it always
 * arrives at UTC midnight. NOT an instant.
 *
 * The brand is erased at build time -- it exists purely so the compiler can stop
 * you running a day through a timezone, or handing an instant to something that
 * wants a day.
 */
export type CalendarDate = Date & { readonly [CalendarDateBrand]: true };

/**
 * A real moment in time. Structurally just a `Date`, but the optional never-valued
 * brand slot makes a `CalendarDate` NOT assignable to it -- which is the whole
 * trick.
 *
 * NOTE: the obvious alternative does NOT work:
 *
 *     export function tzParts(d: CalendarDate, tz: string): never;   // USELESS
 *     export function tzParts(instant: Date, tz: string): TzParts;
 *
 * Overload resolution picks the first signature and returns `never` -- but `never`
 * is assignable to everything, so the call site compiles clean. Verified under
 * --strict: it catches nothing. It LOOKS like a guard and is not one.
 */
export type Instant = Date & { readonly [CalendarDateBrand]?: never };

/** Build a CalendarDate from Y/M/D. `month` is 1-12. */
export function calendarDate(year: number, month: number, day: number): CalendarDate {
  return new Date(Date.UTC(year, month - 1, day)) as CalendarDate;
}

/**
 * Brand an existing Date as a CalendarDate, asserting it really is UTC-midnight.
 * The Prisma client (lib/db.ts) applies this at the DB boundary, so application
 * code should rarely need it.
 */
export function asCalendarDate(d: Date): CalendarDate {
  assertCalendarDate(d, 'asCalendarDate');
  return d as CalendarDate;
}

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
export function tzParts(date: Instant, timeZone: string): TzParts {
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

/** Normalize a date-only value to UTC midnight (its calendar date, in UTC). */
export function utcMidnight(d: Instant): CalendarDate {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) as CalendarDate;
}

/**
 * Dev/test guard: date-only values (nextDueOn, purchaseDate, …) must be stored
 * at UTC midnight (see `computeNextDueOn` → `toUtcMidnight` and
 * `lib/format/date.ts`). A stray time component would be silently collapsed to
 * its UTC calendar day here, so fail fast outside production to surface misuse.
 */
function assertCalendarDate(d: Date, fn: string): void {
  if (process.env.NODE_ENV === 'production') return;
  if (utcMidnight(d).getTime() !== d.getTime()) {
    throw new Error(
      `${fn}: expected a UTC-midnight date-only value, got ${d.toISOString()} ` +
        '(see toUtcMidnight / lib/format/date.ts)',
    );
  }
}

/**
 * UTC-midnight anchor of the calendar day that `instant` falls on in `tz`.
 *
 * This is the date-only ("calendar date") representation to compare against
 * `nextDueOn`, which is itself stored at UTC midnight (see `computeNextDueOn` →
 * `toUtcMidnight` and `lib/format/date.ts`). Use as the `{ lt: ... }` cutoff for
 * "due before today (house tz)" queries.
 *
 * Unlike a tz-local-midnight *instant*, this does NOT apply the tz offset to the
 * result: a due-today value stored at UTC midnight must compare equal to today's
 * anchor, not earlier — otherwise negative-offset zones flag due-today as overdue.
 */
export function startOfDayUtc(instant: Instant, tz: string): CalendarDate {
  const { year, month, day } = tzParts(instant, tz);
  return new Date(Date.UTC(year, month - 1, day)) as CalendarDate;
}

/**
 * True iff `nextDueOn`'s calendar date is strictly before the calendar date that
 * `now` falls on in `tz`. `nextDueOn` is a date-only value stored at UTC midnight,
 * so its calendar date is read in UTC; `now` is a real instant whose "today" is
 * read in the house timezone. Due-today (in tz) returns false — and "today" flips
 * at house-local midnight, not UTC midnight.
 */
export function isOverdue(nextDueOn: CalendarDate, now: Instant, tz: string): boolean {
  // The brand is a COMPILE-time guarantee; this is the runtime net for anything
  // that reached here through a cast. Defence in depth -- keep both.
  assertCalendarDate(nextDueOn, 'isOverdue');
  // No utcMidnight() wrap: a CalendarDate is already UTC midnight by construction.
  // (The brand is what surfaced that the old call was redundant.)
  return nextDueOn.getTime() < startOfDayUtc(now, tz).getTime();
}

/**
 * The UTC instant of 23:59:59.999 wall-clock in `tz` on the calendar date that
 * `calendarDate` represents (a date-only value stored at UTC midnight). Used to
 * stamp `completedOn` when a chore auto-completes at end-of-due-day.
 *
 * NOTE: the timezone offset is evaluated at `calendarDate` (UTC midnight), not at
 * 23:59:59. On a DST transition day the result may be off by ≤1h — acceptable for
 * a `completedOn` stamp.
 */
export function endOfCalendarDayInTz(calendarDate: CalendarDate, tz: string): Date {
  assertCalendarDate(calendarDate, 'endOfCalendarDayInTz');
  const year = calendarDate.getUTCFullYear();
  const month = calendarDate.getUTCMonth();
  const day = calendarDate.getUTCDate();
  const offsetMinutes = tzOffsetMinutes(calendarDate, tz);
  return new Date(Date.UTC(year, month, day, 23, 59, 59, 999) - offsetMinutes * 60_000);
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
