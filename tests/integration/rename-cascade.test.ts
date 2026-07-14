import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type IntegrationContext,
  setupIntegration,
  teardownIntegration,
  todayCal,
} from './helpers';

// Spy on enqueueEmbed before importing the cascade module — the helper imports
// it eagerly, so the spy has to be set up first.
const embedCalls: { type: string; id: string }[] = [];
vi.mock('@/lib/embedding/enqueue', () => ({
  enqueueEmbed: vi.fn(async (type: string, id: string) => {
    embedCalls.push({ type, id });
  }),
}));

let ctx: IntegrationContext;
let cascade: typeof import('@/lib/embedding/cascade');
let categoryId: string;
let userId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  cascade = await import('@/lib/embedding/cascade');
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'cascade-cat' },
    create: { slug: 'cascade-cat', name: 'Cascade', sortOrder: 999 },
    update: {},
  });
  categoryId = cat.id;
  const user = await ctx.prisma.user.upsert({
    where: { email: 'cascade-test@example.com' },
    create: { email: 'cascade-test@example.com', name: 'Cascade Test' },
    update: {},
  });
  userId = user.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  embedCalls.length = 0;
  // Order matters — child tables first to satisfy FK constraints.
  await ctx.prisma.attachment.deleteMany();
  await ctx.prisma.checklistItem.deleteMany();
  await ctx.prisma.checklist.deleteMany();
  await ctx.prisma.serviceRecordTarget.deleteMany();
  await ctx.prisma.warrantyTarget.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.warranty.deleteMany();
  await ctx.prisma.note.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.system.deleteMany();
  await ctx.prisma.vendor.deleteMany();
});

describe('enqueueItemRenameCascade', () => {
  it('enqueues re-embed for every child that denormalizes the Item name', async () => {
    const item = await ctx.prisma.item.create({
      data: { name: 'Furnace', categoryId },
    });
    const note = await ctx.prisma.note.create({
      data: { title: 'N', body: 'b', itemId: item.id },
    });
    const sr = await ctx.prisma.serviceRecord.create({
      data: {
        summary: 'S',
        performedOn: todayCal(),
        targets: { create: [{ itemId: item.id }] },
      },
    });
    const w = await ctx.prisma.warranty.create({
      data: {
        provider: 'P',
        startsOn: todayCal(),
        endsOn: todayCal(),
        targets: { create: [{ itemId: item.id }] },
      },
    });
    const checklist = await ctx.prisma.checklist.create({ data: { name: 'C' } });
    const ci = await ctx.prisma.checklistItem.create({
      data: { checklistId: checklist.id, position: 0, title: 'T', itemId: item.id },
    });
    const att = await ctx.prisma.attachment.create({
      data: {
        filename: 'f.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
        storagePath: 'test/f.pdf',
        itemId: item.id,
        uploadedById: userId,
      },
    });

    await cascade.enqueueItemRenameCascade(item.id);

    expect(embedCalls).toContainEqual({ type: 'NOTE', id: note.id });
    expect(embedCalls).toContainEqual({ type: 'SERVICE_RECORD', id: sr.id });
    expect(embedCalls).toContainEqual({ type: 'WARRANTY', id: w.id });
    expect(embedCalls).toContainEqual({ type: 'CHECKLIST_ITEM', id: ci.id });
    expect(embedCalls).toContainEqual({ type: 'ATTACHMENT', id: att.id });
    expect(embedCalls).toHaveLength(5);
  });

  it('no-op when the item has no children', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'Solo', categoryId } });
    await cascade.enqueueItemRenameCascade(item.id);
    expect(embedCalls).toEqual([]);
  });
});

describe('enqueueVendorRenameCascade', () => {
  it('enqueues re-embed for every SERVICE_RECORD linked to the vendor', async () => {
    const vendor = await ctx.prisma.vendor.create({ data: { name: 'Acme' } });
    const sr1 = await ctx.prisma.serviceRecord.create({
      data: { summary: 'A', performedOn: todayCal(), vendorId: vendor.id },
    });
    const sr2 = await ctx.prisma.serviceRecord.create({
      data: { summary: 'B', performedOn: todayCal(), vendorId: vendor.id },
    });
    // Unrelated SR — must NOT be enqueued.
    await ctx.prisma.serviceRecord.create({
      data: { summary: 'C', performedOn: todayCal() },
    });

    await cascade.enqueueVendorRenameCascade(vendor.id);

    expect(embedCalls).toContainEqual({ type: 'SERVICE_RECORD', id: sr1.id });
    expect(embedCalls).toContainEqual({ type: 'SERVICE_RECORD', id: sr2.id });
    expect(embedCalls).toHaveLength(2);
  });
});

describe('enqueueSystemRenameCascade', () => {
  it('enqueues re-embed for items, service records, and warranties under the system', async () => {
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const item = await ctx.prisma.item.create({
      data: { name: 'Filter', categoryId, systemId: sys.id },
    });
    const sr = await ctx.prisma.serviceRecord.create({
      data: {
        summary: 'Tune-up',
        performedOn: todayCal(),
        targets: { create: [{ systemId: sys.id }] },
      },
    });
    const w = await ctx.prisma.warranty.create({
      data: {
        provider: 'Manuf',
        startsOn: todayCal(),
        endsOn: todayCal(),
        targets: { create: [{ systemId: sys.id }] },
      },
    });
    // Unrelated item — must NOT be enqueued.
    await ctx.prisma.item.create({ data: { name: 'Unrelated', categoryId } });

    await cascade.enqueueSystemRenameCascade(sys.id);

    expect(embedCalls).toContainEqual({ type: 'ITEM', id: item.id });
    expect(embedCalls).toContainEqual({ type: 'SERVICE_RECORD', id: sr.id });
    expect(embedCalls).toContainEqual({ type: 'WARRANTY', id: w.id });
    expect(embedCalls).toHaveLength(3);
  });
});
