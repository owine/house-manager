-- AlterTable
ALTER TABLE "items" ADD COLUMN     "systemId" TEXT;

-- CreateTable
CREATE TABLE "systems" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT,
    "location" TEXT,
    "installDate" TIMESTAMP(3),
    "installCost" DECIMAL(10,2),
    "notes" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "systems_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "systems_archivedAt_idx" ON "systems"("archivedAt");

-- CreateIndex
CREATE INDEX "items_systemId_idx" ON "items"("systemId");

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_systemId_fkey" FOREIGN KEY ("systemId") REFERENCES "systems"("id") ON DELETE SET NULL ON UPDATE CASCADE;
