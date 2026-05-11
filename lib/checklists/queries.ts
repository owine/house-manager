import { prisma } from '@/lib/db';

export type ChecklistListRow = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  updatedAt: Date;
  totalItems: number;
  completedItems: number;
};

/**
 * List checklists with per-checklist progress counts. By default returns
 * only active checklists; pass `includeArchived: true` to also include
 * `active = false` rows.
 *
 * Sorted: in-progress first (any incomplete items), then fully complete,
 * then no-items, then archived. Within each bucket, by `updatedAt` desc.
 */
export async function listChecklists(
  opts: { includeArchived?: boolean } = {},
): Promise<ChecklistListRow[]> {
  const rows = await prisma.checklist.findMany({
    where: opts.includeArchived ? {} : { active: true },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      name: true,
      description: true,
      active: true,
      updatedAt: true,
      _count: {
        select: {
          items: true,
        },
      },
      items: {
        where: { completedAt: { not: null } },
        select: { id: true },
      },
    },
  });

  const enriched = rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    active: r.active,
    updatedAt: r.updatedAt,
    totalItems: r._count.items,
    completedItems: r.items.length,
  }));

  // Bucket-then-sort: in-progress (active, has items, incomplete) > complete
  // (active, all items done) > empty (active, zero items) > archived.
  function bucket(row: ChecklistListRow): number {
    if (!row.active) return 3;
    if (row.totalItems === 0) return 2;
    if (row.completedItems < row.totalItems) return 0;
    return 1;
  }
  enriched.sort((a, b) => {
    const ba = bucket(a);
    const bb = bucket(b);
    if (ba !== bb) return ba - bb;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });
  return enriched;
}

export async function getChecklist(id: string) {
  return prisma.checklist.findUnique({
    where: { id },
    include: {
      items: {
        orderBy: { position: 'asc' },
        include: { item: { select: { id: true, name: true } } },
      },
    },
  });
}
