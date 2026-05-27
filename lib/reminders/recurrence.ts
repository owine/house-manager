// rrule@2.8.1 has no `exports` field in its package.json, so under Node ESM
// the named import `import { RRule } from 'rrule'` fails with "does not provide
// an export named 'RRule'". Next.js/Webpack hides this via bundler interop, but
// the worker container (tsx worker/index.ts) hits raw ESM and crashes on
// startup. Default-import-then-destructure is the standard workaround. The
// `type Weekday` import is erased at compile time and is unaffected.
import type { Weekday } from 'rrule';
import rrulePkg from 'rrule';
import type { Recurrence } from './schema';

const { RRule } = rrulePkg;

const DAY_MS = 86_400_000;
export const FAR_FUTURE = new Date('9999-12-31T00:00:00.000Z');

/** True when a date is the "never re-fires" sentinel a completed one-shot carries. */
export function isSentinelDate(d: Date): boolean {
  return d.getTime() === FAR_FUTURE.getTime();
}
// Worst case is ~50 steps (small day-interval across a multi-month off-season); 1000 is a fail-loud ceiling.
const SKIP_CAP = 1000;

// Map JS weekday (0=Sun..6=Sat) -> rrule Weekday objects. rrule's own numbering
// is Mon=0..Sun=6, so NEVER pass a raw JS integer to byweekday; index this map.
const RRULE_WEEKDAY: Weekday[] = [
  RRule.SU, // 0
  RRule.MO, // 1
  RRule.TU, // 2
  RRule.WE, // 3
  RRule.TH, // 4
  RRule.FR, // 5
  RRule.SA, // 6
];

function inSeason(date: Date, activeMonths: number[] | undefined): boolean {
  if (!activeMonths) return true;
  return activeMonths.includes(date.getUTCMonth() + 1);
}

/** Add whole months to a UTC date, clamping the day to the target month's length. */
function addMonthsClamped(from: Date, months: number): Date {
  const day = from.getUTCDate();
  const target = new Date(from.getTime());
  // Move to the 1st first so setUTCMonth never overflows into the next month.
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

/** Next occurrence of (month, day) strictly after `after`, clamping day to month length. */
function nextYearlyDate(after: Date, month: number, day: number): Date {
  for (let year = after.getUTCFullYear(); ; year++) {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate(); // day 0 of next month
    const cand = new Date(Date.UTC(year, month - 1, Math.min(day, lastDay)));
    if (cand.getTime() > after.getTime()) return cand;
  }
}

/** `from` advanced by `every` whole units, calendar-aware (months/years clamp). */
function addInterval(from: Date, every: number, unit: 'day' | 'week' | 'month' | 'year'): Date {
  switch (unit) {
    case 'day':
      return new Date(from.getTime() + every * DAY_MS);
    case 'week':
      return new Date(from.getTime() + every * 7 * DAY_MS);
    case 'month':
      return addMonthsClamped(from, every);
    case 'year':
      return addMonthsClamped(from, every * 12);
  }
}

/**
 * First occurrence strictly after `completedOn` for a CALENDAR-anchored kind
 * (weekly/monthly/monthlyWeekday/yearly). These pin to a calendar slot via
 * `byXXX` rules, so seeding `dtstart = completedOn + DAY_MS` and taking the
 * first occurrence is correct.
 */
function firstAfter(
  opts: Partial<ConstructorParameters<typeof RRule>[0]>,
  completedOn: Date,
): Date {
  const after = new Date(completedOn.getTime() + DAY_MS);
  const rule = new RRule({ ...opts, dtstart: after, count: 1 });
  const [next] = rule.all();
  if (!next) throw new Error('rrule returned no occurrence');
  return next;
}

/** Zero the time-of-day (UTC) so a due value is a pure calendar date. */
function toUtcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function computeNextDueOn(rec: Recurrence, completedOn: Date): Date {
  let next: Date;
  switch (rec.kind) {
    case 'once':
      next = FAR_FUTURE;
      break;
    case 'interval': {
      const step = (from: Date): Date => addInterval(from, rec.every, rec.unit);
      next = step(completedOn);
      for (let i = 0; !inSeason(next, rec.activeMonths); i++) {
        if (i >= SKIP_CAP)
          throw new Error(
            `seasonality skip-loop exceeded cap (${SKIP_CAP}); recurrence=${JSON.stringify(rec)} completedOn=${completedOn.toISOString()}`,
          );
        next = step(next);
      }
      break;
    }
    case 'weekly': {
      const byweekday = rec.weekdays.map((d) => RRULE_WEEKDAY[d]);
      if (rec.interval > 1) {
        const anchor = rec.anchor ? new Date(`${rec.anchor}T00:00:00.000Z`) : completedOn;
        const rule = new RRule({
          freq: RRule.WEEKLY,
          interval: rec.interval,
          byweekday,
          dtstart: anchor,
          ...(rec.activeMonths ? { bymonth: rec.activeMonths } : {}),
        });
        const after = rule.after(completedOn, /* inc */ false);
        if (!after) throw new Error('rrule returned no weekly occurrence');
        next = after;
      } else {
        next = firstAfter(
          {
            freq: RRule.WEEKLY,
            byweekday,
            ...(rec.activeMonths ? { bymonth: rec.activeMonths } : {}),
          },
          completedOn,
        );
      }
      break;
    }
    case 'monthly': {
      const bymonthday = [...rec.days, ...(rec.last ? [-1] : [])];
      next = firstAfter(
        {
          freq: RRule.MONTHLY,
          bymonthday,
          ...(rec.activeMonths ? { bymonth: rec.activeMonths } : {}),
        },
        completedOn,
      );
      break;
    }
    case 'monthlyWeekday':
      next = firstAfter(
        {
          freq: RRule.MONTHLY,
          byweekday: rec.combos.map((c) => RRULE_WEEKDAY[c.weekday].nth(c.week)),
          ...(rec.activeMonths ? { bymonth: rec.activeMonths } : {}),
        },
        completedOn,
      );
      break;
    case 'yearly': {
      const candidates = rec.dates.map((d) => nextYearlyDate(completedOn, d.month, d.day));
      next = candidates.reduce((min, c) => (c.getTime() < min.getTime() ? c : min));
      break;
    }
  }
  return toUtcMidnight(next);
}

/** Project up to N future occurrences after a starting date (detail view + iCal). */
export function previewOccurrences(rec: Recurrence, startAfter: Date, count: number): Date[] {
  if (rec.kind === 'once') return [];
  const occ: Date[] = [];
  let cursor = startAfter;
  for (let i = 0; i < count; i++) {
    cursor = computeNextDueOn(rec, cursor);
    occ.push(cursor);
  }
  return occ;
}
