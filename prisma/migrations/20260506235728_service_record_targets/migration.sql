-- Reshape ServiceRecord from single-parent (itemId) to multi-target via
-- ServiceRecordTarget. Backfills one item-target row per existing record before
-- dropping the legacy column.

-- (a) Create the new target table + indexes + unique
CREATE TABLE "service_record_targets" (
    "id" TEXT NOT NULL,
    "serviceRecordId" TEXT NOT NULL,
    "itemId" TEXT,
    "systemId" TEXT,

    CONSTRAINT "service_record_targets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "service_record_targets_itemId_idx" ON "service_record_targets"("itemId");

CREATE INDEX "service_record_targets_systemId_idx" ON "service_record_targets"("systemId");

CREATE UNIQUE INDEX "service_record_targets_serviceRecordId_itemId_systemId_key" ON "service_record_targets"("serviceRecordId", "itemId", "systemId") NULLS NOT DISTINCT;

ALTER TABLE "service_record_targets" ADD CONSTRAINT "service_record_targets_serviceRecordId_fkey" FOREIGN KEY ("serviceRecordId") REFERENCES "service_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "service_record_targets" ADD CONSTRAINT "service_record_targets_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "service_record_targets" ADD CONSTRAINT "service_record_targets_systemId_fkey" FOREIGN KEY ("systemId") REFERENCES "systems"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- (b) Backfill one item-target row per existing record (deterministic id 'srt_' + record id)
INSERT INTO service_record_targets (id, "serviceRecordId", "itemId")
SELECT 'srt_' || id, id, "itemId" FROM service_records WHERE "itemId" IS NOT NULL;

-- (c) Drop the legacy FK + column + index on service_records
ALTER TABLE service_records DROP CONSTRAINT IF EXISTS "service_records_itemId_fkey";
ALTER TABLE service_records DROP COLUMN "itemId";
DROP INDEX IF EXISTS "service_records_itemId_idx";

-- (d) Enforce XOR: a target must point at exactly one of item / system
ALTER TABLE service_record_targets
  ADD CONSTRAINT service_record_targets_parent_xor
  CHECK (("itemId" IS NULL) <> ("systemId" IS NULL));
