import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;
let categoryId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'hvac' },
    create: { slug: 'hvac', name: 'HVAC', sortOrder: 20 },
    update: {},
  });
  categoryId = cat.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.warranty.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.note.deleteMany();
  await ctx.prisma.item.deleteMany();
});

describe('Item CRUD', () => {
  it('creates an item with metadata that round-trips through Prisma', async () => {
    const item = await ctx.prisma.item.create({
      data: {
        name: 'Furnace',
        categoryId,
        metadata: { btu: 80000, fuelType: 'gas' },
      },
    });
    expect(item.metadata).toEqual({ btu: 80000, fuelType: 'gas' });
  });

  it('soft-archives an item by setting archivedAt', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'X', categoryId } });
    await ctx.prisma.item.update({ where: { id: item.id }, data: { archivedAt: new Date() } });
    const read = await ctx.prisma.item.findUnique({ where: { id: item.id } });
    expect(read?.archivedAt).toBeInstanceOf(Date);
  });

  it('cascade-deletes Warranty when Item is hard-deleted', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'X', categoryId } });
    const w = await ctx.prisma.warranty.create({
      data: {
        itemId: item.id,
        provider: 'Acme',
        startsOn: new Date(),
        endsOn: new Date(),
      },
    });
    await ctx.prisma.item.delete({ where: { id: item.id } });
    const orphan = await ctx.prisma.warranty.findUnique({ where: { id: w.id } });
    expect(orphan).toBeNull();
  });

  it('SetNulls ServiceRecord.itemId when Item is hard-deleted', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'X', categoryId } });
    const sr = await ctx.prisma.serviceRecord.create({
      data: { itemId: item.id, performedOn: new Date(), summary: 'x' },
    });
    await ctx.prisma.item.delete({ where: { id: item.id } });
    const read = await ctx.prisma.serviceRecord.findUnique({ where: { id: sr.id } });
    expect(read?.itemId).toBeNull();
  });
});
