import { prisma } from '@/lib/db';
import type { ListParams } from '@/lib/url-params';

export async function listVendors(params: ListParams) {
  const where = {
    AND: [
      params.q
        ? {
            OR: [
              { name: { contains: params.q, mode: 'insensitive' as const } },
              { kind: { contains: params.q, mode: 'insensitive' as const } },
            ],
          }
        : {},
      params.filters.kind?.length ? { kind: { in: params.filters.kind } } : {},
      params.filters.tag?.length ? { tags: { hasSome: params.filters.tag } } : {},
    ],
  };

  const [vendors, total] = await Promise.all([
    prisma.vendor.findMany({
      where,
      orderBy: { name: 'asc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      include: { _count: { select: { serviceRecords: true } } },
    }),
    prisma.vendor.count({ where }),
  ]);

  return { vendors, total };
}

export async function getVendor(id: string) {
  return prisma.vendor.findUnique({
    where: { id },
    include: {
      serviceRecords: {
        orderBy: { performedOn: 'desc' },
        include: { item: { select: { id: true, name: true } } },
        take: 50,
      },
    },
  });
}

export async function listAllVendorKinds() {
  const result = await prisma.vendor.findMany({
    select: { kind: true },
    where: { kind: { not: null } },
    distinct: ['kind'],
  });
  return result.flatMap((r) => (r.kind ? [r.kind] : [])).sort();
}
