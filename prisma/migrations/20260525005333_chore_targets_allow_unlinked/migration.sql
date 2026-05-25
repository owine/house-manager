-- Chores may have zero item/system links. The previous XOR constraint
-- enforced "exactly one set"; relax to "at most one set" so a chore can
-- own a single standalone ReminderTarget (both itemId and systemId NULL)
-- to carry its schedule + completion history.
--
-- The NULLS NOT DISTINCT unique on (reminderId, itemId, systemId) already
-- caps standalone rows at one per reminder.
--
-- "Only CHORE parents may own a both-NULL row" is enforced in the server
-- (lib/reminders/actions.ts reconciliation + lib/reminders/schema.ts
-- discriminated union), not via a cross-table trigger.

ALTER TABLE "reminder_targets" DROP CONSTRAINT "reminder_targets_parent_xor";

ALTER TABLE "reminder_targets"
  ADD CONSTRAINT "reminder_targets_parent_at_most_one"
  CHECK (NOT ("itemId" IS NOT NULL AND "systemId" IS NOT NULL));
