-- AlterTable
ALTER TABLE "item_vendors" ADD COLUMN     "contractEndsOn" DATE,
ADD COLUMN     "serviceContract" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "system_vendors" ADD COLUMN     "contractEndsOn" DATE,
ADD COLUMN     "serviceContract" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "item_vendors_contractEndsOn_idx" ON "item_vendors"("contractEndsOn");

-- CreateIndex
CREATE INDEX "system_vendors_contractEndsOn_idx" ON "system_vendors"("contractEndsOn");
