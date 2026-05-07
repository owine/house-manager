import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let currentUserId: string | null = 'test-user';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => (currentUserId ? { user: { id: currentUserId } } : null)),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/search/client', () => ({
  enqueueSearchIndex: vi.fn(async () => {}),
}));

let ctx: IntegrationContext;
let actions: typeof import('@/lib/items/actions');
let categoryId: string;
let categorySlug: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  actions = await import('@/lib/items/actions');
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'item-vendors-tests' },
    create: { slug: 'item-vendors-tests', name: 'Appliance', sortOrder: 23 },
    update: {},
  });
  categoryId = cat.id;
  categorySlug = cat.slug;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  currentUserId = 'test-user';
  await ctx.prisma.itemVendor.deleteMany();
  await ctx.prisma.systemVendor.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.system.deleteMany();
  await ctx.prisma.vendor.deleteMany();
});

describe('addItemVendor / updateItemVendor / removeItemVendor', () => {
  it('round-trips a vendor link with vendorId', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'Fridge', categoryId } });
    const vendor = await ctx.prisma.vendor.create({ data: { name: 'Acme Appliance' } });

    const add = await actions.addItemVendor({
      itemId: item.id,
      vendorId: vendor.id,
      freeformName: null,
      role: 'INSTALLER',
      notes: null,
    });
    expect(add.ok).toBe(true);
    if (!add.ok) return;

    const row = await ctx.prisma.itemVendor.findUnique({ where: { id: add.data.id } });
    expect(row?.itemId).toBe(item.id);
    expect(row?.vendorId).toBe(vendor.id);
    expect(row?.role).toBe('INSTALLER');

    const upd = await actions.updateItemVendor({
      id: add.data.id,
      vendorId: vendor.id,
      freeformName: null,
      role: 'SERVICE',
      notes: 'updated',
    });
    expect(upd.ok).toBe(true);

    const after = await ctx.prisma.itemVendor.findUnique({ where: { id: add.data.id } });
    expect(after?.role).toBe('SERVICE');
    expect(after?.notes).toBe('updated');

    const del = await actions.removeItemVendor({ id: add.data.id });
    expect(del.ok).toBe(true);
    const gone = await ctx.prisma.itemVendor.findUnique({ where: { id: add.data.id } });
    expect(gone).toBeNull();
  });

  it('accepts a freeform-only link', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'Fridge', categoryId } });
    const r = await actions.addItemVendor({
      itemId: item.id,
      vendorId: null,
      freeformName: 'Free vendor',
      role: 'OTHER',
      notes: null,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a link with both vendorId and freeformName', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'Fridge', categoryId } });
    const vendor = await ctx.prisma.vendor.create({ data: { name: 'Acme' } });
    const r = await actions.addItemVendor({
      itemId: item.id,
      vendorId: vendor.id,
      freeformName: 'also bob',
      role: 'INSTALLER',
      notes: null,
    });
    expect(r.ok).toBe(false);
  });

  it('returns Unauthorized when no session', async () => {
    currentUserId = null;
    const r = await actions.addItemVendor({
      itemId: 'x',
      vendorId: null,
      freeformName: 'nope',
      role: 'OTHER',
      notes: null,
    });
    expect(r).toEqual({ ok: false, formError: 'Unauthorized' });
  });
});

describe('createItem / updateItem with systemId', () => {
  it('createItem with systemId assigns the item to the system', async () => {
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const r = await actions.createItem({
      name: 'Furnace',
      categorySlug,
      systemId: sys.id,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await ctx.prisma.item.findUnique({ where: { id: r.data.id } });
    expect(row?.systemId).toBe(sys.id);
  });

  it('createItem without systemId leaves it null', async () => {
    const r = await actions.createItem({ name: 'Lamp', categorySlug });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await ctx.prisma.item.findUnique({ where: { id: r.data.id } });
    expect(row?.systemId).toBeNull();
  });

  it('updateItem changes systemId, then unsets to null', async () => {
    const sysA = await ctx.prisma.system.create({ data: { name: 'A' } });
    const sysB = await ctx.prisma.system.create({ data: { name: 'B' } });
    const item = await ctx.prisma.item.create({
      data: { name: 'Furnace', categoryId, systemId: sysA.id },
    });

    const r1 = await actions.updateItem({ id: item.id, systemId: sysB.id });
    expect(r1.ok).toBe(true);
    let row = await ctx.prisma.item.findUnique({ where: { id: item.id } });
    expect(row?.systemId).toBe(sysB.id);

    const r2 = await actions.updateItem({ id: item.id, systemId: null });
    expect(r2.ok).toBe(true);
    row = await ctx.prisma.item.findUnique({ where: { id: item.id } });
    expect(row?.systemId).toBeNull();
  });
});
