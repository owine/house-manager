/**
 * IANA timezone choices offered in the house timezone picker (Settings).
 * One house-wide timezone is the single source of truth for all calendar/clock
 * logic — overdue/due, the .ics feed, chore auto-complete, digest content and
 * scheduling, and quiet hours. See lib/house-profile + getHouseTimezone().
 */
export const TIMEZONE_OPTIONS = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Europe/London',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Australia/Sydney',
] as const;
