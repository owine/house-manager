import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { SYSTEM_AUTO_COMPLETE_USER_ID } from '../lib/reminders/system-user';

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

const prisma = createPrismaClient();

const CATEGORIES = [
  { slug: 'appliance', name: 'Appliance', icon: 'washing-machine', sortOrder: 10 },
  { slug: 'hvac', name: 'HVAC', icon: 'thermometer', sortOrder: 20 },
  { slug: 'plumbing', name: 'Plumbing', icon: 'droplet', sortOrder: 30 },
  { slug: 'electrical', name: 'Electrical', icon: 'zap', sortOrder: 40 },
  { slug: 'exterior', name: 'Exterior', icon: 'home', sortOrder: 50 },
  { slug: 'vehicle', name: 'Vehicle', icon: 'car', sortOrder: 60 },
  { slug: 'tool', name: 'Tool', icon: 'wrench', sortOrder: 70 },
  { slug: 'landscaping', name: 'Landscaping', icon: 'leaf', sortOrder: 80 },
  { slug: 'other', name: 'Other', icon: 'box', sortOrder: 99 },
];

/**
 * Demo parts, covering all three link shapes — the UI treats them differently
 * and each one is a distinct surface:
 *   - AIR_FILTER → System   (the Parts card on the system detail page)
 *   - BULB       → Item     (the "parts" tab on the item detail page)
 *   - BULB       → nothing  (legal by design; the /parts list must still list it)
 *
 * Fixed ids so every upsert below is idempotent — `Part` has no natural unique
 * key, so re-running the seed would otherwise pile up duplicates.
 *
 * `metadata` matches the per-kind spec schema in `lib/parts/kinds.ts`; the
 * columns beside it (`typicalCost`, `packQuantity`, `purchaseLinks`) are the
 * re-buy grain that deliberately lives OUTSIDE the spec blob.
 *
 * The e2e harness truncates every table except `categories`, `house_profile`
 * and `_prisma_migrations` (see `PRESERVED_TABLES` in tests/e2e/auth.ts), so
 * these rows cannot leak into a spec's fixtures or a visual baseline.
 */
const DEMO_SYSTEM_ID = 'seed-system-hvac';
const DEMO_ITEM_ID = 'seed-item-kitchen-lighting';

const DEMO_PARTS = [
  {
    id: 'seed-part-air-filter',
    name: '20x25x1 furnace filter',
    kind: 'AIR_FILTER' as const,
    manufacturer: 'Filtrete',
    model: '2200-20x25x1',
    sku: 'MPR1500-20X25X1',
    typicalCost: '24.99',
    packQuantity: 4,
    purchaseLinks: [
      { label: 'Home Depot', url: 'https://www.homedepot.com/b/filters/N-5yc1vZc7l4' },
    ],
    metadata: {
      nominalSize: '20x25x1',
      actualSize: '19.5x24.5x0.75',
      merv: 11,
      mpr: 1500,
      pleated: true,
      ratedMonths: 3,
    },
    notes: 'Return-air grille in the upstairs hallway. Arrow points toward the furnace.',
  },
  {
    id: 'seed-part-can-light-bulb',
    name: 'Kitchen can light bulb',
    kind: 'BULB' as const,
    manufacturer: 'Philips',
    model: 'BR30-927-DIM',
    sku: '556569',
    typicalCost: '8.50',
    packQuantity: 6,
    purchaseLinks: [{ label: 'Philips', url: 'https://www.usa.lighting.philips.com/consumer/led' }],
    metadata: {
      base: 'E26',
      shape: 'BR30',
      technology: 'LED',
      watts: 9.5,
      wattEquivalent: 65,
      lumens: 650,
      colorTempK: 2700,
      cri: 90,
      dimmable: true,
      voltage: 120,
      ratedHours: 25_000,
    },
    notes: null,
  },
  {
    // No links: the generic-stock case. Not every consumable belongs to a
    // fixture, and the /parts list is the only place this part is reachable.
    id: 'seed-part-generic-a19',
    name: 'Generic A19 bulbs',
    kind: 'BULB' as const,
    location: 'Basement shelf',
    manufacturer: 'GE',
    model: 'A19-827-ND',
    sku: '93127626',
    typicalCost: '2.25',
    packQuantity: 8,
    purchaseLinks: [{ label: 'GE Lighting', url: 'https://www.gelighting.com/led-bulbs' }],
    metadata: {
      base: 'E26',
      shape: 'A19',
      technology: 'LED',
      watts: 8,
      wattEquivalent: 60,
      lumens: 800,
      colorTempK: 2700,
      cri: 80,
      dimmable: false,
      voltage: 120,
      ratedHours: 15_000,
    },
    notes: 'House stock — lamps, closets, anything without a fixture of its own.',
  },
];

async function seedDemoParts(): Promise<void> {
  await prisma.system.upsert({
    where: { id: DEMO_SYSTEM_ID },
    update: {},
    create: {
      id: DEMO_SYSTEM_ID,
      name: 'Central HVAC',
      kind: 'Forced air',
      location: 'Basement mechanical room',
      // Calendar date, not an instant: UTC midnight, never run through a tz.
      installDate: new Date('2019-10-08T00:00:00.000Z'),
    },
  });

  const electrical = await prisma.category.findUniqueOrThrow({ where: { slug: 'electrical' } });
  await prisma.item.upsert({
    where: { id: DEMO_ITEM_ID },
    update: {},
    create: {
      id: DEMO_ITEM_ID,
      name: 'Kitchen recessed lighting',
      categoryId: electrical.id,
      location: 'Kitchen',
    },
  });

  for (const part of DEMO_PARTS) {
    const { id, ...rest } = part;
    await prisma.part.upsert({ where: { id }, update: rest, create: { id, ...rest } });
  }

  // Fixed link ids rather than the (partId, itemId, systemId) compound unique:
  // two of its three columns are NULL here, and an upsert `where` reads much
  // better as a single id.
  await prisma.partLink.upsert({
    where: { id: 'seed-link-air-filter-hvac' },
    update: {},
    create: {
      id: 'seed-link-air-filter-hvac',
      partId: 'seed-part-air-filter',
      systemId: DEMO_SYSTEM_ID,
      location: 'Upstairs return',
      quantityInstalled: 1,
    },
  });
  await prisma.partLink.upsert({
    where: { id: 'seed-link-bulb-kitchen' },
    update: {},
    create: {
      id: 'seed-link-bulb-kitchen',
      partId: 'seed-part-can-light-bulb',
      itemId: DEMO_ITEM_ID,
      location: 'Kitchen ceiling',
      quantityInstalled: 6,
    },
  });
}

async function main() {
  for (const c of CATEGORIES) {
    await prisma.category.upsert({
      where: { slug: c.slug },
      create: c,
      update: { name: c.name, icon: c.icon, sortOrder: c.sortOrder },
    });
  }
  console.log(`Seeded ${CATEGORIES.length} categories.`);

  await prisma.user.upsert({
    where: { id: SYSTEM_AUTO_COMPLETE_USER_ID },
    update: {},
    create: {
      id: SYSTEM_AUTO_COMPLETE_USER_ID,
      email: 'system+auto-complete@house-manager.local',
      name: 'System (Auto-complete)',
    },
  });
  console.log(`Seeded ${SYSTEM_AUTO_COMPLETE_USER_ID} user.`);

  await seedDemoParts();
  console.log(`Seeded ${DEMO_PARTS.length} demo parts (system-linked, item-linked, unlinked).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
