import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

// Pins the regression this repo's three-commit reserved-metadata-key chain
// fixed: lib/categories.ts's freeformMetadataSchema must reject a reserved
// (`_`-prefixed) key with an issue that lands on the `metadata` field
// itself, not on `metadata.<key>`. The latter is invisible to the user —
// nothing is registered at that nested RHF path (see ItemForm.test.tsx for
// the form-level half of this). This test exercises the real createItem
// action end to end (real Zod schema, real fieldErrors-building loop in
// lib/items/actions.ts) so a future edit to either the schema's `path` or
// the `['metadata', ...issue.path].join('.')` line gets caught here.
vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'u1', name: 'Test' } })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/search/client', () => ({ enqueueSearchIndex: vi.fn(async () => {}) }));
vi.mock('@/lib/embedding/enqueue', () => ({ enqueueEmbed: vi.fn(async () => {}) }));

let ctx: IntegrationContext;
let actions: typeof import('@/lib/items/actions');

beforeAll(async () => {
  ctx = await setupIntegration();
  actions = await import('@/lib/items/actions');
  await ctx.prisma.category.upsert({
    where: { slug: 'other' },
    create: { slug: 'other', name: 'Other', sortOrder: 999 },
    update: {},
  });
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.item.deleteMany();
});

describe('createItem metadata reserved-key rejection', () => {
  it('reports the rejection on the "metadata" field, not a nested "metadata.<key>" path', async () => {
    const r = await actions.createItem({
      name: 'Kitchen Pendant',
      categorySlug: 'other',
      metadata: { _notes: 'inferred wattage' },
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;

    expect(r.fieldErrors).toBeDefined();
    expect(Object.keys(r.fieldErrors ?? {})).toContain('metadata');
    // The regression: a per-key `path: [key]` on the Zod issue produces
    // `metadata._notes`, which RHF nests under errors.metadata as an object
    // with no top-level .message — FormMessage on the single registered
    // `metadata` field then renders nothing.
    const nestedKeys = Object.keys(r.fieldErrors ?? {}).filter((k) => /^metadata\./.test(k));
    expect(nestedKeys).toEqual([]);
  });
});
