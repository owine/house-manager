import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;

beforeAll(async () => {
  ctx = await setupIntegration();
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.vendor.deleteMany();
});

describe('Vendor CRUD', () => {
  it('creates and reads a vendor', async () => {
    const v = await ctx.prisma.vendor.create({
      data: { name: 'Plumber Pete', kind: 'plumber', tags: ['emergency'] },
    });
    const read = await ctx.prisma.vendor.findUnique({ where: { id: v.id } });
    expect(read?.name).toBe('Plumber Pete');
    expect(read?.tags).toEqual(['emergency']);
  });

  it('updates a vendor', async () => {
    const v = await ctx.prisma.vendor.create({ data: { name: 'Original' } });
    await ctx.prisma.vendor.update({ where: { id: v.id }, data: { name: 'Updated' } });
    const read = await ctx.prisma.vendor.findUnique({ where: { id: v.id } });
    expect(read?.name).toBe('Updated');
  });

  it('hard-deletes vendor and SetNulls related ServiceRecord.vendorId', async () => {
    const v = await ctx.prisma.vendor.create({ data: { name: 'Doomed' } });
    const sr = await ctx.prisma.serviceRecord.create({
      data: { vendorId: v.id, performedOn: new Date(), summary: 'tune-up' },
    });
    await ctx.prisma.vendor.delete({ where: { id: v.id } });
    const orphaned = await ctx.prisma.serviceRecord.findUnique({ where: { id: sr.id } });
    expect(orphaned).not.toBeNull();
    expect(orphaned?.vendorId).toBeNull();
  });
});
