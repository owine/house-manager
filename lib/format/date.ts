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

/**
 * Convert a calendar Date into the YYYY-MM-DD format that
 * `<input type="date">` expects for its `value` prop. Returns '' for
 * null/undefined so the input renders as empty.
 */
export function toDateInputValue(d: Date | string | null | undefined): string {
  if (d === null || d === undefined) return '';
  if (typeof d === 'string') return d.length >= 10 ? d.slice(0, 10) : d;
  return d.toISOString().slice(0, 10);
}

/**
 * Parse a `<input type="date">` value (always YYYY-MM-DD) into a Date
 * anchored at UTC midnight. Returns null for empty strings so callers
 * can pass through to nullable schema fields. The `T00:00:00Z` suffix
 * makes the UTC interpretation explicit (the spec parses bare YYYY-MM-DD
 * as UTC anyway, but this is self-documenting).
 */
export function parseDateInput(value: string): Date | null {
  if (!value) return null;
  return new Date(`${value}T00:00:00Z`);
}
