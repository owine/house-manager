-- NOTE: Prisma's auto-diff wanted to DROP the embeddings_embedding_cosine_idx
-- (an ivfflat pgvector index added manually in the plan_4c_ask migration —
-- Prisma 7 doesn't model vector indexes natively, so it sees the index in the
-- DB but not in schema.prisma and treats it as drift). The DROP has been
-- removed by hand. This migration only adds the service_records.selfPerformed column.

-- AlterTable
ALTER TABLE "service_records" ADD COLUMN     "selfPerformed" BOOLEAN NOT NULL DEFAULT false;
