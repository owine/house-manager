// NOTE: Prisma returns `cost` as a Decimal instance. Callers receive it as-is;
// UI components should call .toNumber() or .toString() as needed for display.
import { prisma } from '@/lib/db';
import type { ListParams } from '@/lib/url-params';

export async function listServiceRecords(params: ListParams) {
  const itemId = params.filters.itemId?.[0];
  const vendorId = params.filters.vendorId?.[0];

  const fromStr = params.filters.from?.[0];
  const toStr = params.filters.to?.[0];
  const fromDate = fromStr ? new Date(fromStr) : undefined;
  const toDate = toStr ? new Date(toStr) : undefined;

  const where = {
    AND: [
      itemId ? { targets: { some: { itemId } } } : {},
      vendorId ? { vendorId } : {},
      params.q ? { summary: { contains: params.q, mode: 'insensitive' as const } } : {},
      fromDate && Number.isFinite(fromDate.getTime()) ? { performedOn: { gte: fromDate } } : {},
      toDate && Number.isFinite(toDate.getTime()) ? { performedOn: { lte: toDate } } : {},
    ],
  };

  // Targets include `item.systemId` so the chip renderer can dedupe item
  // chips whose parent system is also in the same target set (showing the
  // system implies its items).
  const [records, total] = await Promise.all([
    prisma.serviceRecord.findMany({
      where,
      orderBy: { performedOn: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      include: {
        targets: {
          include: {
            item: { select: { id: true, name: true, systemId: true } },
            system: { select: { id: true, name: true } },
          },
        },
        vendor: { select: { id: true, name: true } },
      },
    }),
    prisma.serviceRecord.count({ where }),
  ]);

  return { records, total };
}

export async function getServiceRecord(id: string) {
  const row = await prisma.serviceRecord.findUnique({
    where: { id },
    include: {
      targets: {
        include: {
          item: { select: { id: true, name: true } },
          system: { select: { id: true, name: true } },
        },
      },
      vendor: true,
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
 * Service records targeted at a system, either directly (target.systemId) or
 * indirectly via an item that belongs to the system (target.item.systemId).
 */
export async function getServiceRecordsForSystem(systemId: string) {
  return prisma.serviceRecord.findMany({
    where: {
      targets: {
        some: { OR: [{ systemId }, { item: { systemId } }] },
      },
    },
    orderBy: { performedOn: 'desc' },
    include: {
      targets: {
        include: {
          item: { select: { id: true, name: true } },
          system: { select: { id: true, name: true } },
        },
      },
      vendor: { select: { id: true, name: true } },
    },
  });
}
