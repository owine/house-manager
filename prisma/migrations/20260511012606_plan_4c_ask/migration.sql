-- CreateEnum
CREATE TYPE "EmbeddingEntityType" AS ENUM ('ITEM', 'NOTE', 'SERVICE_RECORD', 'CHECKLIST_ITEM', 'WARRANTY', 'ATTACHMENT');

-- AlterTable
ALTER TABLE "AISuggestionLog" ADD COLUMN     "citationCount" INTEGER,
ADD COLUMN     "retrievedChunkIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "attachments" ADD COLUMN     "extractedAt" TIMESTAMP(3),
ADD COLUMN     "extractedError" TEXT,
ADD COLUMN     "ocrUsed" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "embeddings" (
    "id" TEXT NOT NULL,
    "entityType" "EmbeddingEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "embedding" vector(1024) NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "embeddings_entityType_entityId_idx" ON "embeddings"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "embeddings_contentHash_idx" ON "embeddings"("contentHash");

-- IVFFlat index for cosine-distance ANN search. 100 lists is a starting
-- point for under ~100k chunks (pgvector docs: rows / 1000). Revisit when
-- the table grows. The index is appended manually because Prisma 7
-- doesn't emit vector indexes natively.
CREATE INDEX "embeddings_embedding_cosine_idx"
  ON "embeddings" USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100);
