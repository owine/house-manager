-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "VendorRole" AS ENUM ('PURCHASE', 'INSTALLER', 'SERVICE', 'WARRANTY_PROVIDER', 'MANUFACTURER', 'OTHER');

-- CreateEnum
CREATE TYPE "IncomingEmailKind" AS ENUM ('ESTIMATE', 'INVOICE', 'TICKET', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "IncomingEmailState" AS ENUM ('UNTRIAGED', 'AUTO_LINKED', 'LINKED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "oidcSub" TEXT,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "name" TEXT,
    "image" TEXT,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notificationPrefs" JSONB,
    "icsToken" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "house_profile" (
    "id" TEXT NOT NULL,
    "location" TEXT,
    "climateZone" TEXT,
    "propertyType" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "house_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "systems" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT,
    "location" TEXT,
    "installDate" TIMESTAMP(3),
    "installCost" DECIMAL(10,2),
    "notes" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "systems_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "items" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "systemId" TEXT,
    "location" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "purchaseDate" TIMESTAMP(3),
    "purchasePrice" DECIMAL(10,2),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "archivedAt" TIMESTAMP(3),
    "includeInSuggestions" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendors" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "website" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_vendors" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "vendorId" TEXT,
    "freeformName" TEXT,
    "role" "VendorRole" NOT NULL,
    "notes" TEXT,
    "serviceContract" BOOLEAN NOT NULL DEFAULT false,
    "contractEndsOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_vendors" (
    "id" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "vendorId" TEXT,
    "freeformName" TEXT,
    "role" "VendorRole" NOT NULL,
    "notes" TEXT,
    "serviceContract" BOOLEAN NOT NULL DEFAULT false,
    "contractEndsOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warranties" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "policyNumber" TEXT,
    "startsOn" TIMESTAMP(3) NOT NULL,
    "endsOn" TIMESTAMP(3) NOT NULL,
    "coverage" TEXT,
    "cost" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warranties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warranty_targets" (
    "id" TEXT NOT NULL,
    "warrantyId" TEXT NOT NULL,
    "itemId" TEXT,
    "systemId" TEXT,

    CONSTRAINT "warranty_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_records" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT,
    "performedOn" TIMESTAMP(3) NOT NULL,
    "cost" DECIMAL(10,2),
    "summary" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_record_targets" (
    "id" TEXT NOT NULL,
    "serviceRecordId" TEXT NOT NULL,
    "itemId" TEXT,
    "systemId" TEXT,

    CONSTRAINT "service_record_targets_pkey" PRIMARY KEY ("id")
);

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
    "createdServiceRecordId" TEXT,
    "aiExtractedSummary" TEXT,
    "aiExtractedCost" DECIMAL(10,2),
    "aiExtractedPerformedOn" TIMESTAMP(3),
    "aiExtractedScope" TEXT,
    "aiExtractedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "incoming_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incoming_email_targets" (
    "id" TEXT NOT NULL,
    "incomingEmailId" TEXT NOT NULL,
    "itemId" TEXT,
    "systemId" TEXT,

    CONSTRAINT "incoming_email_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notes" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "itemId" TEXT,
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
    "filename" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "storagePath" TEXT,
    "externalUrl" TEXT,
    "externalProvider" TEXT,
    "externalProviderId" TEXT,
    "displayLabel" TEXT,
    "itemId" TEXT,
    "warrantyId" TEXT,
    "serviceRecordId" TEXT,
    "noteId" TEXT,
    "incomingEmailId" TEXT,
    "uploadedById" TEXT NOT NULL,
    "thumbnailPath" TEXT,
    "extractedText" TEXT,
    "indexedAt" TIMESTAMP(3),
    "aiIndexable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminders" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "recurrence" JSONB NOT NULL,
    "leadTimeDays" INTEGER NOT NULL DEFAULT 3,
    "notifyUserIds" TEXT[],
    "autoCreateServiceRecord" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_targets" (
    "id" TEXT NOT NULL,
    "reminderId" TEXT NOT NULL,
    "itemId" TEXT,
    "systemId" TEXT,
    "lastCompletedOn" TIMESTAMP(3),
    "nextDueOn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reminder_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_completions" (
    "id" TEXT NOT NULL,
    "reminderId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
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

-- CreateTable
CREATE TABLE "Checklist" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "schedule" JSONB,
    "nextDueOn" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Checklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistItem" (
    "id" TEXT NOT NULL,
    "checklistId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "itemId" TEXT,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AISuggestionLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "systemPromptVersion" TEXT NOT NULL,
    "userPrompt" TEXT,
    "inventorySnapshotIds" TEXT[],
    "response" JSONB,
    "acceptedItemIds" JSONB NOT NULL DEFAULT '[]',
    "errorReason" TEXT,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cacheReadTokens" INTEGER,
    "cacheCreationTokens" INTEGER,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AISuggestionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_oidcSub_key" ON "users"("oidcSub");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_icsToken_key" ON "users"("icsToken");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_providerAccountId_key" ON "accounts"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_sessionToken_key" ON "sessions"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_token_key" ON "verification_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_identifier_token_key" ON "verification_tokens"("identifier", "token");

-- CreateIndex
CREATE INDEX "systems_archivedAt_idx" ON "systems"("archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE INDEX "items_categoryId_idx" ON "items"("categoryId");

-- CreateIndex
CREATE INDEX "items_systemId_idx" ON "items"("systemId");

-- CreateIndex
CREATE INDEX "items_archivedAt_idx" ON "items"("archivedAt");

-- CreateIndex
CREATE INDEX "item_vendors_itemId_idx" ON "item_vendors"("itemId");

-- CreateIndex
CREATE INDEX "item_vendors_vendorId_idx" ON "item_vendors"("vendorId");

-- CreateIndex
CREATE INDEX "item_vendors_contractEndsOn_idx" ON "item_vendors"("contractEndsOn");

-- CreateIndex
CREATE INDEX "system_vendors_systemId_idx" ON "system_vendors"("systemId");

-- CreateIndex
CREATE INDEX "system_vendors_vendorId_idx" ON "system_vendors"("vendorId");

-- CreateIndex
CREATE INDEX "system_vendors_contractEndsOn_idx" ON "system_vendors"("contractEndsOn");

-- CreateIndex
CREATE INDEX "warranties_endsOn_idx" ON "warranties"("endsOn");

-- CreateIndex
CREATE INDEX "warranty_targets_itemId_idx" ON "warranty_targets"("itemId");

-- CreateIndex
CREATE INDEX "warranty_targets_systemId_idx" ON "warranty_targets"("systemId");

-- CreateIndex
CREATE UNIQUE INDEX "warranty_targets_warrantyId_itemId_systemId_key" ON "warranty_targets"("warrantyId", "itemId", "systemId") NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "service_records_vendorId_idx" ON "service_records"("vendorId");

-- CreateIndex
CREATE INDEX "service_records_performedOn_idx" ON "service_records"("performedOn");

-- CreateIndex
CREATE INDEX "service_record_targets_itemId_idx" ON "service_record_targets"("itemId");

-- CreateIndex
CREATE INDEX "service_record_targets_systemId_idx" ON "service_record_targets"("systemId");

-- CreateIndex
CREATE UNIQUE INDEX "service_record_targets_serviceRecordId_itemId_systemId_key" ON "service_record_targets"("serviceRecordId", "itemId", "systemId") NULLS NOT DISTINCT;

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
CREATE INDEX "incoming_emails_kind_idx" ON "incoming_emails"("kind");

-- CreateIndex
CREATE INDEX "incoming_email_targets_itemId_idx" ON "incoming_email_targets"("itemId");

-- CreateIndex
CREATE INDEX "incoming_email_targets_systemId_idx" ON "incoming_email_targets"("systemId");

-- CreateIndex
CREATE UNIQUE INDEX "incoming_email_targets_incomingEmailId_itemId_systemId_key" ON "incoming_email_targets"("incomingEmailId", "itemId", "systemId") NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "notes_itemId_idx" ON "notes"("itemId");

-- CreateIndex
CREATE INDEX "attachments_itemId_idx" ON "attachments"("itemId");

-- CreateIndex
CREATE INDEX "attachments_warrantyId_idx" ON "attachments"("warrantyId");

-- CreateIndex
CREATE INDEX "attachments_serviceRecordId_idx" ON "attachments"("serviceRecordId");

-- CreateIndex
CREATE INDEX "attachments_noteId_idx" ON "attachments"("noteId");

-- CreateIndex
CREATE INDEX "attachments_incomingEmailId_idx" ON "attachments"("incomingEmailId");

-- CreateIndex
CREATE INDEX "reminder_targets_itemId_idx" ON "reminder_targets"("itemId");

-- CreateIndex
CREATE INDEX "reminder_targets_systemId_idx" ON "reminder_targets"("systemId");

-- CreateIndex
CREATE INDEX "reminder_targets_nextDueOn_idx" ON "reminder_targets"("nextDueOn");

-- CreateIndex
CREATE INDEX "reminder_targets_reminderId_idx" ON "reminder_targets"("reminderId");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_targets_reminderId_itemId_systemId_key" ON "reminder_targets"("reminderId", "itemId", "systemId") NULLS NOT DISTINCT;

-- CreateIndex
CREATE UNIQUE INDEX "reminder_completions_createdServiceRecordId_key" ON "reminder_completions"("createdServiceRecordId");

-- CreateIndex
CREATE INDEX "reminder_completions_reminderId_completedOn_idx" ON "reminder_completions"("reminderId", "completedOn");

-- CreateIndex
CREATE INDEX "reminder_completions_targetId_completedOn_idx" ON "reminder_completions"("targetId", "completedOn");

-- CreateIndex
CREATE INDEX "notification_logs_reminderId_idx" ON "notification_logs"("reminderId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_logs_reminderId_userId_channel_cycle_key" ON "notification_logs"("reminderId", "userId", "channel", "cycle");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_userId_idx" ON "push_subscriptions"("userId");

-- CreateIndex
CREATE INDEX "Checklist_active_idx" ON "Checklist"("active");

-- CreateIndex
CREATE INDEX "ChecklistItem_checklistId_position_idx" ON "ChecklistItem"("checklistId", "position");

-- CreateIndex
CREATE INDEX "ChecklistItem_checklistId_completedAt_idx" ON "ChecklistItem"("checklistId", "completedAt");

-- CreateIndex
CREATE INDEX "ChecklistItem_itemId_idx" ON "ChecklistItem"("itemId");

-- CreateIndex
CREATE INDEX "AISuggestionLog_userId_createdAt_idx" ON "AISuggestionLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AISuggestionLog_createdAt_idx" ON "AISuggestionLog"("createdAt");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_systemId_fkey" FOREIGN KEY ("systemId") REFERENCES "systems"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_vendors" ADD CONSTRAINT "item_vendors_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_vendors" ADD CONSTRAINT "item_vendors_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_vendors" ADD CONSTRAINT "system_vendors_systemId_fkey" FOREIGN KEY ("systemId") REFERENCES "systems"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_vendors" ADD CONSTRAINT "system_vendors_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranty_targets" ADD CONSTRAINT "warranty_targets_warrantyId_fkey" FOREIGN KEY ("warrantyId") REFERENCES "warranties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranty_targets" ADD CONSTRAINT "warranty_targets_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranty_targets" ADD CONSTRAINT "warranty_targets_systemId_fkey" FOREIGN KEY ("systemId") REFERENCES "systems"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_records" ADD CONSTRAINT "service_records_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_record_targets" ADD CONSTRAINT "service_record_targets_serviceRecordId_fkey" FOREIGN KEY ("serviceRecordId") REFERENCES "service_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_record_targets" ADD CONSTRAINT "service_record_targets_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_record_targets" ADD CONSTRAINT "service_record_targets_systemId_fkey" FOREIGN KEY ("systemId") REFERENCES "systems"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incoming_emails" ADD CONSTRAINT "incoming_emails_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incoming_emails" ADD CONSTRAINT "incoming_emails_createdServiceRecordId_fkey" FOREIGN KEY ("createdServiceRecordId") REFERENCES "service_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incoming_email_targets" ADD CONSTRAINT "incoming_email_targets_incomingEmailId_fkey" FOREIGN KEY ("incomingEmailId") REFERENCES "incoming_emails"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incoming_email_targets" ADD CONSTRAINT "incoming_email_targets_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incoming_email_targets" ADD CONSTRAINT "incoming_email_targets_systemId_fkey" FOREIGN KEY ("systemId") REFERENCES "systems"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_warrantyId_fkey" FOREIGN KEY ("warrantyId") REFERENCES "warranties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_serviceRecordId_fkey" FOREIGN KEY ("serviceRecordId") REFERENCES "service_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_incomingEmailId_fkey" FOREIGN KEY ("incomingEmailId") REFERENCES "incoming_emails"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_targets" ADD CONSTRAINT "reminder_targets_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "reminders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_targets" ADD CONSTRAINT "reminder_targets_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_targets" ADD CONSTRAINT "reminder_targets_systemId_fkey" FOREIGN KEY ("systemId") REFERENCES "systems"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_completions" ADD CONSTRAINT "reminder_completions_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "reminders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_completions" ADD CONSTRAINT "reminder_completions_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "reminder_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_completions" ADD CONSTRAINT "reminder_completions_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_completions" ADD CONSTRAINT "reminder_completions_createdServiceRecordId_fkey" FOREIGN KEY ("createdServiceRecordId") REFERENCES "service_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "reminders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistItem" ADD CONSTRAINT "ChecklistItem_checklistId_fkey" FOREIGN KEY ("checklistId") REFERENCES "Checklist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistItem" ADD CONSTRAINT "ChecklistItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AISuggestionLog" ADD CONSTRAINT "AISuggestionLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Custom CHECK constraints — these are not expressed in `schema.prisma`
-- and `prisma migrate diff --from-empty --to-schema` does not emit them,
-- so they are appended here so the squashed init reproduces the exact
-- prod schema. See the original migrations for the rationale on each:
--   - Attachment_storage_xor_link / Attachment_file_metadata_required:
--       20260430140000_add_attachment_link_columns
--   - service/warranty/reminder/incoming-email targets parent_xor:
--       20260506235728_service_record_targets, 20260507001430_warranty_targets,
--       20260507002941_reminder_targets, 20260509001053_incoming_email_targets
--   - item_vendors/system_vendors link_xor: 20260507005622_vendor_links

ALTER TABLE "attachments"
  ADD CONSTRAINT "Attachment_file_metadata_required"
  CHECK (
    ("storagePath" IS NULL)
    OR ((filename IS NOT NULL) AND ("mimeType" IS NOT NULL) AND ("sizeBytes" IS NOT NULL))
  );

ALTER TABLE "attachments"
  ADD CONSTRAINT "Attachment_storage_xor_link"
  CHECK (
    ((("storagePath" IS NOT NULL))::int + (("externalUrl" IS NOT NULL))::int) = 1
  );

ALTER TABLE "service_record_targets"
  ADD CONSTRAINT "service_record_targets_parent_xor"
  CHECK (("itemId" IS NULL) <> ("systemId" IS NULL));

ALTER TABLE "warranty_targets"
  ADD CONSTRAINT "warranty_targets_parent_xor"
  CHECK (("itemId" IS NULL) <> ("systemId" IS NULL));

ALTER TABLE "reminder_targets"
  ADD CONSTRAINT "reminder_targets_parent_xor"
  CHECK (("itemId" IS NULL) <> ("systemId" IS NULL));

ALTER TABLE "incoming_email_targets"
  ADD CONSTRAINT "IncomingEmailTarget_parent_xor"
  CHECK (("itemId" IS NULL) <> ("systemId" IS NULL));

ALTER TABLE "item_vendors"
  ADD CONSTRAINT "item_vendors_link_xor"
  CHECK (("vendorId" IS NULL) <> ("freeformName" IS NULL));

ALTER TABLE "system_vendors"
  ADD CONSTRAINT "system_vendors_link_xor"
  CHECK (("vendorId" IS NULL) <> ("freeformName" IS NULL));
