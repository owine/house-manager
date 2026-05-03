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
let handleSearchIndex: typeof import('@/worker/jobs/search-index').handleSearchIndex;

beforeAll(async () => {
  ctx = await setupIntegration();
  await ctx.meili.createIndex(SEARCH_INDEX_NAME, { primaryKey: 'id' }).catch(() => {});
  const idx = ctx.meili.index(SEARCH_INDEX_NAME);
  await idx.updateSettings(INDEX_SETTINGS as unknown as Parameters<typeof idx.updateSettings>[0]);
  handleSearchIndex = (await import('@/worker/jobs/search-index')).handleSearchIndex;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.checklistItem.deleteMany();
  await ctx.prisma.checklist.deleteMany();
  const idx = ctx.meili.index(SEARCH_INDEX_NAME);
  await ctx.meili.tasks.waitForTask((await idx.deleteAllDocuments()).taskUid);
});

describe('checklist search indexing', () => {
  it('upserts a checklist (with item titles in the body) into the unified index', async () => {
    const cl = await ctx.prisma.checklist.create({
      data: {
        name: 'Indexable Spring',
        description: 'Pre-warm-season tasks',
        items: {
          create: [
            { position: 0, title: 'Test sump pump' },
            { position: 1, title: 'Clean gutters' },
          ],
        },
      },
    });
    const taskUid = await handleSearchIndex({ kind: 'checklist', id: cl.id, op: 'upsert' });
    await ctx.meili.tasks.waitForTask(taskUid);

    const res = await ctx.meili.index(SEARCH_INDEX_NAME).search('sump pump');
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0].id).toBe(`checklist-${cl.id}`);
    expect(res.hits[0].title).toBe('Indexable Spring');
    expect(res.hits[0].body).toContain('Test sump pump');
    expect(res.hits[0].body).toContain('Clean gutters');
    expect(res.hits[0].href).toBe(`/checklists/${cl.id}`);
  });

  it('delete: removes the doc from the index', async () => {
    const cl = await ctx.prisma.checklist.create({ data: { name: 'Deletable' } });
    let taskUid = await handleSearchIndex({ kind: 'checklist', id: cl.id, op: 'upsert' });
    await ctx.meili.tasks.waitForTask(taskUid);
    expect((await ctx.meili.index(SEARCH_INDEX_NAME).search('Deletable')).hits).toHaveLength(1);

    taskUid = await handleSearchIndex({ kind: 'checklist', id: cl.id, op: 'delete' });
    await ctx.meili.tasks.waitForTask(taskUid);
    expect((await ctx.meili.index(SEARCH_INDEX_NAME).search('Deletable')).hits).toHaveLength(0);
  });

  it('upsert of a stale id (deleted Checklist) deletes the doc instead', async () => {
    // Index a checklist, delete the row, then re-upsert — buildDocument returns null
    // and the worker falls back to deleting the doc.
    const cl = await ctx.prisma.checklist.create({ data: { name: 'Soon gone' } });
    let taskUid = await handleSearchIndex({ kind: 'checklist', id: cl.id, op: 'upsert' });
    await ctx.meili.tasks.waitForTask(taskUid);

    await ctx.prisma.checklistItem.deleteMany({ where: { checklistId: cl.id } });
    await ctx.prisma.checklist.delete({ where: { id: cl.id } });
    taskUid = await handleSearchIndex({ kind: 'checklist', id: cl.id, op: 'upsert' });
    await ctx.meili.tasks.waitForTask(taskUid);

    expect((await ctx.meili.index(SEARCH_INDEX_NAME).search('Soon gone')).hits).toHaveLength(0);
  });
});
