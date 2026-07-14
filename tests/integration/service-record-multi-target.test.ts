import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type IntegrationContext,
  setupIntegration,
  teardownIntegration,
  todayCal,
} from './helpers';

let ctx: IntegrationContext;
let categoryId: string;
let itemId: string;
let systemId: string;

beforeAll(async () => {
  ctx = await setupIntegration();

  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'multi-target-hvac' },
    create: { slug: 'multi-target-hvac', name: 'HVAC', sortOrder: 20 },
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
  await ctx.prisma.serviceRecord.deleteMany();
});

describe('ServiceRecordTarget multi-target', () => {
  it('creates a record with two targets (one item, one system)', async () => {
    const sr = await ctx.prisma.serviceRecord.create({
      data: {
        performedOn: new Date('2024-03-15'),
        summary: 'Combined annual service',
        targets: { create: [{ itemId }, { systemId }] },
      },
      include: { targets: true },
    });

    expect(sr.targets).toHaveLength(2);
    const targetItemIds = sr.targets.map((t) => t.itemId).filter(Boolean);
    const targetSystemIds = sr.targets.map((t) => t.systemId).filter(Boolean);
    expect(targetItemIds).toEqual([itemId]);
    expect(targetSystemIds).toEqual([systemId]);
  });

  it('rejects a target row with both itemId and systemId set (XOR CHECK)', async () => {
    const sr = await ctx.prisma.serviceRecord.create({
      data: { performedOn: todayCal(), summary: 'XOR violation parent' },
    });
    await expect(
      ctx.prisma.$executeRaw`
        INSERT INTO service_record_targets (id, "serviceRecordId", "itemId", "systemId")
        VALUES ('srt_xor_both', ${sr.id}, ${itemId}, ${systemId})
      `,
    ).rejects.toThrow();
  });

  it('rejects a target row with neither itemId nor systemId set (XOR CHECK)', async () => {
    const sr = await ctx.prisma.serviceRecord.create({
      data: { performedOn: todayCal(), summary: 'XOR violation parent (none)' },
    });
    await expect(
      ctx.prisma.$executeRaw`
        INSERT INTO service_record_targets (id, "serviceRecordId", "itemId", "systemId")
        VALUES ('srt_xor_none', ${sr.id}, NULL, NULL)
      `,
    ).rejects.toThrow();
  });

  it('rejects duplicate (serviceRecordId, itemId, systemId) (unique constraint)', async () => {
    const sr = await ctx.prisma.serviceRecord.create({
      data: {
        performedOn: todayCal(),
        summary: 'Duplicate target parent',
        targets: { create: [{ itemId }] },
      },
    });
    await expect(
      ctx.prisma.serviceRecordTarget.create({
        data: { serviceRecordId: sr.id, itemId },
      }),
    ).rejects.toThrow();
  });
});
