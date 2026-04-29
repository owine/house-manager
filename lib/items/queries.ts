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
        _count: { select: { warranties: true, serviceRecords: true, itemNotes: true } },
      },
    }),
    prisma.item.count({ where }),
  ]);

  return { items, total };
}

export async function getItem(id: string) {
  return prisma.item.findUnique({
    where: { id },
    include: {
      category: true,
      warranties: { orderBy: { endsOn: 'desc' } },
      serviceRecords: {
        orderBy: { performedOn: 'desc' },
        include: { vendor: { select: { id: true, name: true } } },
      },
      itemNotes: { orderBy: { updatedAt: 'desc' } },
    },
  });
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
  return result.map((r) => r.location!).sort();
}
