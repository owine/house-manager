-- CreateEnum
CREATE TYPE "ReminderKind" AS ENUM ('REMINDER', 'CHORE');

-- AlterTable
ALTER TABLE "reminders"
ADD COLUMN "kind" "ReminderKind" NOT NULL DEFAULT 'REMINDER';

-- CreateIndex
CREATE INDEX "reminders_kind_active_idx" ON "reminders"("kind", "active");
