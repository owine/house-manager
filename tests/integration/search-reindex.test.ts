import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEARCH_INDEX_NAME } from '@/lib/search/client';
import {
  type IntegrationContext,
  setupIntegration,
  teardownIntegration,
  todayCal,
} from './helpers';

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
  await ctx.prisma.part.deleteMany();
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
        targets: { create: [{ itemId: items[0].id, nextDueOn: todayCal() }] },
      },
    });
    await ctx.prisma.reminder.create({
      data: {
        title: 'r2',
        recurrence: { kind: 'interval', days: 30 },
        notifyUserIds: [],
        targets: { create: [{ itemId: items[1].id, nextDueOn: todayCal() }] },
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

  it('indexes a part by its SPEC values, its parents and its re-buy identity', async () => {
    const item = await ctx.prisma.item.create({
      data: { name: 'Backyard string lights', categoryId },
    });
    const part = await ctx.prisma.part.create({
      data: {
        name: 'Backyard bulbs',
        kind: 'BULB',
        manufacturer: 'Feit',
        model: 'ST19-LED-DIM',
        sku: 'FEI-ST19-24',
        notes: 'buy the 24-pack',
        // `_provenance` is written by conversational capture and must never
        // reach the index.
        metadata: {
          base: 'E26',
          shape: 'S14',
          colorTempK: 2200,
          _provenance: { base: 'inferred' },
        },
        links: { create: [{ itemId: item.id }] },
      },
    });

    const result = await handleSearchReindex();
    if (result.lastTaskUid !== null) await ctx.meili.tasks.waitForTask(result.lastTaskUid);
    const idx = ctx.meili.index(SEARCH_INDEX_NAME);

    // THE assertion this PR exists for: a spec value, not a name.
    for (const q of ['E26', 'S14', '2200', 'FEI-ST19-24', 'Backyard string lights']) {
      const res = await idx.search(q);
      expect(res.hits.map((h) => h.id)).toContain(`part-${part.id}`);
    }

    const doc = await idx.getDocument(`part-${part.id}`);
    expect(doc.body).toContain('E26');
    expect(doc.body).toContain('Bulb');
    expect(doc.body).not.toContain('_provenance');
    expect(doc.body).not.toContain('inferred');
    expect(doc.href).toBe(`/parts/${part.id}`);
    expect(doc.itemName).toBe('Backyard string lights');
  });
});
