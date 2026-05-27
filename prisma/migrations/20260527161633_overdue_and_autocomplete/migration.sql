-- AlterTable
ALTER TABLE "house_profile" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC';

-- AlterTable
ALTER TABLE "reminders" ADD COLUMN     "autoComplete" BOOLEAN NOT NULL DEFAULT false;
