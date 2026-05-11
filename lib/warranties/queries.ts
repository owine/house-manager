// NOTE: Prisma returns `cost` as a Decimal instance. Callers receive it as-is;
// UI components should call .toNumber() or .toString() as needed for display.
import { prisma } from '@/lib/db';

export async function getWarranty(id: string) {
  const row = await prisma.warranty.findUnique({
    where: { id },
    include: {
      targets: {
        include: {
          item: { select: { id: true, name: true, systemId: true } },
          system: { select: { id: true, name: true } },
        },
      },
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
  return row;
}

/**
 * Warranties targeted at a system, either directly (target.systemId) or
 * indirectly via an item that belongs to the system (target.item.systemId).
 */
export async function getWarrantiesForSystem(systemId: string) {
  return prisma.warranty.findMany({
    where: {
      targets: {
        some: { OR: [{ systemId }, { item: { systemId } }] },
      },
    },
    orderBy: { endsOn: 'desc' },
    include: {
      targets: {
        include: {
          item: { select: { id: true, name: true, systemId: true } },
          system: { select: { id: true, name: true } },
        },
      },
    },
  });
}
