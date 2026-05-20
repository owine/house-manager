import { RRule, type Weekday } from 'rrule';
import type { Recurrence } from './schema';

const DAY_MS = 86_400_000;
const FAR_FUTURE = new Date('9999-12-31T00:00:00.000Z');
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

/**
 * `completedOn` advanced by `every` whole units (week/month/year), calendar-
 * aware. IMPORTANT: rrule's `interval` only spaces occurrences APART; it does
 * NOT offset the first one — occurrence #0 is always `dtstart`. So anchor at
 * `from` and take occurrence #1 (= from + interval).
 */
function addUnits(from: Date, every: number, freq: number): Date {
  const rule = new RRule({ freq, interval: every, dtstart: from, count: 2 });
  const occ = rule.all();
  if (occ.length < 2) throw new Error('rrule returned no occurrence');
  return occ[1];
}

export function computeNextDueOn(rec: Recurrence, completedOn: Date): Date {
  switch (rec.kind) {
    case 'once':
      return FAR_FUTURE;
    case 'interval': {
      const step = (from: Date): Date => {
        if (rec.unit === 'day') return new Date(from.getTime() + rec.every * DAY_MS);
        const freq =
          rec.unit === 'week' ? RRule.WEEKLY : rec.unit === 'month' ? RRule.MONTHLY : RRule.YEARLY;
        return addUnits(from, rec.every, freq);
      };
      let next = step(completedOn);
      for (let i = 0; !inSeason(next, rec.activeMonths); i++) {
        if (i >= SKIP_CAP) throw new Error('seasonality skip-loop exceeded cap');
        next = step(next);
      }
      return next;
    }
    case 'weekly':
      return firstAfter(
        {
          freq: RRule.WEEKLY,
          byweekday: rec.weekdays.map((d) => RRULE_WEEKDAY[d]),
          ...(rec.activeMonths ? { bymonth: rec.activeMonths } : {}),
        },
        completedOn,
      );
    case 'monthly':
      return firstAfter(
        {
          freq: RRule.MONTHLY,
          bymonthday: rec.dayOfMonth === 'last' ? [-1] : [rec.dayOfMonth],
          ...(rec.activeMonths ? { bymonth: rec.activeMonths } : {}),
        },
        completedOn,
      );
    case 'monthlyWeekday':
      return firstAfter(
        {
          freq: RRule.MONTHLY,
          byweekday: [RRULE_WEEKDAY[rec.weekday]],
          bysetpos: [rec.week],
          ...(rec.activeMonths ? { bymonth: rec.activeMonths } : {}),
        },
        completedOn,
      );
    case 'yearly':
      return firstAfter(
        { freq: RRule.YEARLY, bymonth: [rec.month], bymonthday: [rec.day] },
        completedOn,
      );
  }
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
