-- AlterTable: make file columns nullable
ALTER TABLE "attachments" ALTER COLUMN "filename" DROP NOT NULL;
ALTER TABLE "attachments" ALTER COLUMN "mimeType" DROP NOT NULL;
ALTER TABLE "attachments" ALTER COLUMN "sizeBytes" DROP NOT NULL;
ALTER TABLE "attachments" ALTER COLUMN "storagePath" DROP NOT NULL;

-- AlterTable: add link columns
ALTER TABLE "attachments" ADD COLUMN "externalUrl" TEXT;
ALTER TABLE "attachments" ADD COLUMN "externalProvider" TEXT;
ALTER TABLE "attachments" ADD COLUMN "externalProviderId" TEXT;
ALTER TABLE "attachments" ADD COLUMN "displayLabel" TEXT;

-- AddConstraint (storage XOR link)
ALTER TABLE "attachments" ADD CONSTRAINT "Attachment_storage_xor_link"
  CHECK (
    (("storagePath" IS NOT NULL)::int + ("externalUrl" IS NOT NULL)::int) = 1
  );

-- AddConstraint (file metadata required when using storage)
ALTER TABLE "attachments" ADD CONSTRAINT "Attachment_file_metadata_required"
  CHECK (
    "storagePath" IS NULL OR (
      "filename" IS NOT NULL AND "mimeType" IS NOT NULL AND "sizeBytes" IS NOT NULL
    )
  );
