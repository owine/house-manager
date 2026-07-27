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
    where: { slug: 'other' },
    create: { slug: 'other', name: 'Other', sortOrder: 998 },
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

describe('metadata validation errors key onto the registered field', () => {
  it('createItem keys a nested metadata failure as `metadata`, not `metadata.dims`', async () => {
    const result = await actions.createItem({
      name: 'Probe',
      categorySlug: 'other',
      metadata: { dims: { w: 3 } },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(Object.keys(result.fieldErrors ?? {})).toContain('metadata');
    expect(Object.keys(result.fieldErrors ?? {}).filter((k) => k.startsWith('metadata.'))).toEqual(
      [],
    );
    expect(result.fieldErrors?.metadata?.[0]).toMatch(/dims/);
  });

  it('updateItem keys a nested metadata failure as `metadata`, not `metadata.dims`', async () => {
    const item = await ctx.prisma.item.create({
      data: { name: 'Probe2', categoryId },
    });

    const result = await actions.updateItem({
      id: item.id,
      metadata: { dims: { w: 3 } },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(Object.keys(result.fieldErrors ?? {})).toContain('metadata');
    expect(Object.keys(result.fieldErrors ?? {}).filter((k) => k.startsWith('metadata.'))).toEqual(
      [],
    );
    expect(result.fieldErrors?.metadata?.[0]).toMatch(/dims/);
  });
});
