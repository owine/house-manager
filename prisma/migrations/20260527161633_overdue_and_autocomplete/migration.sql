-- NOTE: Prisma's auto-diff wanted to DROP the embeddings_embedding_cosine_idx
-- (an ivfflat pgvector index added manually in the plan_4c_ask migration —
-- Prisma 7 doesn't model vector indexes natively, so it sees the index in the
-- DB but not in schema.prisma and treats it as drift). The DROP has been
-- removed by hand. This migration only adds HouseProfile.timezone and
-- Reminder.autoComplete.

-- AlterTable
ALTER TABLE "house_profile" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC';

-- AlterTable
ALTER TABLE "reminders" ADD COLUMN     "autoComplete" BOOLEAN NOT NULL DEFAULT false;
