-- Reshape Warranty from single-parent (itemId) to multi-target via
-- WarrantyTarget. Backfills one item-target row per existing warranty before
-- dropping the legacy column.

-- (a) Create the new target table + indexes + unique
CREATE TABLE "warranty_targets" (
    "id" TEXT NOT NULL,
    "warrantyId" TEXT NOT NULL,
    "itemId" TEXT,
    "systemId" TEXT,

    CONSTRAINT "warranty_targets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "warranty_targets_itemId_idx" ON "warranty_targets"("itemId");

CREATE INDEX "warranty_targets_systemId_idx" ON "warranty_targets"("systemId");

CREATE UNIQUE INDEX "warranty_targets_warrantyId_itemId_systemId_key" ON "warranty_targets"("warrantyId", "itemId", "systemId") NULLS NOT DISTINCT;

ALTER TABLE "warranty_targets" ADD CONSTRAINT "warranty_targets_warrantyId_fkey" FOREIGN KEY ("warrantyId") REFERENCES "warranties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warranty_targets" ADD CONSTRAINT "warranty_targets_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warranty_targets" ADD CONSTRAINT "warranty_targets_systemId_fkey" FOREIGN KEY ("systemId") REFERENCES "systems"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- (b) Backfill one item-target row per existing warranty (deterministic id 'wt_' + warranty id)
INSERT INTO warranty_targets (id, "warrantyId", "itemId")
SELECT 'wt_' || id, id, "itemId" FROM warranties WHERE "itemId" IS NOT NULL;

-- (c) Drop the legacy FK + column + index on warranties
ALTER TABLE warranties DROP CONSTRAINT IF EXISTS "warranties_itemId_fkey";
ALTER TABLE warranties DROP COLUMN "itemId";
DROP INDEX IF EXISTS "warranties_itemId_idx";

-- (d) Enforce XOR: a target must point at exactly one of item / system
ALTER TABLE warranty_targets
  ADD CONSTRAINT warranty_targets_parent_xor
  CHECK (("itemId" IS NULL) <> ("systemId" IS NULL));
