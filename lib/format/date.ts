/**
 * Format a calendar date (conceptually a date, not a timestamp).
 * Calendar dates are stored as UTC midnight and should always display
 * as the UTC date, regardless of the viewer's timezone.
 *
 * @param d - Date object, ISO string, null, or undefined
 * @returns Formatted date string (e.g., "Jan 15, 2024") or empty string if null/undefined
 */
export function formatCalendarDate(d: Date | string | null | undefined): string {
  if (d === null || d === undefined) {
    return '';
  }

  const date = typeof d === 'string' ? new Date(d) : d;

  return date.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
