import { RRule } from 'rrule';
import type { Recurrence } from './schema';

const DAY_MS = 86_400_000;

// Far-future sentinel for one-shot reminders. After a `once` reminder fires,
// reminders-tick rolls its nextDueOn forward via computeNextDueOn; returning
// year 9999 guarantees it never re-enters the lead-time window. NotificationLog
// already dedupes the first cycle so the reminder fires exactly once.
const FAR_FUTURE = new Date('9999-12-31T00:00:00.000Z');

export function computeNextDueOn(rec: Recurrence, completedOn: Date): Date {
  switch (rec.kind) {
    case 'once':
      return FAR_FUTURE;
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
  // `once` reminders have no future occurrences — the caller already includes
  // the single nextDueOn; we'd otherwise emit FAR_FUTURE repeatedly.
  if (rec.kind === 'once') return [];
  const occ: Date[] = [];
  let cursor = startAfter;
  for (let i = 0; i < count; i++) {
    cursor = computeNextDueOn(rec, cursor);
    occ.push(cursor);
  }
  return occ;
}
