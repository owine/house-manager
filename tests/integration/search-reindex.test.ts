import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEARCH_INDEX_NAME } from '@/lib/search/client';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

vi.mock('@/lib/env', () => ({
  getEnv: vi.fn(() => ({
    MEILI_HOST: process.env.MEILI_HOST,
    MEILI_KEY: process.env.MEILI_KEY,
  })),
}));

let ctx: IntegrationContext;
let categoryId: string;
let handleSearchReindex: typeof import('@/worker/jobs/search-reindex').handleSearchReindex;

beforeAll(async () => {
  ctx = await setupIntegration();
  // Dynamic import AFTER setupIntegration sets DATABASE_URL.
  handleSearchReindex = (await import('@/worker/jobs/search-reindex')).handleSearchReindex;

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
  await ctx.meili.deleteIndex(SEARCH_INDEX_NAME).catch(() => {});
});

describe('handleSearchReindex', () => {
  it('drops and recreates an empty index when no rows exist', async () => {
    const result = await handleSearchReindex();
    expect(result.processed).toBe(0);
    if (result.lastTaskUid !== null) {
      await ctx.meili.tasks.waitForTask(result.lastTaskUid);
    }
    const stats = await ctx.meili.index(SEARCH_INDEX_NAME).getStats();
    expect(stats.numberOfDocuments).toBe(0);
  });

  it('rebuilds the full index from Postgres', async () => {
    const items = await Promise.all([
      ctx.prisma.item.create({ data: { name: 'A', categoryId } }),
      ctx.prisma.item.create({ data: { name: 'B', categoryId } }),
      ctx.prisma.item.create({ data: { name: 'C', categoryId } }),
    ]);
    await ctx.prisma.reminder.create({
      data: {
        title: 'r1',
        recurrence: { kind: 'interval', days: 30 },
        notifyUserIds: [],
        targets: { create: [{ itemId: items[0].id, nextDueOn: new Date() }] },
      },
    });
    await ctx.prisma.reminder.create({
      data: {
        title: 'r2',
        recurrence: { kind: 'interval', days: 30 },
        notifyUserIds: [],
        targets: { create: [{ itemId: items[1].id, nextDueOn: new Date() }] },
      },
    });
    await ctx.prisma.vendor.create({ data: { name: 'ACME' } });

    const result = await handleSearchReindex();
    expect(result.processed).toBe(6);
    if (result.lastTaskUid !== null) {
      await ctx.meili.tasks.waitForTask(result.lastTaskUid);
    }

    const stats = await ctx.meili.index(SEARCH_INDEX_NAME).getStats();
    expect(stats.numberOfDocuments).toBe(6);

    const res = await ctx.meili.index(SEARCH_INDEX_NAME).search('ACME');
    expect(res.hits[0]?.title).toBe('ACME');
  });
});
