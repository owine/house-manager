-- DropIndex
DROP INDEX "embeddings_embedding_cosine_idx";

-- CreateTable
CREATE TABLE "digest_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "cycle" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "errorReason" TEXT,

    CONSTRAINT "digest_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "digest_logs_userId_kind_cycle_key" ON "digest_logs"("userId", "kind", "cycle");

-- AddForeignKey
ALTER TABLE "digest_logs" ADD CONSTRAINT "digest_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
