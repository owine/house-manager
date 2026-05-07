import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;
let categoryId: string;
let getSystemDetail: typeof import('@/lib/systems/queries').getSystemDetail;

beforeAll(async () => {
  ctx = await setupIntegration();
  // Import after setupIntegration so the singleton in @/lib/db reads the
  // test DATABASE_URL set by the helper.
  ({ getSystemDetail } = await import('@/lib/systems/queries'));

  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'system-detail-query' },
    create: { slug: 'system-detail-query', name: 'HVAC', sortOrder: 30 },
    update: {},
  });
  categoryId = cat.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.item.deleteMany({});
  await ctx.prisma.system.deleteMany({});
});

describe('getSystemDetail', () => {
  it('returns system + rollup with priced active components summed', async () => {
    const sys = await ctx.prisma.system.create({
      data: {
        name: 'Furnace + AC',
        installCost: new Prisma.Decimal('1500.00'),
        items: {
          create: [
            { name: 'Furnace', categoryId, purchasePrice: new Prisma.Decimal('800.00') },
            { name: 'AC unit', categoryId, purchasePrice: new Prisma.Decimal('1200.50') },
          ],
        },
      },
    });

    const result = await getSystemDetail(sys.id);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.system.id).toBe(sys.id);
    expect(result.system.items).toHaveLength(2);
    expect(result.rollup.componentsSubtotal.toString()).toBe('2000.5');
    expect(result.rollup.installCost.toString()).toBe('1500');
    expect(result.rollup.total.toString()).toBe('3500.5');
    expect(result.rollup.hasAnyData).toBe(true);
  });

  it('excludes archived components from the rollup and from items[]', async () => {
    const sys = await ctx.prisma.system.create({
      data: {
        name: 'Mixed',
        items: {
          create: [
            { name: 'Active', categoryId, purchasePrice: new Prisma.Decimal('100') },
            {
              name: 'Archived',
              categoryId,
              purchasePrice: new Prisma.Decimal('999'),
              archivedAt: new Date('2026-01-01'),
            },
          ],
        },
      },
    });

    const result = await getSystemDetail(sys.id);
    expect(result).not.toBeNull();
    if (!result) return;
    // Query filters archived items at the DB level — they don't appear in items[].
    expect(result.system.items.map((i) => i.name)).toEqual(['Active']);
    expect(result.rollup.componentsSubtotal.toString()).toBe('100');
    expect(result.rollup.total.toString()).toBe('100');
  });

  it('returns null when the system does not exist', async () => {
    const result = await getSystemDetail('cnonexistent000000000000');
    expect(result).toBeNull();
  });
});
