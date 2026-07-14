-- Data-only migration. No schema change.
--
-- `performedOn` and `nextDueOn` are CALENDAR DATES: a day, stored at UTC midnight.
-- Two writers put raw INSTANTS in them, leaving a time component behind. This
-- normalizes those rows. Prod audit (2026-07-14) found exactly 4:
--
--   service_records.performedOn   2 of 24   (live writer, fixed in this PR)
--   reminder_targets.nextDueOn    2 of 19   (legacy, written before toUtcMidnight
--                                            landed in #154; writer already fixed)
--
-- The `WHERE` guard is LOAD-BEARING. Rows written through the forms
-- (parseDateInput) are already correct UTC midnight; re-truncating those through a
-- timezone would shift them BACK A DAY and turn a data fix into fresh corruption.
-- Only rows carrying a non-zero time component were written as instants.

-- performedOn: these are genuine instants -- the moment a reminder was completed,
-- or an email was received. The day they belong to is the day they fell on IN THE
-- HOUSE, so interpret them in the house timezone.
--
-- `AT TIME ZONE 'UTC'` FIRST is essential. These are `timestamp` (naive) columns,
-- so without it Postgres reads the naive value AS Chicago wall-clock and runs the
-- conversion backwards -- and the result would then depend on the session's
-- TimeZone GUC, making the migration non-deterministic.
UPDATE "service_records"
SET "performedOn" = date_trunc('day', ("performedOn" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Chicago')
WHERE "performedOn" <> date_trunc('day', "performedOn");

-- nextDueOn: deliberately truncated in UTC, NOT through the house timezone.
--
-- These two rows are pre-#154 residue: a *computed future due date* whose time
-- component is an artifact of `addInterval` not truncating, not a moment anyone
-- lived through. Every UI surface renders nextDueOn with `formatCalendarDate`
-- (timeZone: 'UTC'), so the user has always seen these as their UTC day. Reading
-- them through Chicago would move each due date a day EARLIER than the date the
-- app has been showing all along. Preserve what the user sees.
UPDATE "reminder_targets"
SET "nextDueOn" = date_trunc('day', "nextDueOn")
WHERE "nextDueOn" <> date_trunc('day', "nextDueOn");
