import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;
let categoryId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'vendor-link-crud' },
    create: { slug: 'vendor-link-crud', name: 'HVAC', sortOrder: 20 },
    update: {},
  });
  categoryId = cat.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.itemVendor.deleteMany();
  await ctx.prisma.systemVendor.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.system.deleteMany();
  await ctx.prisma.vendor.deleteMany();
});

describe('ItemVendor', () => {
  it('creates a row linked to a real Vendor', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId } });
    const vendor = await ctx.prisma.vendor.create({ data: { name: 'Acme HVAC' } });

    const link = await ctx.prisma.itemVendor.create({
      data: { itemId: item.id, vendorId: vendor.id, role: 'INSTALLER' },
    });

    expect(link.itemId).toBe(item.id);
    expect(link.vendorId).toBe(vendor.id);
    expect(link.freeformName).toBeNull();
    expect(link.role).toBe('INSTALLER');
  });

  it('creates a row with freeformName only', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId } });

    const link = await ctx.prisma.itemVendor.create({
      data: { itemId: item.id, freeformName: 'Bob the Plumber', role: 'SERVICE' },
    });

    expect(link.vendorId).toBeNull();
    expect(link.freeformName).toBe('Bob the Plumber');
  });

  it('DB rejects a row with both vendorId and freeformName set (XOR CHECK)', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId } });
    const vendor = await ctx.prisma.vendor.create({ data: { name: 'Acme HVAC' } });

    await expect(
      ctx.prisma.$executeRaw`
        INSERT INTO item_vendors (id, "itemId", "vendorId", "freeformName", role)
        VALUES ('iv_xor_both', ${item.id}, ${vendor.id}, 'Bob', 'INSTALLER'::"VendorRole")
      `,
    ).rejects.toThrow();
  });

  it('DB rejects a row with neither vendorId nor freeformName set (XOR CHECK)', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId } });

    await expect(
      ctx.prisma.$executeRaw`
        INSERT INTO item_vendors (id, "itemId", "vendorId", "freeformName", role)
        VALUES ('iv_xor_none', ${item.id}, NULL, NULL, 'INSTALLER'::"VendorRole")
      `,
    ).rejects.toThrow();
  });

  it('cascades delete when the parent Item is removed', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId } });
    const vendor = await ctx.prisma.vendor.create({ data: { name: 'Acme HVAC' } });
    await ctx.prisma.itemVendor.create({
      data: { itemId: item.id, vendorId: vendor.id, role: 'INSTALLER' },
    });

    await ctx.prisma.item.delete({ where: { id: item.id } });

    const remaining = await ctx.prisma.itemVendor.findMany({ where: { itemId: item.id } });
    expect(remaining).toHaveLength(0);
  });
});

describe('SystemVendor', () => {
  it('creates a row linked to a real Vendor', async () => {
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const vendor = await ctx.prisma.vendor.create({ data: { name: 'Acme HVAC' } });

    const link = await ctx.prisma.systemVendor.create({
      data: { systemId: sys.id, vendorId: vendor.id, role: 'INSTALLER' },
    });

    expect(link.systemId).toBe(sys.id);
    expect(link.vendorId).toBe(vendor.id);
    expect(link.freeformName).toBeNull();
  });

  it('creates a row with freeformName only', async () => {
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });

    const link = await ctx.prisma.systemVendor.create({
      data: { systemId: sys.id, freeformName: 'Bob the Plumber', role: 'SERVICE' },
    });

    expect(link.vendorId).toBeNull();
    expect(link.freeformName).toBe('Bob the Plumber');
  });

  it('DB rejects a row with both vendorId and freeformName set (XOR CHECK)', async () => {
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const vendor = await ctx.prisma.vendor.create({ data: { name: 'Acme HVAC' } });

    await expect(
      ctx.prisma.$executeRaw`
        INSERT INTO system_vendors (id, "systemId", "vendorId", "freeformName", role)
        VALUES ('sv_xor_both', ${sys.id}, ${vendor.id}, 'Bob', 'INSTALLER'::"VendorRole")
      `,
    ).rejects.toThrow();
  });

  it('DB rejects a row with neither vendorId nor freeformName set (XOR CHECK)', async () => {
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });

    await expect(
      ctx.prisma.$executeRaw`
        INSERT INTO system_vendors (id, "systemId", "vendorId", "freeformName", role)
        VALUES ('sv_xor_none', ${sys.id}, NULL, NULL, 'INSTALLER'::"VendorRole")
      `,
    ).rejects.toThrow();
  });

  it('cascades delete when the parent System is removed', async () => {
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const vendor = await ctx.prisma.vendor.create({ data: { name: 'Acme HVAC' } });
    await ctx.prisma.systemVendor.create({
      data: { systemId: sys.id, vendorId: vendor.id, role: 'INSTALLER' },
    });

    await ctx.prisma.system.delete({ where: { id: sys.id } });

    const remaining = await ctx.prisma.systemVendor.findMany({ where: { systemId: sys.id } });
    expect(remaining).toHaveLength(0);
  });
});

describe('Vendor delete (Restrict)', () => {
  it('blocks deleting a Vendor that has linked ItemVendor rows', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId } });
    const vendor = await ctx.prisma.vendor.create({ data: { name: 'Acme HVAC' } });
    await ctx.prisma.itemVendor.create({
      data: { itemId: item.id, vendorId: vendor.id, role: 'INSTALLER' },
    });

    await expect(ctx.prisma.vendor.delete({ where: { id: vendor.id } })).rejects.toThrow();

    const stillThere = await ctx.prisma.vendor.findUnique({ where: { id: vendor.id } });
    expect(stillThere).not.toBeNull();
  });

  it('blocks deleting a Vendor that has linked SystemVendor rows', async () => {
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const vendor = await ctx.prisma.vendor.create({ data: { name: 'Acme HVAC' } });
    await ctx.prisma.systemVendor.create({
      data: { systemId: sys.id, vendorId: vendor.id, role: 'INSTALLER' },
    });

    await expect(ctx.prisma.vendor.delete({ where: { id: vendor.id } })).rejects.toThrow();
  });

  it('allows deleting a Vendor with no linked rows', async () => {
    const vendor = await ctx.prisma.vendor.create({ data: { name: 'Unused Vendor' } });

    await ctx.prisma.vendor.delete({ where: { id: vendor.id } });

    const gone = await ctx.prisma.vendor.findUnique({ where: { id: vendor.id } });
    expect(gone).toBeNull();
  });
});
