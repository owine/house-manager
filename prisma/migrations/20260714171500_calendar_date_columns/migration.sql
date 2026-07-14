-- Make the calendar-date columns actual Postgres `date`.
--
-- These columns hold a DAY, not an instant. Until now that was a convention held
-- only in our heads and in lib/time/tz.ts, and a `timestamp` column would happily
-- accept 8pm-with-a-time-component. `date` makes a time component structurally
-- unrepresentable, so every READ is UTC-midnight by construction.
--
-- ItemVendor.contractEndsOn / SystemVendor.contractEndsOn were already `date`.
-- This brings the rest of the calendar-date columns in line with them.
--
-- ⚠️  A `date` column does NOT reject a bad WRITE -- Prisma silently truncates an
--     instant to its UTC day, so `performedOn: new Date()` at 8pm Chicago would
--     store TOMORROW with no error. That is why this PR also adds a Prisma
--     query-extension write guard in lib/db.ts. The column type and the guard are
--     a pair; neither is sufficient alone.

-- ---------------------------------------------------------------------------
-- Step 1: normalize any row still carrying a time component.
--
-- This MUST happen before the cast. Postgres casts `timestamp` -> `date` by
-- taking the UTC day, so a value written as an instant (8pm Chicago = 01:00 the
-- next UTC day) would land on the WRONG day. Interpret those in the house
-- timezone first.
--
-- The `WHERE` guard is load-bearing: rows written through the forms
-- (parseDateInput) are already clean UTC midnight, and running THOSE through a
-- timezone would shift them BACK a day -- turning a data fix into fresh
-- corruption. Only rows with a non-zero time component were written as instants.
--
-- `AT TIME ZONE 'UTC'` comes first because these are naive `timestamp` values.
-- Without it Postgres reads them AS house-local wall-clock and runs the
-- conversion backwards, with a result that depends on the session TimeZone GUC.
--
-- service_records / reminder_targets were already handled by the preceding
-- migration, so those two are no-ops here. Repeating them keeps this migration
-- correct standalone, and the rest of the columns have never been normalized at
-- all (the prod audit found 0 dirty rows in them, but that is our database, not
-- everyone's).
-- ---------------------------------------------------------------------------

UPDATE "service_records"
SET "performedOn" = date_trunc('day', ("performedOn" AT TIME ZONE 'UTC')
      AT TIME ZONE COALESCE((SELECT "timezone" FROM "house_profile" LIMIT 1), 'UTC'))
WHERE "performedOn" <> date_trunc('day', "performedOn");

UPDATE "reminder_targets"
SET "nextDueOn" = date_trunc('day', "nextDueOn")
WHERE "nextDueOn" <> date_trunc('day', "nextDueOn");

UPDATE "warranties"
SET "startsOn" = date_trunc('day', ("startsOn" AT TIME ZONE 'UTC')
      AT TIME ZONE COALESCE((SELECT "timezone" FROM "house_profile" LIMIT 1), 'UTC'))
WHERE "startsOn" <> date_trunc('day', "startsOn");

UPDATE "warranties"
SET "endsOn" = date_trunc('day', ("endsOn" AT TIME ZONE 'UTC')
      AT TIME ZONE COALESCE((SELECT "timezone" FROM "house_profile" LIMIT 1), 'UTC'))
WHERE "endsOn" <> date_trunc('day', "endsOn");

UPDATE "items"
SET "purchaseDate" = date_trunc('day', ("purchaseDate" AT TIME ZONE 'UTC')
      AT TIME ZONE COALESCE((SELECT "timezone" FROM "house_profile" LIMIT 1), 'UTC'))
WHERE "purchaseDate" IS NOT NULL AND "purchaseDate" <> date_trunc('day', "purchaseDate");

UPDATE "systems"
SET "installDate" = date_trunc('day', ("installDate" AT TIME ZONE 'UTC')
      AT TIME ZONE COALESCE((SELECT "timezone" FROM "house_profile" LIMIT 1), 'UTC'))
WHERE "installDate" IS NOT NULL AND "installDate" <> date_trunc('day', "installDate");

UPDATE "Checklist"
SET "nextDueOn" = date_trunc('day', ("nextDueOn" AT TIME ZONE 'UTC')
      AT TIME ZONE COALESCE((SELECT "timezone" FROM "house_profile" LIMIT 1), 'UTC'))
WHERE "nextDueOn" IS NOT NULL AND "nextDueOn" <> date_trunc('day', "nextDueOn");

-- ---------------------------------------------------------------------------
-- Step 2: the cast. Every value is now UTC midnight, so `::date` is exact and
-- loses nothing. (A `USING` transform expression cannot contain a subquery,
-- which is why the house timezone had to be applied in step 1 rather than here.)
-- ---------------------------------------------------------------------------

ALTER TABLE "service_records"  ALTER COLUMN "performedOn"  TYPE date USING "performedOn"::date;
ALTER TABLE "reminder_targets" ALTER COLUMN "nextDueOn"    TYPE date USING "nextDueOn"::date;
ALTER TABLE "warranties"       ALTER COLUMN "startsOn"     TYPE date USING "startsOn"::date,
                               ALTER COLUMN "endsOn"       TYPE date USING "endsOn"::date;
ALTER TABLE "items"            ALTER COLUMN "purchaseDate" TYPE date USING "purchaseDate"::date;
ALTER TABLE "systems"          ALTER COLUMN "installDate"  TYPE date USING "installDate"::date;
ALTER TABLE "Checklist"        ALTER COLUMN "nextDueOn"    TYPE date USING "nextDueOn"::date;
