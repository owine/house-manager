/*
  Warnings:

  - A unique constraint covering the columns `[reminderId,itemId,systemId,partId]` on the table `reminder_targets` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[serviceRecordId,itemId,systemId,partId]` on the table `service_record_targets` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "PartKind" AS ENUM ('BULB', 'AIR_FILTER', 'WATER_FILTER', 'BATTERY', 'BELT', 'FUSE', 'CHEMICAL', 'OTHER');

-- NOTE: Prisma's auto-diff wanted to DROP the embeddings_embedding_cosine_idx
-- (an ivfflat pgvector index added manually in the plan_4c_ask migration —
-- Prisma 7 doesn't model vector indexes natively, so it sees the index in the
-- DB but not in schema.prisma and treats it as drift). The DROP has been
-- removed by hand, matching the pattern established in prior migrations
-- (e.g. 20260527161633_overdue_and_autocomplete, 20260727213328_chat_session_user_fk).

-- DropIndex
DROP INDEX "reminder_targets_reminderId_itemId_systemId_key";

-- DropIndex
DROP INDEX "service_record_targets_serviceRecordId_itemId_systemId_key";

-- AlterTable
ALTER TABLE "attachments" ADD COLUMN     "partId" TEXT;

-- AlterTable
ALTER TABLE "reminder_targets" ADD COLUMN     "partId" TEXT;

-- AlterTable
ALTER TABLE "service_record_targets" ADD COLUMN     "partId" TEXT;

-- CreateTable
CREATE TABLE "parts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PartKind" NOT NULL DEFAULT 'OTHER',
    "location" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "sku" TEXT,
    "typicalCost" DECIMAL(10,2),
    "packQuantity" INTEGER,
    "purchaseLinks" JSONB NOT NULL DEFAULT '[]',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_links" (
    "id" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "itemId" TEXT,
    "systemId" TEXT,
    "location" TEXT,
    "quantityInstalled" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "part_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "parts_kind_idx" ON "parts"("kind");

-- CreateIndex
CREATE INDEX "parts_archivedAt_idx" ON "parts"("archivedAt");

-- CreateIndex
CREATE INDEX "part_links_partId_idx" ON "part_links"("partId");

-- CreateIndex
CREATE INDEX "part_links_itemId_idx" ON "part_links"("itemId");

-- CreateIndex
CREATE INDEX "part_links_systemId_idx" ON "part_links"("systemId");

-- CreateIndex
CREATE UNIQUE INDEX "part_links_partId_itemId_systemId_key" ON "part_links"("partId", "itemId", "systemId");

-- CreateIndex
CREATE INDEX "attachments_partId_idx" ON "attachments"("partId");

-- CreateIndex
CREATE INDEX "reminder_targets_partId_idx" ON "reminder_targets"("partId");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_targets_reminder_item_system_part_key" ON "reminder_targets"("reminderId", "itemId", "systemId", "partId");

-- CreateIndex
CREATE INDEX "service_record_targets_partId_idx" ON "service_record_targets"("partId");

-- CreateIndex
CREATE UNIQUE INDEX "sr_targets_record_item_system_part_key" ON "service_record_targets"("serviceRecordId", "itemId", "systemId", "partId");

-- AddForeignKey
ALTER TABLE "service_record_targets" ADD CONSTRAINT "service_record_targets_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_links" ADD CONSTRAINT "part_links_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_links" ADD CONSTRAINT "part_links_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_links" ADD CONSTRAINT "part_links_systemId_fkey" FOREIGN KEY ("systemId") REFERENCES "systems"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_targets" ADD CONSTRAINT "reminder_targets_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Custom SQL: prisma migrate diff cannot regenerate any of this ──────────

ALTER TABLE "part_links" ADD CONSTRAINT "part_links_parent_xor"
  CHECK (("itemId" IS NULL) <> ("systemId" IS NULL));

-- Prisma emits a plain unique; replace it with the NULLS NOT DISTINCT form so
-- (part, item, NULL) duplicates are rejected.
DROP INDEX IF EXISTS "part_links_partId_itemId_systemId_key";
CREATE UNIQUE INDEX "part_links_partId_itemId_systemId_key"
  ON "part_links"("partId", "itemId", "systemId") NULLS NOT DISTINCT;

-- reminder_targets: replace the PAIRWISE form with the general one. Still
-- "at most one" — the standalone-chore relaxation must survive.
ALTER TABLE "reminder_targets" DROP CONSTRAINT "reminder_targets_parent_at_most_one";
ALTER TABLE "reminder_targets" ADD CONSTRAINT "reminder_targets_parent_at_most_one"
  CHECK (num_nonnulls("itemId", "systemId", "partId") <= 1);

-- service_record_targets: still exactly one.
ALTER TABLE "service_record_targets" DROP CONSTRAINT "service_record_targets_parent_xor";
ALTER TABLE "service_record_targets" ADD CONSTRAINT "service_record_targets_parent_xor"
  CHECK (num_nonnulls("itemId", "systemId", "partId") = 1);

DROP INDEX IF EXISTS "reminder_targets_reminderId_itemId_systemId_key";
DROP INDEX IF EXISTS "reminder_targets_reminder_item_system_part_key";
CREATE UNIQUE INDEX "reminder_targets_reminder_item_system_part_key"
  ON "reminder_targets"("reminderId","itemId","systemId","partId") NULLS NOT DISTINCT;

DROP INDEX IF EXISTS "service_record_targets_serviceRecordId_itemId_systemId_key";
DROP INDEX IF EXISTS "sr_targets_record_item_system_part_key";
CREATE UNIQUE INDEX "sr_targets_record_item_system_part_key"
  ON "service_record_targets"("serviceRecordId","itemId","systemId","partId") NULLS NOT DISTINCT;
