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

// Building an Intl.DateTimeFormat costs far more than formatting with one, and
// endOfCalendarDayInTz calls tzParts ~30 times per stamp. One per zone.
const PARTS_FORMATS = new Map<string, Intl.DateTimeFormat>();
const OFFSET_FORMATS = new Map<string, Intl.DateTimeFormat>();

function cachedFormat(
  cache: Map<string, Intl.DateTimeFormat>,
  locale: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  let format = cache.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { timeZone, ...options });
    cache.set(timeZone, format);
  }
  return format;
}

/**
 * Decompose `date` into wall-clock parts in `timeZone` using Intl (no deps).
 */
export function tzParts(date: Instant, timeZone: string): TzParts {
  const parts = Object.fromEntries(
    cachedFormat(PARTS_FORMATS, 'en-CA', timeZone, {
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
 * the safe fallback). This is the offset AT `date`. To turn a wall-clock time
 * into an instant, use wallClockToUtc, which reads it at the target instead.
 */
export function tzOffsetMinutes(date: Date, timeZone: string): number {
  const offsetName = cachedFormat(OFFSET_FORMATS, 'en-US', timeZone, { timeZoneName: 'longOffset' })
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

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

type WallClock = Pick<TzParts, 'year' | 'month' | 'day' | 'hour' | 'minute'>;

/**
 * Every instant at which the wall clock in `tz` reads `wall`, earliest first.
 * Usually one; two when fall-back repeats the time. A time inside a
 * spring-forward gap never appears on the clock, so it resolves to the jump
 * past it: the first instant the clock reads later than `wall`. That is when
 * a wall-clock window ending at `wall` actually ends.
 *
 * Each candidate offset is checked at the instant it produces, so nothing
 * here reads the offset at some other instant (`now`, the day's midnight),
 * which is off by the DST shift whenever a transition falls in between.
 */
function instantsAtWallClock(wall: WallClock, tz: string): number[] {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  // Offsets either side of any transition near this date. Assumes no zone
  // changes its offset twice within two days, which none does.
  const earlier = tzOffsetMinutes(new Date(naive - DAY_MS), tz);
  const later = tzOffsetMinutes(new Date(naive + DAY_MS), tz);
  if (earlier === later) return [naive - earlier * 60_000];

  // A candidate counts only if the zone really is on that offset there. Both
  // count only in an overlap, where `earlier` > `later`, so this is in order.
  const found: number[] = [];
  for (const offset of [earlier, later]) {
    const t = naive - offset * 60_000;
    if (tzOffsetMinutes(new Date(t), tz) === offset) found.push(t);
  }
  if (found.length > 0) return found;

  // Gap: `lo` reads before the gap on the old offset, `hi` past it on the new.
  // Bisect for the transition, the first instant on the new offset.
  let lo = naive - later * 60_000;
  let hi = naive - earlier * 60_000;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (tzOffsetMinutes(new Date(mid), tz) === later) hi = mid;
    else lo = mid;
  }
  return [hi];
}

/**
 * The UTC instant at which the wall clock in `tz` reads `wall`: the first
 * occurrence of a time fall-back repeats, the jump past a time inside a
 * spring-forward gap.
 */
export function wallClockToUtc(wall: WallClock, tz: string): Date {
  return new Date(instantsAtWallClock(wall, tz)[0]);
}

/**
 * The first instant strictly after `after` at which the wall clock in `tz`
 * reads `hour`:`minute` (resolved as in wallClockToUtc). Steps days by
 * calendar date, not by 24h, which is a 23h or 25h day across a transition.
 * Tomorrow's occurrence is always after `after`, so two days suffice.
 */
export function nextWallClockAfter(after: Date, hour: number, minute: number, tz: string): Date {
  const { year, month, day } = tzParts(after, tz);
  for (const offsetDays of [0, 1]) {
    // Date.UTC rolls month/year overflow, so day + 1 is safe at month end.
    const d = new Date(Date.UTC(year, month - 1, day + offsetDays));
    const wall = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    const t = instantsAtWallClock({ ...wall, hour, minute }, tz).find((i) => i > after.getTime());
    if (t !== undefined) return new Date(t);
  }
  throw new Error(`nextWallClockAfter: no ${hour}:${minute} after ${after.toISOString()} in ${tz}`);
}

/**
 * The last millisecond of the house day that `calendarDate` represents (a
 * date-only value stored at UTC midnight). Used to stamp `completedOn` when a
 * chore auto-completes at end-of-due-day.
 *
 * Found as "1 ms before the next house day begins", by bisecting for that
 * beginning -- not as 23:59:59.999 minus an offset. The offset changes during
 * a transition day, and in zones that switch at midnight the next 00:00 may
 * not exist (Havana) or 23:59 may happen twice (Santiago), so no single offset
 * is right. Offset arithmetic here once stamped spring-forward completions at
 * 00:59 the NEXT day.
 */
export function endOfCalendarDayInTz(calendarDate: CalendarDate, tz: string): Date {
  assertCalendarDate(calendarDate, 'endOfCalendarDayInTz');
  const tomorrow = calendarDate.getTime() + DAY_MS;
  // UTC offsets run from -12h to +14h, so `before` is still this day (or
  // earlier) in every zone and `after` is already tomorrow in every zone.
  let before = tomorrow - 16 * HOUR_MS;
  let after = tomorrow + 14 * HOUR_MS;
  while (after - before > 1) {
    const mid = before + Math.floor((after - before) / 2);
    if (startOfDayUtc(new Date(mid), tz).getTime() >= tomorrow) after = mid;
    else before = mid;
  }
  return new Date(before);
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
