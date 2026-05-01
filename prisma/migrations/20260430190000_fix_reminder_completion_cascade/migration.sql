-- DropForeignKey
ALTER TABLE "reminder_completions" DROP CONSTRAINT "reminder_completions_completedById_fkey";

-- AddForeignKey
ALTER TABLE "reminder_completions" ADD CONSTRAINT "reminder_completions_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
