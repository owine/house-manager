// NOTE: Prisma returns `installCost` and `purchasePrice` as Decimal instances.
// Callers receive them as-is; UI components should call .toNumber() or
// .toString() as needed for display. The cost rollup is computed via the pure
// `computeCostRollup` helper so it can be unit-tested without a DB.
import { prisma } from '@/lib/db';
import { computeCostRollup } from './cost-rollup';

export async function listSystems({ archived = false }: { archived?: boolean } = {}) {
  return prisma.system.findMany({
    where: archived ? {} : { archivedAt: null },
    orderBy: { name: 'asc' },
    include: {
      _count: {
        select: {
          items: true,
          serviceRecordTargets: true,
          warrantyTargets: true,
          reminderTargets: true,
        },
      },
    },
  });
}

/**
 * Lightweight `{ id, name }[]` list of non-archived systems, ordered by name.
 * Used by the Item form's optional system picker.
 */
export async function listSystemsForPicker() {
  return prisma.system.findMany({
    where: { archivedAt: null },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
}

/**
 * Non-archived systems with their (active + archived) component items, in the
 * shape consumed by `<TargetsPicker>`. The picker filters archived items out
 * client-side during auto-expand via `expandSystemSelection`.
 */
export async function listSystemsWithItemsForPicker() {
  return prisma.system.findMany({
    where: { archivedAt: null },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      kind: true,
      items: {
        select: { id: true, archivedAt: true },
      },
    },
  });
}

export async function getSystem(id: string) {
  return prisma.system.findUnique({ where: { id } });
}

export async function getSystemDetail(id: string) {
  const system = await prisma.system.findUnique({
    where: { id },
    include: {
      items: {
        where: { archivedAt: null },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          purchasePrice: true,
          archivedAt: true,
          categoryId: true,
          manufacturer: true,
          model: true,
        },
      },
      systemVendors: {
        orderBy: { createdAt: 'asc' },
        include: { vendor: { select: { id: true, name: true } } },
      },
    },
  });
  if (!system) return null;
  const rollup = computeCostRollup({
    installCost: system.installCost,
    components: system.items,
  });
  return { system, rollup };
}
