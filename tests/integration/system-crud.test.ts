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
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.system.deleteMany();
});

describe('System CRUD', () => {
  it('creates a System row with the given name', async () => {
    const sys = await ctx.prisma.system.create({
      data: { name: 'Main HVAC', kind: 'hvac', location: 'Basement' },
    });
    const found = await ctx.prisma.system.findUnique({ where: { id: sys.id } });
    expect(found?.name).toBe('Main HVAC');
    expect(found?.kind).toBe('hvac');
  });

  it('assigns multiple items to a system and queries them via system.items', async () => {
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const a = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId } });
    const b = await ctx.prisma.item.create({ data: { name: 'AC', categoryId } });

    await ctx.prisma.item.update({ where: { id: a.id }, data: { systemId: sys.id } });
    await ctx.prisma.item.update({ where: { id: b.id }, data: { systemId: sys.id } });

    const withItems = await ctx.prisma.system.findUnique({
      where: { id: sys.id },
      include: { items: true },
    });
    expect(withItems?.items).toHaveLength(2);
    expect(withItems?.items.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('unassigning an item (systemId: null) drops it from system.items', async () => {
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const a = await ctx.prisma.item.create({
      data: { name: 'Furnace', categoryId, systemId: sys.id },
    });
    const b = await ctx.prisma.item.create({
      data: { name: 'AC', categoryId, systemId: sys.id },
    });

    await ctx.prisma.item.update({ where: { id: a.id }, data: { systemId: null } });

    const withItems = await ctx.prisma.system.findUnique({
      where: { id: sys.id },
      include: { items: true },
    });
    expect(withItems?.items).toHaveLength(1);
    expect(withItems?.items[0]?.id).toBe(b.id);
  });

  it('deleting a System sets remaining Item.systemId to null (SetNull) without deleting items', async () => {
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const a = await ctx.prisma.item.create({
      data: { name: 'Furnace', categoryId, systemId: sys.id },
    });

    await ctx.prisma.system.delete({ where: { id: sys.id } });

    const item = await ctx.prisma.item.findUnique({ where: { id: a.id } });
    expect(item).not.toBeNull();
    expect(item?.systemId).toBeNull();
  });

  it('archiving a System leaves member items with systemId still set (no cascade)', async () => {
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const a = await ctx.prisma.item.create({
      data: { name: 'Furnace', categoryId, systemId: sys.id },
    });

    await ctx.prisma.system.update({
      where: { id: sys.id },
      data: { archivedAt: new Date() },
    });

    const item = await ctx.prisma.item.findUnique({ where: { id: a.id } });
    expect(item?.systemId).toBe(sys.id);

    const archived = await ctx.prisma.system.findUnique({ where: { id: sys.id } });
    expect(archived?.archivedAt).toBeInstanceOf(Date);
  });
});
