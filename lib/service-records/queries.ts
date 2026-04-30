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
      itemId ? { itemId } : {},
      vendorId ? { vendorId } : {},
      params.q ? { summary: { contains: params.q, mode: 'insensitive' as const } } : {},
      fromDate && Number.isFinite(fromDate.getTime()) ? { performedOn: { gte: fromDate } } : {},
      toDate && Number.isFinite(toDate.getTime()) ? { performedOn: { lte: toDate } } : {},
    ],
  };

  const [records, total] = await Promise.all([
    prisma.serviceRecord.findMany({
      where,
      orderBy: { performedOn: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      include: {
        item: { select: { id: true, name: true } },
        vendor: { select: { id: true, name: true } },
      },
    }),
    prisma.serviceRecord.count({ where }),
  ]);

  return { records, total };
}

export async function getServiceRecord(id: string) {
  return prisma.serviceRecord.findUnique({
    where: { id },
    include: {
      item: true,
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
}
