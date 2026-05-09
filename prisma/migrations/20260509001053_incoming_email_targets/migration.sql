-- Reshape IncomingEmail to multi-target via incoming_email_targets, mirroring
-- the ServiceRecord/Warranty/Reminder pattern from the Systems plan. Existing
-- single-FK rows are backfilled into target rows before the columns drop.

-- 1. CreateTable + indexes
CREATE TABLE "incoming_email_targets" (
    "id" TEXT NOT NULL,
    "incomingEmailId" TEXT NOT NULL,
    "itemId" TEXT,
    "systemId" TEXT,

    CONSTRAINT "incoming_email_targets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "incoming_email_targets_itemId_idx" ON "incoming_email_targets"("itemId");
CREATE INDEX "incoming_email_targets_systemId_idx" ON "incoming_email_targets"("systemId");

-- NULLS NOT DISTINCT on the unique index so duplicates like
-- (email, itemId, NULL) and (email, NULL, systemId) are rejected. Prisma 7.8
-- doesn't model NULLS NOT DISTINCT on @@unique, so set it directly here.
CREATE UNIQUE INDEX "incoming_email_targets_incomingEmailId_itemId_systemId_key"
  ON "incoming_email_targets" ("incomingEmailId", "itemId", "systemId")
  NULLS NOT DISTINCT;

-- 2. Backfill existing single-FK rows. Use a deterministic id prefix so a
--    re-run on the same data is idempotent (collisions impossible vs.
--    Prisma-generated cuids which carry their own prefix).
INSERT INTO "incoming_email_targets" (id, "incomingEmailId", "itemId", "systemId")
SELECT 'iet_' || id, id, "itemId", NULL
  FROM "incoming_emails"
 WHERE "itemId" IS NOT NULL;

INSERT INTO "incoming_email_targets" (id, "incomingEmailId", "itemId", "systemId")
SELECT 'iet_sys_' || id, id, NULL, "systemId"
  FROM "incoming_emails"
 WHERE "systemId" IS NOT NULL;

-- 3. Drop the old single-FK columns + indexes from incoming_emails.
ALTER TABLE "incoming_emails" DROP CONSTRAINT "incoming_emails_itemId_fkey";
ALTER TABLE "incoming_emails" DROP CONSTRAINT "incoming_emails_systemId_fkey";
DROP INDEX "incoming_emails_itemId_idx";
DROP INDEX "incoming_emails_systemId_idx";
ALTER TABLE "incoming_emails" DROP COLUMN "itemId", DROP COLUMN "systemId";

-- 4. Foreign keys for the new target rows.
ALTER TABLE "incoming_email_targets" ADD CONSTRAINT "incoming_email_targets_incomingEmailId_fkey"
  FOREIGN KEY ("incomingEmailId") REFERENCES "incoming_emails"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "incoming_email_targets" ADD CONSTRAINT "incoming_email_targets_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "incoming_email_targets" ADD CONSTRAINT "incoming_email_targets_systemId_fkey"
  FOREIGN KEY ("systemId") REFERENCES "systems"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. XOR CHECK: each target row must reference exactly one of itemId/systemId.
ALTER TABLE "incoming_email_targets" ADD CONSTRAINT "IncomingEmailTarget_parent_xor"
  CHECK (("itemId" IS NULL) <> ("systemId" IS NULL));
