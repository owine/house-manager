import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'u1', name: 'Test' } })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/queue')>();
  return {
    ...orig,
    getBoss: vi.fn(async () => ({
      send: vi.fn(async () => 'fake-job-id'),
    })),
  };
});

let ctx: IntegrationContext;
let categoryId: string;
let itemId: string;
let vendorId: string;

beforeAll(async () => {
  ctx = await setupIntegration();

  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'hvac' },
    create: { slug: 'hvac', name: 'HVAC', sortOrder: 20 },
    update: {},
  });
  categoryId = cat.id;

  const item = await ctx.prisma.item.create({
    data: { name: 'Furnace', categoryId },
  });
  itemId = item.id;

  const vendor = await ctx.prisma.vendor.create({
    data: { name: 'HVAC Pro Services' },
  });
  vendorId = vendor.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.serviceRecord.deleteMany();
});

describe('ServiceRecord CRUD', () => {
  it('creates a record with both item-target and vendorId', async () => {
    const sr = await ctx.prisma.serviceRecord.create({
      data: {
        vendorId,
        performedOn: new Date('2024-03-15'),
        cost: 249.99,
        summary: 'Annual furnace tune-up',
        notes: 'Replaced filter, checked burners.',
        targets: { create: [{ itemId }] },
      },
      include: { targets: true },
    });

    expect(sr.id).toBeTruthy();
    expect(sr.targets).toHaveLength(1);
    expect(sr.targets[0].itemId).toBe(itemId);
    expect(sr.vendorId).toBe(vendorId);
    expect(sr.summary).toBe('Annual furnace tune-up');
    expect(sr.cost?.toNumber()).toBe(249.99);
  });

  it('creates a record with only item-target (no vendor)', async () => {
    const sr = await ctx.prisma.serviceRecord.create({
      data: {
        performedOn: new Date('2024-04-01'),
        summary: 'Self-performed filter replacement',
        targets: { create: [{ itemId }] },
      },
      include: { targets: true },
    });

    expect(sr.targets[0].itemId).toBe(itemId);
    expect(sr.vendorId).toBeNull();
  });

  it('creates a record with only vendorId (no targets)', async () => {
    const sr = await ctx.prisma.serviceRecord.create({
      data: {
        vendorId,
        performedOn: new Date('2024-04-10'),
        summary: 'General vendor visit',
      },
      include: { targets: true },
    });

    expect(sr.vendorId).toBe(vendorId);
    expect(sr.targets).toHaveLength(0);
  });

  it('creates a record with neither target nor vendor (both nullable)', async () => {
    const sr = await ctx.prisma.serviceRecord.create({
      data: {
        performedOn: new Date('2024-05-01'),
        summary: 'Unlinked general maintenance',
      },
      include: { targets: true },
    });

    expect(sr.id).toBeTruthy();
    expect(sr.targets).toHaveLength(0);
    expect(sr.vendorId).toBeNull();
    expect(sr.summary).toBe('Unlinked general maintenance');
  });

  it('updates summary and cost; re-reads and confirms', async () => {
    const sr = await ctx.prisma.serviceRecord.create({
      data: {
        performedOn: new Date('2024-06-01'),
        summary: 'Original summary',
        cost: 100,
        targets: { create: [{ itemId }] },
      },
    });

    await ctx.prisma.serviceRecord.update({
      where: { id: sr.id },
      data: { summary: 'Updated summary', cost: 199.5 },
    });

    const updated = await ctx.prisma.serviceRecord.findUnique({ where: { id: sr.id } });
    expect(updated?.summary).toBe('Updated summary');
    expect(updated?.cost?.toNumber()).toBe(199.5);
  });

  it('deletes a record; findUnique returns null', async () => {
    const sr = await ctx.prisma.serviceRecord.create({
      data: {
        performedOn: new Date('2024-07-01'),
        summary: 'To be deleted',
      },
    });

    await ctx.prisma.serviceRecord.delete({ where: { id: sr.id } });

    const deleted = await ctx.prisma.serviceRecord.findUnique({ where: { id: sr.id } });
    expect(deleted).toBeNull();
  });

  it('SetNulls ServiceRecord.vendorId when Vendor is hard-deleted', async () => {
    const tempVendor = await ctx.prisma.vendor.create({
      data: { name: 'Temp Vendor For Delete Test' },
    });
    const sr = await ctx.prisma.serviceRecord.create({
      data: {
        vendorId: tempVendor.id,
        performedOn: new Date('2024-08-01'),
        summary: 'Vendor delete test',
      },
    });

    await ctx.prisma.vendor.delete({ where: { id: tempVendor.id } });

    const read = await ctx.prisma.serviceRecord.findUnique({ where: { id: sr.id } });
    expect(read?.vendorId).toBeNull();
  });
});

describe('updateServiceRecord action', () => {
  it('clears vendorId when an edit flips a record to self-performed', async () => {
    const { updateServiceRecord } = await import('@/lib/service-records/actions');

    const sr = await ctx.prisma.serviceRecord.create({
      data: {
        vendorId,
        performedOn: new Date('2024-09-01'),
        summary: 'Vendor-performed visit',
        targets: { create: [{ itemId }] },
      },
    });
    expect(sr.vendorId).toBe(vendorId);

    const result = await updateServiceRecord({
      id: sr.id,
      selfPerformed: true,
      performedOn: new Date('2024-09-01'),
      summary: 'Now self-performed',
    });
    expect(result.ok).toBe(true);

    const updated = await ctx.prisma.serviceRecord.findUnique({ where: { id: sr.id } });
    expect(updated?.selfPerformed).toBe(true);
    expect(updated?.vendorId).toBeNull();
  });

  it('does not touch vendorId on a partial update that omits selfPerformed', async () => {
    const { updateServiceRecord } = await import('@/lib/service-records/actions');

    const sr = await ctx.prisma.serviceRecord.create({
      data: {
        vendorId,
        performedOn: new Date('2024-09-02'),
        summary: 'Vendor visit to be lightly edited',
      },
    });

    const result = await updateServiceRecord({
      id: sr.id,
      summary: 'Edited summary only',
    });
    expect(result.ok).toBe(true);

    const updated = await ctx.prisma.serviceRecord.findUnique({ where: { id: sr.id } });
    expect(updated?.vendorId).toBe(vendorId);
    expect(updated?.summary).toBe('Edited summary only');
  });
});

describe('ServiceRecord Prisma filters', () => {
  it('filters by item-target and returns only matching records', async () => {
    const otherItem = await ctx.prisma.item.create({
      data: { name: 'Water Heater', categoryId },
    });

    await ctx.prisma.serviceRecord.create({
      data: {
        performedOn: new Date('2024-01-01'),
        summary: 'Furnace service 1',
        targets: { create: [{ itemId }] },
      },
    });
    await ctx.prisma.serviceRecord.create({
      data: {
        performedOn: new Date('2024-02-01'),
        summary: 'Furnace service 2',
        targets: { create: [{ itemId }] },
      },
    });
    await ctx.prisma.serviceRecord.create({
      data: {
        performedOn: new Date('2024-03-01'),
        summary: 'Water heater service',
        targets: { create: [{ itemId: otherItem.id }] },
      },
    });

    const records = await ctx.prisma.serviceRecord.findMany({
      where: { targets: { some: { itemId } } },
      include: {
        targets: { include: { item: { select: { id: true, name: true } } } },
        vendor: { select: { id: true, name: true } },
      },
    });
    const total = await ctx.prisma.serviceRecord.count({
      where: { targets: { some: { itemId } } },
    });

    expect(total).toBe(2);
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.targets.some((t) => t.itemId === itemId)).toBe(true);
    }

    await ctx.prisma.item.delete({ where: { id: otherItem.id } });
  });

  it('filters by vendorId and returns only matching records', async () => {
    const otherVendor = await ctx.prisma.vendor.create({
      data: { name: 'Other Vendor' },
    });

    await ctx.prisma.serviceRecord.createMany({
      data: [
        { vendorId, performedOn: new Date('2024-01-01'), summary: 'HVAC Pro visit 1' },
        {
          vendorId: otherVendor.id,
          performedOn: new Date('2024-02-01'),
          summary: 'Other vendor visit',
        },
      ],
    });

    const records = await ctx.prisma.serviceRecord.findMany({
      where: { vendorId },
      include: {
        targets: { include: { item: { select: { id: true, name: true } } } },
        vendor: { select: { id: true, name: true } },
      },
    });
    const total = await ctx.prisma.serviceRecord.count({ where: { vendorId } });

    expect(total).toBe(1);
    expect(records[0].vendorId).toBe(vendorId);

    await ctx.prisma.vendor.delete({ where: { id: otherVendor.id } });
  });

  it('filters by date range (performedOn gte/lte)', async () => {
    await ctx.prisma.serviceRecord.createMany({
      data: [
        { performedOn: new Date('2024-01-15'), summary: 'January service' },
        { performedOn: new Date('2024-06-15'), summary: 'June service' },
        { performedOn: new Date('2024-12-15'), summary: 'December service' },
      ],
    });

    const records = await ctx.prisma.serviceRecord.findMany({
      where: {
        performedOn: { gte: new Date('2024-03-01'), lte: new Date('2024-09-30') },
      },
    });

    expect(records).toHaveLength(1);
    expect(records[0].summary).toBe('June service');
  });

  it('filters by summary text match (contains, insensitive)', async () => {
    await ctx.prisma.serviceRecord.createMany({
      data: [
        { performedOn: new Date('2024-01-01'), summary: 'Furnace filter replaced' },
        { performedOn: new Date('2024-02-01'), summary: 'AC coolant topped up' },
        { performedOn: new Date('2024-03-01'), summary: 'Furnace inspection' },
      ],
    });

    const records = await ctx.prisma.serviceRecord.findMany({
      where: { summary: { contains: 'furnace', mode: 'insensitive' } },
    });

    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.summary.toLowerCase()).toContain('furnace');
    }
  });

  it('returns records ordered by performedOn descending', async () => {
    await ctx.prisma.serviceRecord.createMany({
      data: [
        { performedOn: new Date('2024-01-01'), summary: 'Oldest' },
        { performedOn: new Date('2024-06-01'), summary: 'Middle' },
        { performedOn: new Date('2024-12-01'), summary: 'Newest' },
      ],
    });

    const records = await ctx.prisma.serviceRecord.findMany({
      orderBy: { performedOn: 'desc' },
    });

    expect(records[0].summary).toBe('Newest');
    expect(records[2].summary).toBe('Oldest');
  });

  it('includes target item and vendor relations on list results', async () => {
    await ctx.prisma.serviceRecord.create({
      data: {
        vendorId,
        performedOn: new Date('2024-05-01'),
        summary: 'Full service',
        targets: { create: [{ itemId }] },
      },
    });

    const records = await ctx.prisma.serviceRecord.findMany({
      include: {
        targets: { include: { item: { select: { id: true, name: true } } } },
        vendor: { select: { id: true, name: true } },
      },
    });

    expect(records[0].targets[0].item).toEqual({ id: itemId, name: 'Furnace' });
    expect(records[0].vendor).toEqual({ id: vendorId, name: 'HVAC Pro Services' });
  });
});
