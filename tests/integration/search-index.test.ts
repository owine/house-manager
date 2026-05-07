import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEARCH_INDEX_NAME } from '@/lib/search/client';
import { INDEX_SETTINGS } from '@/lib/search/schema';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

vi.mock('@/lib/env', () => ({
  getEnv: vi.fn(() => ({
    MEILI_HOST: process.env.MEILI_HOST,
    MEILI_KEY: process.env.MEILI_KEY,
  })),
}));

let ctx: IntegrationContext;
let categoryId: string;
let handleSearchIndex: typeof import('@/worker/jobs/search-index').handleSearchIndex;

beforeAll(async () => {
  ctx = await setupIntegration();
  await ctx.meili.createIndex(SEARCH_INDEX_NAME, { primaryKey: 'id' }).catch(() => {});
  const idx = ctx.meili.index(SEARCH_INDEX_NAME);
  await idx.updateSettings(INDEX_SETTINGS as unknown as Parameters<typeof idx.updateSettings>[0]);
  // Dynamic import AFTER setupIntegration sets DATABASE_URL — the search-index
  // module transitively imports lib/db.ts.
  handleSearchIndex = (await import('@/worker/jobs/search-index')).handleSearchIndex;

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
  await ctx.prisma.attachment.deleteMany();
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.note.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.vendor.deleteMany();
  const idx = ctx.meili.index(SEARCH_INDEX_NAME);
  await ctx.meili.tasks.waitForTask((await idx.deleteAllDocuments()).taskUid);
});

describe('handleSearchIndex', () => {
  it('upsert: indexes an item, searchable by name', async () => {
    const item = await ctx.prisma.item.create({
      data: { name: 'Furnace', categoryId },
    });
    const taskUid = await handleSearchIndex({ kind: 'item', id: item.id, op: 'upsert' });
    await ctx.meili.tasks.waitForTask(taskUid);
    const res = await ctx.meili.index(SEARCH_INDEX_NAME).search('furnace');
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0].id).toBe(`item-${item.id}`);
  });

  it('delete: removes the document', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'Boiler', categoryId } });
    await ctx.meili.tasks.waitForTask(
      await handleSearchIndex({ kind: 'item', id: item.id, op: 'upsert' }),
    );
    await ctx.meili.tasks.waitForTask(
      await handleSearchIndex({ kind: 'item', id: item.id, op: 'delete' }),
    );
    const res = await ctx.meili.index(SEARCH_INDEX_NAME).search('boiler');
    expect(res.hits).toHaveLength(0);
  });

  it('upsert: returns null transform when row was deleted between enqueue and pickup', async () => {
    const taskUid = await handleSearchIndex({ kind: 'item', id: 'nonexistent', op: 'upsert' });
    await ctx.meili.tasks.waitForTask(taskUid);
    const res = await ctx.meili.index(SEARCH_INDEX_NAME).search('anything');
    expect(res.hits).toHaveLength(0);
  });

  it('upsert item: re-upserts denormalized children with new itemName', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'OldName', categoryId } });
    const reminder = await ctx.prisma.reminder.create({
      data: {
        title: 'Filter',
        recurrence: { kind: 'interval', days: 30 },
        notifyUserIds: [],
        targets: { create: [{ itemId: item.id, nextDueOn: new Date() }] },
      },
    });
    await ctx.meili.tasks.waitForTask(
      await handleSearchIndex({ kind: 'item', id: item.id, op: 'upsert' }),
    );
    await ctx.meili.tasks.waitForTask(
      await handleSearchIndex({ kind: 'reminder', id: reminder.id, op: 'upsert' }),
    );
    await ctx.prisma.item.update({ where: { id: item.id }, data: { name: 'NewName' } });
    await ctx.meili.tasks.waitForTask(
      await handleSearchIndex({ kind: 'item', id: item.id, op: 'upsert' }),
    );
    const reminderDoc = await ctx.meili
      .index(SEARCH_INDEX_NAME)
      .getDocument(`reminder-${reminder.id}`);
    expect((reminderDoc as { itemName: string }).itemName).toBe('NewName');
  });

  it('delete item: cascades to child docs', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'X', categoryId } });
    const reminder = await ctx.prisma.reminder.create({
      data: {
        title: 'r1',
        recurrence: { kind: 'interval', days: 30 },
        notifyUserIds: [],
        targets: { create: [{ itemId: item.id, nextDueOn: new Date() }] },
      },
    });
    await ctx.meili.tasks.waitForTask(
      await handleSearchIndex({ kind: 'item', id: item.id, op: 'upsert' }),
    );
    await ctx.meili.tasks.waitForTask(
      await handleSearchIndex({ kind: 'reminder', id: reminder.id, op: 'upsert' }),
    );
    await ctx.meili.tasks.waitForTask(
      await handleSearchIndex({ kind: 'item', id: item.id, op: 'delete' }),
    );
    const res = await ctx.meili.index(SEARCH_INDEX_NAME).search('r1');
    expect(res.hits).toHaveLength(0);
  });
});
