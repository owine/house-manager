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
  const row = await prisma.vendor.findUnique({
    where: { id },
    include: {
      serviceRecords: {
        orderBy: { performedOn: 'desc' },
        include: {
          // Full target set with item.systemId for the chip dedup logic;
          // matches the shape ServiceRecordTable consumes on /service.
          targets: {
            include: {
              item: { select: { id: true, name: true, systemId: true } },
              system: { select: { id: true, name: true } },
            },
          },
        },
        take: 50,
      },
    },
  });
  if (!row) return null;
  return row;
}

/**
 * Lightweight `{ id, name }[]` list of all vendors, ordered by name. Used by
 * vendor pickers (e.g. VendorLinkEditor) where the full ListParams machinery
 * is overkill.
 */
export async function listAllVendors() {
  return prisma.vendor.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
}

/**
 * Vendor detail data for the "linked items" / "linked systems" sections plus
 * the mediated-delete dialog. Returns the vendor row, plus link rows for
 * every ItemVendor / SystemVendor that references this vendor (orphan rows
 * that only have `freeformName` are not included — they aren't linked to this
 * vendor in the FK sense).
 */
export async function getVendorWithLinks(id: string) {
  const vendor = await prisma.vendor.findUnique({ where: { id } });
  if (!vendor) return null;

  const [itemLinks, systemLinks] = await Promise.all([
    prisma.itemVendor.findMany({
      where: { vendorId: id },
      select: {
        id: true,
        itemId: true,
        vendorId: true,
        freeformName: true,
        role: true,
        notes: true,
        item: { select: { id: true, name: true, systemId: true } },
      },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.systemVendor.findMany({
      where: { vendorId: id },
      select: {
        id: true,
        systemId: true,
        vendorId: true,
        freeformName: true,
        role: true,
        notes: true,
        system: { select: { id: true, name: true } },
      },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    }),
  ]);

  return { vendor, itemLinks, systemLinks };
}

export async function listAllVendorKinds() {
  const result = await prisma.vendor.findMany({
    select: { kind: true },
    where: { kind: { not: null } },
    distinct: ['kind'],
  });
  return result.flatMap((r) => (r.kind ? [r.kind] : [])).sort();
}
