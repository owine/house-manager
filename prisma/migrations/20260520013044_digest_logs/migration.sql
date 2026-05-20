-- NOTE: Prisma's auto-diff wanted to DROP the embeddings_embedding_cosine_idx
-- (an ivfflat pgvector index added manually in the plan_4c_ask migration —
-- Prisma 7 doesn't model vector indexes natively, so it sees the index in the
-- DB but not in schema.prisma and treats it as drift). The DROP has been
-- removed by hand. Any future `pnpm db:migrate` run that re-emits this DROP
-- in a fresh migration must do the same. (Same situation exists for the
-- parent-XOR CHECK constraints on service_record_targets, warranty_targets,
-- reminder_targets, and incoming_email_targets appended at the bottom of the
-- squashed migration; eyeball every generated migration for unintended DROPs.)

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
