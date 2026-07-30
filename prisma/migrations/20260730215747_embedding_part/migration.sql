-- NOTE: Prisma's auto-diff wanted to DROP the embeddings_embedding_cosine_idx
-- (an ivfflat pgvector index added manually in the plan_4c_ask migration —
-- Prisma 7 doesn't model vector indexes natively, so it sees the index in the
-- DB but not in schema.prisma and treats it as drift). The DROP has been
-- removed by hand, matching the pattern established in prior migrations
-- (e.g. 20260520145556_item_restored_at, 20260729215620_parts).

-- AlterEnum
ALTER TYPE "EmbeddingEntityType" ADD VALUE 'PART';
