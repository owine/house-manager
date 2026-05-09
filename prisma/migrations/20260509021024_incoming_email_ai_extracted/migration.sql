-- AlterTable
ALTER TABLE "incoming_emails" ADD COLUMN     "aiExtractedAt" TIMESTAMP(3),
ADD COLUMN     "aiExtractedCost" DECIMAL(10,2),
ADD COLUMN     "aiExtractedPerformedOn" TIMESTAMP(3),
ADD COLUMN     "aiExtractedScope" TEXT;
