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
let actions: typeof import('@/lib/vendors/actions');
let categoryId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  // setupIntegration() set DATABASE_URL; importing the action module after that
  // makes its lazy prisma client connect to the same test database.
  actions = await import('@/lib/vendors/actions');

  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'vendor-delete-flow' },
    create: { slug: 'vendor-delete-flow', name: 'HVAC', sortOrder: 21 },
    update: {},
  });
  categoryId = cat.id;
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

describe('tryDeleteVendor', () => {
  it('deletes a vendor with no links', async () => {
    const v = await ctx.prisma.vendor.create({ data: { name: 'Lonely Vendor' } });

    const result = await actions.tryDeleteVendor(v.id);

    expect(result).toEqual({ ok: true });
    const gone = await ctx.prisma.vendor.findUnique({ where: { id: v.id } });
    expect(gone).toBeNull();
  });

  it('reports link counts for a vendor with one ItemVendor link', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId } });
    const v = await ctx.prisma.vendor.create({ data: { name: 'Acme HVAC' } });
    await ctx.prisma.itemVendor.create({
      data: { itemId: item.id, vendorId: v.id, role: 'INSTALLER' },
    });

    const result = await actions.tryDeleteVendor(v.id);

    expect(result).toEqual({ ok: false, hasLinks: true, itemCount: 1, systemCount: 0 });
    const stillThere = await ctx.prisma.vendor.findUnique({ where: { id: v.id } });
    expect(stillThere).not.toBeNull();
  });

  it('reports counts for a vendor with two ItemVendor + one SystemVendor links', async () => {
    const item1 = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId } });
    const item2 = await ctx.prisma.item.create({ data: { name: 'AC', categoryId } });
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const v = await ctx.prisma.vendor.create({ data: { name: 'Acme HVAC' } });

    await ctx.prisma.itemVendor.create({
      data: { itemId: item1.id, vendorId: v.id, role: 'INSTALLER' },
    });
    await ctx.prisma.itemVendor.create({
      data: { itemId: item2.id, vendorId: v.id, role: 'SERVICE' },
    });
    await ctx.prisma.systemVendor.create({
      data: { systemId: sys.id, vendorId: v.id, role: 'INSTALLER' },
    });

    const result = await actions.tryDeleteVendor(v.id);

    expect(result).toEqual({ ok: false, hasLinks: true, itemCount: 2, systemCount: 1 });
  });
});

describe('convertVendorLinksToFreeform', () => {
  it('converts links to freeform and deletes vendor without violating XOR CHECK', async () => {
    const item1 = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId } });
    const item2 = await ctx.prisma.item.create({ data: { name: 'AC', categoryId } });
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const v = await ctx.prisma.vendor.create({ data: { name: 'ABC HVAC' } });

    const iv1 = await ctx.prisma.itemVendor.create({
      data: { itemId: item1.id, vendorId: v.id, role: 'INSTALLER' },
    });
    const iv2 = await ctx.prisma.itemVendor.create({
      data: { itemId: item2.id, vendorId: v.id, role: 'SERVICE' },
    });
    const sv = await ctx.prisma.systemVendor.create({
      data: { systemId: sys.id, vendorId: v.id, role: 'INSTALLER' },
    });

    const result = await actions.convertVendorLinksToFreeform(v.id);

    expect(result).toEqual({ ok: true, convertedItemCount: 2, convertedSystemCount: 1 });

    const gone = await ctx.prisma.vendor.findUnique({ where: { id: v.id } });
    expect(gone).toBeNull();

    for (const id of [iv1.id, iv2.id]) {
      const row = await ctx.prisma.itemVendor.findUnique({ where: { id } });
      expect(row).not.toBeNull();
      expect(row?.vendorId).toBeNull();
      expect(row?.freeformName).toBe('ABC HVAC');
    }

    const svRow = await ctx.prisma.systemVendor.findUnique({ where: { id: sv.id } });
    expect(svRow).not.toBeNull();
    expect(svRow?.vendorId).toBeNull();
    expect(svRow?.freeformName).toBe('ABC HVAC');
  });

  it('works on a vendor with zero links', async () => {
    const v = await ctx.prisma.vendor.create({ data: { name: 'Lonely Vendor' } });

    const result = await actions.convertVendorLinksToFreeform(v.id);

    expect(result).toEqual({ ok: true, convertedItemCount: 0, convertedSystemCount: 0 });
    const gone = await ctx.prisma.vendor.findUnique({ where: { id: v.id } });
    expect(gone).toBeNull();
  });

  it('returns not_found if the vendor does not exist', async () => {
    const result = await actions.convertVendorLinksToFreeform('does-not-exist');
    expect(result).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('deleteVendorAndLinks', () => {
  it('deletes all link rows and the vendor', async () => {
    const item1 = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId } });
    const item2 = await ctx.prisma.item.create({ data: { name: 'AC', categoryId } });
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const v = await ctx.prisma.vendor.create({ data: { name: 'Acme HVAC' } });

    await ctx.prisma.itemVendor.create({
      data: { itemId: item1.id, vendorId: v.id, role: 'INSTALLER' },
    });
    await ctx.prisma.itemVendor.create({
      data: { itemId: item2.id, vendorId: v.id, role: 'SERVICE' },
    });
    await ctx.prisma.systemVendor.create({
      data: { systemId: sys.id, vendorId: v.id, role: 'INSTALLER' },
    });

    const result = await actions.deleteVendorAndLinks(v.id);

    expect(result).toEqual({ ok: true, deletedItemCount: 2, deletedSystemCount: 1 });

    const gone = await ctx.prisma.vendor.findUnique({ where: { id: v.id } });
    expect(gone).toBeNull();

    const ivLeft = await ctx.prisma.itemVendor.findMany({ where: { vendorId: v.id } });
    expect(ivLeft).toHaveLength(0);
    const svLeft = await ctx.prisma.systemVendor.findMany({ where: { vendorId: v.id } });
    expect(svLeft).toHaveLength(0);

    // Items themselves remain.
    const itemsLeft = await ctx.prisma.item.count({
      where: { id: { in: [item1.id, item2.id] } },
    });
    expect(itemsLeft).toBe(2);
  });

  it('works on a vendor with zero links', async () => {
    const v = await ctx.prisma.vendor.create({ data: { name: 'Lonely Vendor' } });

    const result = await actions.deleteVendorAndLinks(v.id);

    expect(result).toEqual({ ok: true, deletedItemCount: 0, deletedSystemCount: 0 });
    const gone = await ctx.prisma.vendor.findUnique({ where: { id: v.id } });
    expect(gone).toBeNull();
  });
});

describe('auth gate', () => {
  it('all three actions reject unauthenticated callers', async () => {
    currentUserId = null;
    const v = await ctx.prisma.vendor.create({ data: { name: 'Guarded' } });

    expect(await actions.tryDeleteVendor(v.id)).toEqual({
      ok: false,
      formError: 'Unauthorized',
    });
    expect(await actions.convertVendorLinksToFreeform(v.id)).toEqual({
      ok: false,
      formError: 'Unauthorized',
    });
    expect(await actions.deleteVendorAndLinks(v.id)).toEqual({
      ok: false,
      formError: 'Unauthorized',
    });

    const stillThere = await ctx.prisma.vendor.findUnique({ where: { id: v.id } });
    expect(stillThere).not.toBeNull();
  });
});
