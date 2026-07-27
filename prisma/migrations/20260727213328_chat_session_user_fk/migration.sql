-- NOTE: Prisma's auto-diff wanted to DROP the embeddings_embedding_cosine_idx
-- (an ivfflat pgvector index added manually in the plan_4c_ask migration —
-- Prisma 7 doesn't model vector indexes natively, so it sees the index in the
-- DB but not in schema.prisma and treats it as drift). The DROP has been
-- removed by hand, matching the pattern established in prior migrations
-- (e.g. 20260527161633_overdue_and_autocomplete,
-- 20260727211650_add_chat_capture_tables).

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
