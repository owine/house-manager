// NOTE: Prisma returns `cost` as a Decimal instance. Callers receive it as-is;
// UI components should call .toNumber() or .toString() as needed for display.
import { prisma } from '@/lib/db';
import type { ListParams } from '@/lib/url-params';

// Helper: derive a single primary `item` field from a record's targets so that
// existing per-item-page rendering (one item-target per record after backfill)
// keeps working tactically. Multi-target rendering is introduced in a later
// task.
function withDerivedItem<R extends { targets: { item: { id: string; name: string } | null }[] }>(
  record: R,
): R & { item: { id: string; name: string } | null } {
  const itemTarget = record.targets.find((t) => t.item !== null);
  return { ...record, item: itemTarget?.item ?? null };
}

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

  const [rows, total] = await Promise.all([
    prisma.serviceRecord.findMany({
      where,
      orderBy: { performedOn: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      include: {
        targets: { include: { item: { select: { id: true, name: true } } } },
        vendor: { select: { id: true, name: true } },
      },
    }),
    prisma.serviceRecord.count({ where }),
  ]);

  const records = rows.map(withDerivedItem);

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
  if (!row) return null;
  return withDerivedItem(row);
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
