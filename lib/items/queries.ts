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
        _count: {
          select: { warrantyTargets: true, serviceRecordTargets: true, itemNotes: true },
        },
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
      system: { select: { id: true, name: true, archivedAt: true } },
      itemVendors: {
        orderBy: { createdAt: 'asc' },
        include: { vendor: { select: { id: true, name: true } } },
      },
      warrantyTargets: {
        orderBy: { warranty: { endsOn: 'desc' } },
        include: {
          warranty: {
            include: {
              targets: {
                include: {
                  // item.systemId for the chip dedup logic
                  item: { select: { id: true, name: true, systemId: true } },
                  system: { select: { id: true, name: true } },
                },
              },
            },
          },
        },
      },
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
      reminderTargets: {
        where: { reminder: { active: true } },
        orderBy: { nextDueOn: 'asc' },
        select: {
          id: true,
          nextDueOn: true,
          reminder: { select: { id: true, title: true, active: true } },
        },
      },
    },
  });
  if (!row) return null;
  // Surface flat `serviceRecords`, `warranties`, and `reminders` shapes
  // derived from the per-item target rows. Tactical compatibility with the
  // existing per-item tabs; the multi-target rendering arrives in a later
  // task.
  const { serviceRecordTargets, warrantyTargets, reminderTargets, ...rest } = row;
  const serviceRecords = serviceRecordTargets.map((t) => t.serviceRecord);
  const warranties = warrantyTargets.map((t) => t.warranty);
  const reminders = reminderTargets.map((t) => ({
    id: t.reminder.id,
    title: t.reminder.title,
    active: t.reminder.active,
    nextDueOn: t.nextDueOn,
  }));
  return { ...rest, serviceRecords, warranties, reminders };
}

export async function listAllCategories() {
  return prisma.category.findMany({ orderBy: { sortOrder: 'asc' } });
}

/**
 * All non-archived items projected to the shape consumed by `<TargetsPicker>`.
 * Used by the service-record / warranty / reminder forms (multi-target picker).
 */
export async function listAllActiveItemsForPicker() {
  const rows = await prisma.item.findMany({
    where: { archivedAt: null },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      archivedAt: true,
      category: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    archivedAt: r.archivedAt,
    categoryName: r.category?.name ?? null,
  }));
}

/**
 * Items not assigned to any system and not archived. Used by the
 * "Add component" picker on the system detail page.
 */
export async function listOrphanItems() {
  return prisma.item.findMany({
    where: { systemId: null, archivedAt: null },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      manufacturer: true,
      model: true,
      category: { select: { name: true, icon: true } },
    },
  });
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
