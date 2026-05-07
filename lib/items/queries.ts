import { prisma } from '@/lib/db';
import type { ListParams } from '@/lib/url-params';

export async function listItems(params: ListParams) {
  const includeArchived = params.filters.archived?.includes('true') ?? false;
  const where = {
    AND: [
      includeArchived ? {} : { archivedAt: null },
      params.q
        ? {
            OR: [
              { name: { contains: params.q, mode: 'insensitive' as const } },
              { manufacturer: { contains: params.q, mode: 'insensitive' as const } },
              { model: { contains: params.q, mode: 'insensitive' as const } },
            ],
          }
        : {},
      params.filters.category?.length
        ? { category: { slug: { in: params.filters.category } } }
        : {},
      params.filters.location?.length ? { location: { in: params.filters.location } } : {},
    ],
  };

  const orderBy =
    params.sort === 'createdAt' ? { createdAt: 'desc' as const } : { name: 'asc' as const };

  const [items, total] = await Promise.all([
    prisma.item.findMany({
      where,
      orderBy,
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      include: {
        category: true,
        _count: { select: { warranties: true, serviceRecordTargets: true, itemNotes: true } },
      },
    }),
    prisma.item.count({ where }),
  ]);

  return { items, total };
}

export async function getItem(id: string) {
  const row = await prisma.item.findUnique({
    where: { id },
    include: {
      category: true,
      warranties: { orderBy: { endsOn: 'desc' } },
      serviceRecordTargets: {
        orderBy: { serviceRecord: { performedOn: 'desc' } },
        include: {
          serviceRecord: { include: { vendor: { select: { id: true, name: true } } } },
        },
      },
      itemNotes: { orderBy: { updatedAt: 'desc' } },
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
      reminders: {
        where: { active: true },
        orderBy: { nextDueOn: 'asc' },
        select: { id: true, title: true, nextDueOn: true, active: true },
      },
    },
  });
  if (!row) return null;
  // Surface a flat `serviceRecords` shape derived from the per-item target
  // rows. Tactical compatibility with the existing per-item ServiceTab; the
  // multi-target rendering arrives in a later task.
  const { serviceRecordTargets, ...rest } = row;
  const serviceRecords = serviceRecordTargets.map((t) => t.serviceRecord);
  return { ...rest, serviceRecords };
}

export async function listAllCategories() {
  return prisma.category.findMany({ orderBy: { sortOrder: 'asc' } });
}

export async function listAllItemLocations() {
  const result = await prisma.item.findMany({
    select: { location: true },
    where: { location: { not: null } },
    distinct: ['location'],
  });
  // Prisma can't narrow the result type from the where clause; r.location is
  // still typed as `string | null`. flatMap drops nulls and produces a string[]
  // without a non-null assertion.
  return result.flatMap((r) => (r.location ? [r.location] : [])).sort();
}
