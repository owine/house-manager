import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

// NOTE: Cascade delete from Item → Warranty is already covered in tests/integration/items.test.ts

let ctx: IntegrationContext;
let categoryId: string;
let itemId: string;

beforeAll(async () => {
  ctx = await setupIntegration();

  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'appliances' },
    create: { slug: 'appliances', name: 'Appliances', sortOrder: 30 },
    update: {},
  });
  categoryId = cat.id;

  const item = await ctx.prisma.item.create({
    data: { name: 'Refrigerator', categoryId },
  });
  itemId = item.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.warranty.deleteMany();
});

describe('Warranty CRUD', () => {
  it('creates a warranty with all fields', async () => {
    const w = await ctx.prisma.warranty.create({
      data: {
        itemId,
        provider: 'Samsung Extended Care',
        policyNumber: 'POL-2024-001',
        startsOn: new Date('2024-01-15'),
        endsOn: new Date('2027-01-15'),
        coverage: 'Parts and labour, excluding cosmetic damage',
        cost: 249.99,
      },
    });

    expect(w.id).toBeTruthy();
    expect(w.itemId).toBe(itemId);
    expect(w.provider).toBe('Samsung Extended Care');
    expect(w.policyNumber).toBe('POL-2024-001');
    expect(w.coverage).toBe('Parts and labour, excluding cosmetic damage');
    expect(w.cost?.toNumber()).toBe(249.99);
    expect(w.startsOn).toEqual(new Date('2024-01-15'));
    expect(w.endsOn).toEqual(new Date('2027-01-15'));
  });

  it('creates a warranty with only required fields', async () => {
    const w = await ctx.prisma.warranty.create({
      data: {
        itemId,
        provider: 'Basic Warranty',
        startsOn: new Date('2024-06-01'),
        endsOn: new Date('2026-06-01'),
      },
    });

    expect(w.id).toBeTruthy();
    expect(w.itemId).toBe(itemId);
    expect(w.policyNumber).toBeNull();
    expect(w.coverage).toBeNull();
    expect(w.cost).toBeNull();
  });

  it('updates endsOn; re-reads and confirms', async () => {
    const w = await ctx.prisma.warranty.create({
      data: {
        itemId,
        provider: 'Original Warranty',
        startsOn: new Date('2024-01-01'),
        endsOn: new Date('2026-01-01'),
      },
    });

    await ctx.prisma.warranty.update({
      where: { id: w.id },
      data: { endsOn: new Date('2028-01-01') },
    });

    const updated = await ctx.prisma.warranty.findUnique({ where: { id: w.id } });
    expect(updated?.endsOn).toEqual(new Date('2028-01-01'));
  });

  it('deletes a warranty; findUnique returns null', async () => {
    const w = await ctx.prisma.warranty.create({
      data: {
        itemId,
        provider: 'To Be Deleted',
        startsOn: new Date('2024-01-01'),
        endsOn: new Date('2026-01-01'),
      },
    });

    await ctx.prisma.warranty.delete({ where: { id: w.id } });

    const deleted = await ctx.prisma.warranty.findUnique({ where: { id: w.id } });
    expect(deleted).toBeNull();
  });
});

describe('Warranty queries', () => {
  it('lists warranties for an item ordered by endsOn descending', async () => {
    await ctx.prisma.warranty.createMany({
      data: [
        {
          itemId,
          provider: 'Early Expiry',
          startsOn: new Date('2024-01-01'),
          endsOn: new Date('2025-01-01'),
        },
        {
          itemId,
          provider: 'Late Expiry',
          startsOn: new Date('2024-01-01'),
          endsOn: new Date('2029-01-01'),
        },
        {
          itemId,
          provider: 'Mid Expiry',
          startsOn: new Date('2024-01-01'),
          endsOn: new Date('2027-01-01'),
        },
      ],
    });

    const warranties = await ctx.prisma.warranty.findMany({
      where: { itemId },
      orderBy: { endsOn: 'desc' },
    });

    expect(warranties).toHaveLength(3);
    expect(warranties[0].provider).toBe('Late Expiry');
    expect(warranties[2].provider).toBe('Early Expiry');
  });

  it('includes item relation when fetching a single warranty', async () => {
    const w = await ctx.prisma.warranty.create({
      data: {
        itemId,
        provider: 'Relation Test Warranty',
        startsOn: new Date('2024-01-01'),
        endsOn: new Date('2026-01-01'),
      },
    });

    const fetched = await ctx.prisma.warranty.findUnique({
      where: { id: w.id },
      include: { item: { select: { id: true, name: true } } },
    });

    expect(fetched?.item).toEqual({ id: itemId, name: 'Refrigerator' });
  });
});
