-- Normalize legacy interval recurrence { kind:'interval', days:N }
-- to the unit-based shape { kind:'interval', every:N, unit:'day' }.
-- The recurrence column is JSONB; parseRecurrence() also shims this at read
-- time, so this rewrite is belt-and-suspenders for stored rows.
UPDATE "reminders"
SET "recurrence" = ("recurrence" - 'days')
  || jsonb_build_object('every', ("recurrence"->'days'), 'unit', to_jsonb('day'::text))
WHERE "recurrence"->>'kind' = 'interval'
  AND "recurrence" ? 'days';
