import { tzParts } from '@/lib/time/tz';

// Calendar dates vs instants — see the rule at the top of lib/time/tz.ts.
//
// The model returns dates as plain YYYY-MM-DD strings. They are ALREADY a day:
// parse them to UTC midnight and never run them through a timezone. Passing a
// calendar date through tzParts reads 2026-07-15T00:00:00Z as "Jul 14" in
// Chicago and every date slides back a day.
//
// The house timezone answers exactly one question: what day is it NOW. That is
// `resolveAnchorDay`, and it is the only tz use in this module.

const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a model-supplied `YYYY-MM-DD` string to UTC midnight.
 * Returns null for anything else — including a full timestamp, which would
 * indicate the model ignored its instructions.
 */
export function parseCalendarDate(value: string): Date | null {
  if (!CALENDAR_DATE_RE.test(value)) return null;

  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;

  // Reject impossible dates that Date silently rolls over (2026-02-30 -> Mar 2).
  if (d.toISOString().slice(0, 10) !== value) return null;

  return d;
}

/**
 * What calendar day is it *now* at the house? Returned as `YYYY-MM-DD` for
 * injection into the prompt, so the model resolves "Tuesday" / "last week"
 * against the right today.
 *
 * This is the one legitimate timezone use here: `now` is an instant, and an
 * instant must be read THROUGH the house timezone to find its day.
 */
export function resolveAnchorDay(now: Date, timezone: string): string {
  const { year, month, day } = tzParts(now, timezone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
