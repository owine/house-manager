import { formatCalendarDate } from '@/lib/format/date';
import type { CalendarDate } from '@/lib/time/tz';
import { isSentinelDate } from './recurrence';

/**
 * A reminder's next due date for display. A completed one-time reminder stays
 * active with the FAR_FUTURE sentinel as its due date; shown raw, that read
 * "Dec 31, 9999". Its status badge says Completed instead.
 *
 * Server-only: recurrence.ts pulls in rrule.
 */
export function formatNextDue(d: CalendarDate | null): string {
  if (d === null || isSentinelDate(d)) return '—';
  return formatCalendarDate(d);
}
