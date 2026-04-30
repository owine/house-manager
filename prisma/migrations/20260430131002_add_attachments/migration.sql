-- CreateTable
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "itemId" TEXT,
    "warrantyId" TEXT,
    "serviceRecordId" TEXT,
    "noteId" TEXT,
    "uploadedById" TEXT NOT NULL,
    "thumbnailPath" TEXT,
    "extractedText" TEXT,
    "indexedAt" TIMESTAMP(3),
    "aiIndexable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attachments_itemId_idx" ON "attachments"("itemId");

-- CreateIndex
CREATE INDEX "attachments_warrantyId_idx" ON "attachments"("warrantyId");

-- CreateIndex
CREATE INDEX "attachments_serviceRecordId_idx" ON "attachments"("serviceRecordId");

-- CreateIndex
CREATE INDEX "attachments_noteId_idx" ON "attachments"("noteId");

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_warrantyId_fkey" FOREIGN KEY ("warrantyId") REFERENCES "warranties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_serviceRecordId_fkey" FOREIGN KEY ("serviceRecordId") REFERENCES "service_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddConstraint
ALTER TABLE "attachments" ADD CONSTRAINT "Attachment_exactly_one_parent"
  CHECK (
    ("itemId" IS NOT NULL)::int +
    ("warrantyId" IS NOT NULL)::int +
    ("serviceRecordId" IS NOT NULL)::int +
    ("noteId" IS NOT NULL)::int
    = 1
  );
