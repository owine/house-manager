import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;
let categoryId: string;
let itemId: string;
let systemId: string;

beforeAll(async () => {
  ctx = await setupIntegration();

  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'multi-target-warranty' },
    create: { slug: 'multi-target-warranty', name: 'HVAC', sortOrder: 20 },
    update: {},
  });
  categoryId = cat.id;

  const sys = await ctx.prisma.system.create({
    data: { name: 'HVAC system' },
  });
  systemId = sys.id;

  const item = await ctx.prisma.item.create({
    data: { name: 'Furnace', categoryId, systemId },
  });
  itemId = item.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.warranty.deleteMany();
});

describe('WarrantyTarget multi-target', () => {
  it('creates a warranty with two targets (one item, one system)', async () => {
    const w = await ctx.prisma.warranty.create({
      data: {
        provider: 'Combined coverage',
        startsOn: new Date('2024-01-01'),
        endsOn: new Date('2026-01-01'),
        targets: { create: [{ itemId }, { systemId }] },
      },
      include: { targets: true },
    });

    expect(w.targets).toHaveLength(2);
    const targetItemIds = w.targets.map((t) => t.itemId).filter(Boolean);
    const targetSystemIds = w.targets.map((t) => t.systemId).filter(Boolean);
    expect(targetItemIds).toEqual([itemId]);
    expect(targetSystemIds).toEqual([systemId]);
  });

  it('rejects a target row with both itemId and systemId set (XOR CHECK)', async () => {
    const w = await ctx.prisma.warranty.create({
      data: {
        provider: 'XOR violation parent',
        startsOn: new Date('2024-01-01'),
        endsOn: new Date('2026-01-01'),
      },
    });
    await expect(
      ctx.prisma.$executeRaw`
        INSERT INTO warranty_targets (id, "warrantyId", "itemId", "systemId")
        VALUES ('wt_xor_both', ${w.id}, ${itemId}, ${systemId})
      `,
    ).rejects.toThrow();
  });

  it('rejects a target row with neither itemId nor systemId set (XOR CHECK)', async () => {
    const w = await ctx.prisma.warranty.create({
      data: {
        provider: 'XOR violation parent (none)',
        startsOn: new Date('2024-01-01'),
        endsOn: new Date('2026-01-01'),
      },
    });
    await expect(
      ctx.prisma.$executeRaw`
        INSERT INTO warranty_targets (id, "warrantyId", "itemId", "systemId")
        VALUES ('wt_xor_none', ${w.id}, NULL, NULL)
      `,
    ).rejects.toThrow();
  });

  it('rejects duplicate (warrantyId, itemId, systemId) (unique constraint)', async () => {
    const w = await ctx.prisma.warranty.create({
      data: {
        provider: 'Duplicate target parent',
        startsOn: new Date('2024-01-01'),
        endsOn: new Date('2026-01-01'),
        targets: { create: [{ itemId }] },
      },
    });
    await expect(
      ctx.prisma.warrantyTarget.create({
        data: { warrantyId: w.id, itemId },
      }),
    ).rejects.toThrow();
  });
});
