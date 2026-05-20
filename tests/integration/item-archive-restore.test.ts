import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'u1', name: 'Test' } })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/search/client', () => ({ enqueueSearchIndex: vi.fn(async () => {}) }));
vi.mock('@/lib/embedding/enqueue', () => ({ enqueueEmbed: vi.fn(async () => {}) }));

let ctx: IntegrationContext;
let categoryId: string;
let actions: typeof import('@/lib/items/actions');

beforeAll(async () => {
  ctx = await setupIntegration();
  actions = await import('@/lib/items/actions');
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'archive-restore-cat' },
    create: { slug: 'archive-restore-cat', name: 'ARCat', sortOrder: 999 },
    update: {},
  });
  categoryId = cat.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.item.deleteMany();
});

describe('archiveItem / restoreItem timestamp mutation', () => {
  it('archiveItem sets archivedAt and clears restoredAt', async () => {
    const item = await ctx.prisma.item.create({
      data: { name: 'X', categoryId, restoredAt: new Date() },
    });
    const r = await actions.archiveItem(item.id);
    expect(r.ok).toBe(true);
    const read = await ctx.prisma.item.findUnique({ where: { id: item.id } });
    expect(read?.archivedAt).toBeInstanceOf(Date);
    expect(read?.restoredAt).toBeNull();
  });

  it('restoreItem sets restoredAt and clears archivedAt', async () => {
    const item = await ctx.prisma.item.create({
      data: { name: 'Y', categoryId, archivedAt: new Date() },
    });
    const r = await actions.restoreItem(item.id);
    expect(r.ok).toBe(true);
    const read = await ctx.prisma.item.findUnique({ where: { id: item.id } });
    expect(read?.restoredAt).toBeInstanceOf(Date);
    expect(read?.archivedAt).toBeNull();
  });

  it('re-archiving after restore flips back (restoredAt cleared)', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'Z', categoryId } });
    await actions.restoreItem(item.id);
    await actions.archiveItem(item.id);
    const read = await ctx.prisma.item.findUnique({ where: { id: item.id } });
    expect(read?.archivedAt).toBeInstanceOf(Date);
    expect(read?.restoredAt).toBeNull();
  });
});
