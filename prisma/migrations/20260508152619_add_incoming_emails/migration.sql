-- CreateEnum
CREATE TYPE "IncomingEmailKind" AS ENUM ('ESTIMATE', 'INVOICE', 'TICKET', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "IncomingEmailState" AS ENUM ('UNTRIAGED', 'AUTO_LINKED', 'LINKED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "attachments" ADD COLUMN     "incomingEmailId" TEXT;

-- CreateTable
CREATE TABLE "incoming_emails" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT,
    "subject" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bodyText" TEXT,
    "bodyHtml" TEXT,
    "headersJson" JSONB NOT NULL,
    "authResultsJson" JSONB,
    "kind" "IncomingEmailKind" NOT NULL DEFAULT 'UNKNOWN',
    "state" "IncomingEmailState" NOT NULL DEFAULT 'UNTRIAGED',
    "vendorId" TEXT,
    "itemId" TEXT,
    "systemId" TEXT,
    "createdServiceRecordId" TEXT,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "incoming_emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "incoming_emails_messageId_key" ON "incoming_emails"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "incoming_emails_createdServiceRecordId_key" ON "incoming_emails"("createdServiceRecordId");

-- CreateIndex
CREATE INDEX "incoming_emails_state_idx" ON "incoming_emails"("state");

-- CreateIndex
CREATE INDEX "incoming_emails_receivedAt_idx" ON "incoming_emails"("receivedAt");

-- CreateIndex
CREATE INDEX "incoming_emails_vendorId_idx" ON "incoming_emails"("vendorId");

-- CreateIndex
CREATE INDEX "incoming_emails_itemId_idx" ON "incoming_emails"("itemId");

-- CreateIndex
CREATE INDEX "incoming_emails_systemId_idx" ON "incoming_emails"("systemId");

-- CreateIndex
CREATE INDEX "incoming_emails_kind_idx" ON "incoming_emails"("kind");

-- CreateIndex
CREATE INDEX "attachments_incomingEmailId_idx" ON "attachments"("incomingEmailId");

-- AddForeignKey
ALTER TABLE "incoming_emails" ADD CONSTRAINT "incoming_emails_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incoming_emails" ADD CONSTRAINT "incoming_emails_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incoming_emails" ADD CONSTRAINT "incoming_emails_systemId_fkey" FOREIGN KEY ("systemId") REFERENCES "systems"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incoming_emails" ADD CONSTRAINT "incoming_emails_createdServiceRecordId_fkey" FOREIGN KEY ("createdServiceRecordId") REFERENCES "service_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_incomingEmailId_fkey" FOREIGN KEY ("incomingEmailId") REFERENCES "incoming_emails"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Update the exactly-one-parent CHECK to include the new incomingEmailId.
-- Drop and recreate so the constraint expression matches the column set.
ALTER TABLE "attachments" DROP CONSTRAINT "Attachment_exactly_one_parent";
ALTER TABLE "attachments" ADD CONSTRAINT "Attachment_exactly_one_parent"
  CHECK (
    ("itemId" IS NOT NULL)::int +
    ("warrantyId" IS NOT NULL)::int +
    ("serviceRecordId" IS NOT NULL)::int +
    ("noteId" IS NOT NULL)::int +
    ("incomingEmailId" IS NOT NULL)::int
    = 1
  );
