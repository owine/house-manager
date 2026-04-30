// NOTE: Prisma returns `cost` as a Decimal instance. Callers receive it as-is;
// UI components should call .toNumber() or .toString() as needed for display.
import { prisma } from '@/lib/db';

export async function getWarranty(id: string) {
  return prisma.warranty.findUnique({
    where: { id },
    include: {
      item: { select: { id: true, name: true } },
      attachments: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          filename: true,
          mimeType: true,
          sizeBytes: true,
          storagePath: true,
          externalUrl: true,
          displayLabel: true,
          thumbnailPath: true,
        },
      },
    },
  });
}

export async function listWarrantiesForItem(itemId: string) {
  return prisma.warranty.findMany({
    where: { itemId },
    orderBy: { endsOn: 'desc' },
  });
}
