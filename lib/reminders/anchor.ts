import type { Recurrence } from './schema';

/** Format a Date as YYYY-MM-DD in UTC. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * For weekly recurrences with interval > 1, stamp a stable `anchor` (the seed
 * due date) so bi-weekly+ parity does not drift across completions. All other
 * recurrences (and interval === 1 weekly) are returned unchanged.
 */
export function withWeeklyAnchor(rec: Recurrence, seedDueOn: Date): Recurrence {
  if (rec.kind !== 'weekly' || rec.interval <= 1) return rec;
  return { ...rec, anchor: isoDate(seedDueOn) };
}
