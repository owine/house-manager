import { prisma } from '@/lib/db';
import type { HouseProfileForPrompt, InventoryEntry } from './prompts';

export type FocusedItem = {
  id: string;
  name: string;
  categoryName: string;
  manufacturer: string | null;
  model: string | null;
};

export type SuggestContext = {
  profile: HouseProfileForPrompt;
  inventory: InventoryEntry[];
  inventorySnapshotIds: string[];
  focusedItem: FocusedItem | null;
};

export async function buildSuggestContext(input: {
  today: Date;
  focusedItemId?: string;
}): Promise<SuggestContext> {
  const [profileRow, items, focused] = await Promise.all([
    prisma.houseProfile.findFirst(),
    prisma.item.findMany({
      where: { archivedAt: null, includeInSuggestions: true },
      select: {
        id: true,
        name: true,
        location: true,
        manufacturer: true,
        model: true,
        category: { select: { name: true } },
      },
      orderBy: { name: 'asc' },
    }),
    input.focusedItemId
      ? prisma.item.findUnique({
          where: { id: input.focusedItemId },
          select: {
            id: true,
            name: true,
            manufacturer: true,
            model: true,
            category: { select: { name: true } },
          },
        })
      : null,
  ]);

  const profile: HouseProfileForPrompt = profileRow
    ? {
        location: profileRow.location,
        climateZone: profileRow.climateZone,
        propertyType: profileRow.propertyType,
      }
    : null;

  const inventory: InventoryEntry[] = items.map((i) => ({
    id: i.id,
    name: i.name,
    categoryName: i.category?.name ?? 'Uncategorized',
    location: i.location,
    manufacturer: i.manufacturer,
    model: i.model,
  }));

  const focusedItem: FocusedItem | null = focused
    ? {
        id: focused.id,
        name: focused.name,
        categoryName: focused.category?.name ?? 'Uncategorized',
        manufacturer: focused.manufacturer,
        model: focused.model,
      }
    : null;

  return { profile, inventory, inventorySnapshotIds: inventory.map((i) => i.id), focusedItem };
}
