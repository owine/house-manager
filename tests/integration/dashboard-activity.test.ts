import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;
let categoryId: string;
let recentActivity: (
  limit?: number,
) => Promise<Array<{ kind: string; label: string; href: string; occurredAt: Date }>>;

beforeAll(async () => {
  ctx = await setupIntegration();
  recentActivity = (await import('@/lib/dashboard/queries')).recentActivity;
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'dash-activity-cat' },
    create: { slug: 'dash-activity-cat', name: 'DACat', sortOrder: 999 },
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

describe('recentActivity — item-restored', () => {
  it('emits an item-restored event for an item with restoredAt set', async () => {
    const item = await ctx.prisma.item.create({
      data: { name: 'Furnace', categoryId, restoredAt: new Date('2026-05-20T10:00:00Z') },
    });
    const events = await recentActivity(20);
    const restored = events.find((e) => e.kind === 'item-restored');
    expect(restored).toBeDefined();
    expect(restored?.label).toBe('Restored Furnace');
    expect(restored?.href).toBe(`/items/${item.id}`);
    expect(restored?.occurredAt.toISOString()).toBe('2026-05-20T10:00:00.000Z');
  });

  it('does not emit item-restored for a never-archived item', async () => {
    await ctx.prisma.item.create({ data: { name: 'Fresh', categoryId } });
    const events = await recentActivity(20);
    expect(events.some((e) => e.kind === 'item-restored')).toBe(false);
  });

  it('an archived item shows item-archived, not item-restored', async () => {
    await ctx.prisma.item.create({
      data: {
        name: 'Old',
        categoryId,
        archivedAt: new Date('2026-05-20T09:00:00Z'),
        restoredAt: null,
      },
    });
    const events = await recentActivity(20);
    expect(events.some((e) => e.kind === 'item-archived')).toBe(true);
    expect(events.some((e) => e.kind === 'item-restored')).toBe(false);
  });
});
