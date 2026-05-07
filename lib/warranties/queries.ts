// NOTE: Prisma returns `cost` as a Decimal instance. Callers receive it as-is;
// UI components should call .toNumber() or .toString() as needed for display.
import { prisma } from '@/lib/db';

// Helper: derive a single primary `item` field from a warranty's targets so
// that existing per-item-page rendering (one item-target per warranty after
// backfill) keeps working tactically. Multi-target rendering is introduced in
// a later task.
function withDerivedItem<W extends { targets: { item: { id: string; name: string } | null }[] }>(
  warranty: W,
): W & { item: { id: string; name: string } | null } {
  const itemTarget = warranty.targets.find((t) => t.item !== null);
  return { ...warranty, item: itemTarget?.item ?? null };
}

export async function getWarranty(id: string) {
  const row = await prisma.warranty.findUnique({
    where: { id },
    include: {
      targets: {
        include: {
          item: { select: { id: true, name: true } },
          system: { select: { id: true, name: true } },
        },
      },
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

export async function listWarrantiesForItem(itemId: string) {
  return prisma.warranty.findMany({
    where: { targets: { some: { itemId } } },
    orderBy: { endsOn: 'desc' },
  });
}

/**
 * Warranties targeted at a system, either directly (target.systemId) or
 * indirectly via an item that belongs to the system (target.item.systemId).
 */
export async function getWarrantiesForSystem(systemId: string) {
  return prisma.warranty.findMany({
    where: {
      targets: {
        some: { OR: [{ systemId }, { item: { systemId } }] },
      },
    },
    orderBy: { endsOn: 'desc' },
    include: {
      targets: {
        include: {
          item: { select: { id: true, name: true } },
          system: { select: { id: true, name: true } },
        },
      },
    },
  });
}
