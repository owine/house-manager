import { prisma } from '@/lib/db';

export async function getAttachment(id: string) {
  return prisma.attachment.findUnique({
    where: { id },
    select: {
      id: true,
      filename: true,
      mimeType: true,
      sizeBytes: true,
      storagePath: true,
      thumbnailPath: true,
      externalUrl: true,
      displayLabel: true,
    },
  });
}
