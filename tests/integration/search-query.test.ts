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
let searchAll: typeof import('@/lib/search/queries').searchAll;

beforeAll(async () => {
  ctx = await setupIntegration();
  await ctx.meili.createIndex(SEARCH_INDEX_NAME, { primaryKey: 'id' }).catch(() => {});
  const idx = ctx.meili.index(SEARCH_INDEX_NAME);
  await idx.updateSettings(INDEX_SETTINGS as unknown as Parameters<typeof idx.updateSettings>[0]);
  // Dynamic import AFTER setupIntegration sets env vars
  searchAll = (await import('@/lib/search/queries')).searchAll;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  const idx = ctx.meili.index(SEARCH_INDEX_NAME);
  await ctx.meili.tasks.waitForTask((await idx.deleteAllDocuments()).taskUid);
  await ctx.meili.tasks.waitForTask(
    (
      await idx.addDocuments([
        {
          id: 'item-i1',
          kind: 'item',
          recordId: 'i1',
          title: 'Furnace',
          body: 'Lennox XC25',
          tags: [],
          itemName: 'Furnace',
          itemId: 'i1',
          categorySlug: 'hvac',
          href: '/items/i1',
          iconHint: '📦',
          updatedAt: 1700000000,
        },
        {
          id: 'service-s1',
          kind: 'service',
          recordId: 's1',
          title: 'Annual tune-up',
          body: 'replaced filter',
          tags: [],
          itemName: 'Furnace',
          itemId: 'i1',
          categorySlug: null,
          href: '/service/s1',
          iconHint: '🔧',
          updatedAt: 1700001000,
        },
        {
          id: 'reminder-r1',
          kind: 'reminder',
          recordId: 'r1',
          title: 'Replace HVAC filter',
          body: 'use MERV 13',
          tags: [],
          itemName: 'Furnace',
          itemId: 'i1',
          categorySlug: null,
          href: '/reminders/r1',
          iconHint: '⏰',
          updatedAt: 1700002000,
        },
      ])
    ).taskUid,
  );
});

describe('searchAll', () => {
  it('returns hits matching the query', async () => {
    const r = await searchAll({ q: 'furnace', limit: 20, offset: 0 });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.some((h) => h.id === 'item-i1')).toBe(true);
  });

  it('matches via denormalized itemName', async () => {
    const r = await searchAll({ q: 'furnace', limit: 20, offset: 0 });
    expect(r.hits.some((h) => h.id === 'reminder-r1')).toBe(true);
    expect(r.hits.some((h) => h.id === 'service-s1')).toBe(true);
  });

  it('filters by kind', async () => {
    const r = await searchAll({ q: 'furnace', kind: 'reminder', limit: 20, offset: 0 });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].kind).toBe('reminder');
  });

  it('returns facet counts even when filtered', async () => {
    const r = await searchAll({ q: 'furnace', kind: 'reminder', limit: 20, offset: 0 });
    expect(r.facets.kind?.item).toBe(1);
    expect(r.facets.kind?.reminder).toBe(1);
    expect(r.facets.kind?.service).toBe(1);
  });

  it('empty q returns empty without calling Meilisearch', async () => {
    const r = await searchAll({ q: '', limit: 20, offset: 0 });
    expect(r.hits).toHaveLength(0);
    expect(r.total).toBe(0);
  });
});
