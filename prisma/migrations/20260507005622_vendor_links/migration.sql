-- Add VendorRole enum + ItemVendor / SystemVendor link tables. Each link
-- references either a stored Vendor (vendorId) or a freeform name
-- (freeformName), enforced by a XOR CHECK constraint at the DB level.
-- Vendor FK uses ON DELETE RESTRICT so deletes can't silently NULL the
-- vendorId and break the XOR; Task 7 will add the user-mediated delete flow.
-- No backfill: both tables start empty.

-- CreateEnum
CREATE TYPE "VendorRole" AS ENUM ('PURCHASE', 'INSTALLER', 'SERVICE', 'WARRANTY_PROVIDER', 'MANUFACTURER', 'OTHER');

-- CreateTable
CREATE TABLE "item_vendors" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "vendorId" TEXT,
    "freeformName" TEXT,
    "role" "VendorRole" NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_vendors" (
    "id" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "vendorId" TEXT,
    "freeformName" TEXT,
    "role" "VendorRole" NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "item_vendors_itemId_idx" ON "item_vendors"("itemId");

-- CreateIndex
CREATE INDEX "item_vendors_vendorId_idx" ON "item_vendors"("vendorId");

-- CreateIndex
CREATE INDEX "system_vendors_systemId_idx" ON "system_vendors"("systemId");

-- CreateIndex
CREATE INDEX "system_vendors_vendorId_idx" ON "system_vendors"("vendorId");

-- AddForeignKey
ALTER TABLE "item_vendors" ADD CONSTRAINT "item_vendors_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_vendors" ADD CONSTRAINT "item_vendors_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_vendors" ADD CONSTRAINT "system_vendors_systemId_fkey" FOREIGN KEY ("systemId") REFERENCES "systems"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_vendors" ADD CONSTRAINT "system_vendors_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Enforce XOR: a link must reference exactly one of vendorId / freeformName.
ALTER TABLE item_vendors
  ADD CONSTRAINT item_vendors_link_xor
  CHECK (("vendorId" IS NULL) <> ("freeformName" IS NULL));

ALTER TABLE system_vendors
  ADD CONSTRAINT system_vendors_link_xor
  CHECK (("vendorId" IS NULL) <> ("freeformName" IS NULL));
