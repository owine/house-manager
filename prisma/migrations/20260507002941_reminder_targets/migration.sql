-- Reshape Reminder from single-parent (itemId) + per-reminder due-state to
-- multi-target via ReminderTarget. Each target carries its own
-- lastCompletedOn / nextDueOn so per-target completions advance independently.
-- ReminderCompletion gains targetId (NOT NULL after backfill).
-- Backfills one item-target row per existing reminder before dropping the
-- legacy columns / indexes.

-- (a) Create the new target table + indexes + unique (NULLS NOT DISTINCT) +
-- FKs. Unique uses NULLS NOT DISTINCT (PG 15+) so duplicate
-- (reminderId, NULL, NULL) etc are rejected — Prisma 7.8 doesn't model that
-- on @@unique, but the index is enforced at the DB level and runtime
-- queries still see it.
CREATE TABLE "reminder_targets" (
    "id" TEXT NOT NULL,
    "reminderId" TEXT NOT NULL,
    "itemId" TEXT,
    "systemId" TEXT,
    "lastCompletedOn" TIMESTAMP(3),
    "nextDueOn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reminder_targets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reminder_targets_itemId_idx" ON "reminder_targets"("itemId");
CREATE INDEX "reminder_targets_systemId_idx" ON "reminder_targets"("systemId");
CREATE INDEX "reminder_targets_nextDueOn_idx" ON "reminder_targets"("nextDueOn");
CREATE INDEX "reminder_targets_reminderId_idx" ON "reminder_targets"("reminderId");
CREATE UNIQUE INDEX "reminder_targets_reminderId_itemId_systemId_key" ON "reminder_targets"("reminderId", "itemId", "systemId") NULLS NOT DISTINCT;

ALTER TABLE "reminder_targets" ADD CONSTRAINT "reminder_targets_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "reminders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reminder_targets" ADD CONSTRAINT "reminder_targets_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reminder_targets" ADD CONSTRAINT "reminder_targets_systemId_fkey" FOREIGN KEY ("systemId") REFERENCES "systems"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- (b) Add targetId to reminder_completions (nullable for now; backfilled
-- below, then made NOT NULL).
ALTER TABLE "reminder_completions" ADD COLUMN "targetId" TEXT;

-- (c) Orphan guard. The backfill assumes every existing reminder has a
-- non-null itemId (because the historical model stored a single parent
-- there). Abort loudly if any reminder is orphaned (NULL itemId) — the
-- operator must resolve those manually before re-running.
DO $$
DECLARE orphan_count INT;
BEGIN
  SELECT count(*) INTO orphan_count FROM reminders WHERE "itemId" IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'migration aborted: % reminders have NULL itemId; resolve manually before re-running', orphan_count;
  END IF;
END $$;

-- (d) Backfill one item-target row per existing reminder. Deterministic id
-- 'rt_' || reminderId so reminder_completions.targetId can be derived
-- without a join.
INSERT INTO reminder_targets (id, "reminderId", "itemId", "lastCompletedOn", "nextDueOn")
SELECT 'rt_' || id, id, "itemId", "lastCompletedOn", "nextDueOn" FROM reminders;

-- (e) Backfill targetId on reminder_completions. Each existing completion
-- belongs to the single target row created above for its reminder.
UPDATE reminder_completions rc
SET "targetId" = (SELECT id FROM reminder_targets rt WHERE rt."reminderId" = rc."reminderId");

-- (f) Lock the column down + add the FK + index now that every row has a
-- non-null targetId.
ALTER TABLE "reminder_completions" ALTER COLUMN "targetId" SET NOT NULL;
ALTER TABLE "reminder_completions" ADD CONSTRAINT "reminder_completions_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "reminder_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "reminder_completions_targetId_completedOn_idx" ON "reminder_completions"("targetId", "completedOn");

-- (g) Drop legacy reminders FK / columns / indexes now that the data has
-- moved into reminder_targets.
ALTER TABLE "reminders" DROP CONSTRAINT IF EXISTS "reminders_itemId_fkey";
DROP INDEX IF EXISTS "reminders_active_nextDueOn_idx";
DROP INDEX IF EXISTS "reminders_itemId_idx";
DROP INDEX IF EXISTS "reminders_nextDueOn_idx";
ALTER TABLE "reminders" DROP COLUMN "itemId";
ALTER TABLE "reminders" DROP COLUMN "lastCompletedOn";
ALTER TABLE "reminders" DROP COLUMN "nextDueOn";

-- (h) Enforce XOR: a target must point at exactly one of item / system.
ALTER TABLE reminder_targets
  ADD CONSTRAINT reminder_targets_parent_xor
  CHECK (("itemId" IS NULL) <> ("systemId" IS NULL));
