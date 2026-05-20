-- NOTE: Prisma's auto-diff wanted to DROP the embeddings_embedding_cosine_idx
-- (an ivfflat pgvector index added manually in the plan_4c_ask migration —
-- Prisma 7 doesn't model vector indexes natively, so it sees the index in the
-- DB but not in schema.prisma and treats it as drift). The DROP has been
-- removed by hand. This migration only adds the items.restoredAt column + index.

-- AlterTable
ALTER TABLE "items" ADD COLUMN     "restoredAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "items_restoredAt_idx" ON "items"("restoredAt");
