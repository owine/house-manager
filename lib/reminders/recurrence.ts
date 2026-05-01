import { RRule } from 'rrule';
import type { Recurrence } from './schema';

const DAY_MS = 86_400_000;

export function computeNextDueOn(rec: Recurrence, completedOn: Date): Date {
  switch (rec.kind) {
    case 'interval':
      return new Date(completedOn.getTime() + rec.days * DAY_MS);
    case 'monthly': {
      const after = new Date(completedOn.getTime() + DAY_MS);
      const rule = new RRule({
        freq: RRule.MONTHLY,
        bymonthday: [rec.dayOfMonth],
        dtstart: after,
        count: 1,
      });
      const [next] = rule.all();
      if (!next) throw new Error('rrule returned no occurrence');
      return next;
    }
    case 'yearly': {
      const after = new Date(completedOn.getTime() + DAY_MS);
      const rule = new RRule({
        freq: RRule.YEARLY,
        bymonth: [rec.month],
        bymonthday: [rec.day],
        dtstart: after,
        count: 1,
      });
      const [next] = rule.all();
      if (!next) throw new Error('rrule returned no occurrence');
      return next;
    }
  }
}

/** Project up to N future occurrences after a starting date (used by detail view + iCal feed). */
export function previewOccurrences(rec: Recurrence, startAfter: Date, count: number): Date[] {
  const occ: Date[] = [];
  let cursor = startAfter;
  for (let i = 0; i < count; i++) {
    cursor = computeNextDueOn(rec, cursor);
    occ.push(cursor);
  }
  return occ;
}
