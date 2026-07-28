-- CreateEnum
CREATE TYPE "ChatRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "ChatProposalKind" AS ENUM ('CREATE_NOTE', 'UPDATE_NOTE', 'CREATE_ITEM', 'UPDATE_ITEM', 'UPDATE_SYSTEM', 'CREATE_SERVICE_RECORD');

-- CreateEnum
CREATE TYPE "ChatProposalStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'STALE', 'ORPHANED', 'INVALID');

-- NOTE: Prisma's auto-diff wanted to DROP the embeddings_embedding_cosine_idx
-- (an ivfflat pgvector index added manually in the plan_4c_ask migration —
-- Prisma 7 doesn't model vector indexes natively, so it sees the index in the
-- DB but not in schema.prisma and treats it as drift). The DROP has been
-- removed by hand, matching the pattern established in prior migrations
-- (e.g. 20260527161633_overdue_and_autocomplete).

-- AlterTable
ALTER TABLE "systems" ADD COLUMN     "metadata" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "chat_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" "ChatRole" NOT NULL,
    "content" TEXT NOT NULL,
    "aiSuggestionLogId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_proposals" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "kind" "ChatProposalKind" NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "payload" JSONB NOT NULL,
    "status" "ChatProposalStatus" NOT NULL DEFAULT 'PENDING',
    "baseUpdatedAt" TIMESTAMP(3),
    "beforeSnapshot" JSONB,
    "appliedEntityId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_sessions_userId_idx" ON "chat_sessions"("userId");

-- CreateIndex
CREATE INDEX "chat_sessions_updatedAt_idx" ON "chat_sessions"("updatedAt");

-- CreateIndex
CREATE INDEX "chat_messages_sessionId_createdAt_idx" ON "chat_messages"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "chat_proposals_messageId_idx" ON "chat_proposals"("messageId");

-- CreateIndex
CREATE INDEX "chat_proposals_status_idx" ON "chat_proposals"("status");

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_aiSuggestionLogId_fkey" FOREIGN KEY ("aiSuggestionLogId") REFERENCES "AISuggestionLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_proposals" ADD CONSTRAINT "chat_proposals_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
