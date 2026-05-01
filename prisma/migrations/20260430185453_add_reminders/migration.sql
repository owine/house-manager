-- CreateTable
CREATE TABLE "reminders" (
    "id" TEXT NOT NULL,
    "itemId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "recurrence" JSONB NOT NULL,
    "lastCompletedOn" TIMESTAMP(3),
    "nextDueOn" TIMESTAMP(3) NOT NULL,
    "leadTimeDays" INTEGER NOT NULL DEFAULT 3,
    "notifyUserIds" TEXT[],
    "autoCreateServiceRecord" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_completions" (
    "id" TEXT NOT NULL,
    "reminderId" TEXT NOT NULL,
    "completedById" TEXT NOT NULL,
    "completedOn" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "createdServiceRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminder_completions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_logs" (
    "id" TEXT NOT NULL,
    "reminderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "cycle" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "errorReason" TEXT,

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reminders_nextDueOn_idx" ON "reminders"("nextDueOn");

-- CreateIndex
CREATE INDEX "reminders_active_nextDueOn_idx" ON "reminders"("active", "nextDueOn");

-- CreateIndex
CREATE INDEX "reminders_itemId_idx" ON "reminders"("itemId");

-- CreateIndex
CREATE INDEX "reminder_completions_reminderId_completedOn_idx" ON "reminder_completions"("reminderId", "completedOn");

-- CreateIndex
CREATE UNIQUE INDEX "notification_logs_reminderId_userId_channel_cycle_key" ON "notification_logs"("reminderId", "userId", "channel", "cycle");

-- CreateIndex
CREATE INDEX "notification_logs_reminderId_idx" ON "notification_logs"("reminderId");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_userId_idx" ON "push_subscriptions"("userId");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "reminder_completions_createdServiceRecordId_key" ON "reminder_completions"("createdServiceRecordId");

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_completions" ADD CONSTRAINT "reminder_completions_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "reminders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_completions" ADD CONSTRAINT "reminder_completions_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_completions" ADD CONSTRAINT "reminder_completions_createdServiceRecordId_fkey" FOREIGN KEY ("createdServiceRecordId") REFERENCES "service_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "reminders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "users" ADD COLUMN "notificationPrefs" JSONB,
ADD COLUMN "icsToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_icsToken_key" ON "users"("icsToken");
