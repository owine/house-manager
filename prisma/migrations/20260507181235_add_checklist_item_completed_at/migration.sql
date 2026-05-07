-- AlterTable
ALTER TABLE "ChecklistItem" ADD COLUMN     "completedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ChecklistItem_checklistId_completedAt_idx" ON "ChecklistItem"("checklistId", "completedAt");
