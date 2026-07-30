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
  await ctx.prisma.category.upsert({
    where: { slug: 'appliance' },
    create: { slug: 'appliance', name: 'Appliance', sortOrder: 10 },
    update: {},
  });
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

// The mirror image of the cases above, and the half of #304 that stayed open.
//
// For a FREEFORM category the JSON textarea is registered as `metadata`, so a
// flat key renders inline — that is what the tests above pin.
//
// For a STRUCTURED category `ItemMetadataFields` registers `metadata.<key>`
// fields instead and nothing is registered as plain `metadata`. A flat key
// therefore has no field to render into, while `applyActionFieldErrors` still
// reports `applied: true` from its optimistic flat-key branch — which
// suppresses the caller's fallback toast. The rejection is silent.
//
// The helper already mirrors DOTTED keys to the root banner precisely so an
// unregistered one is never silent, so the fix is to emit dotted keys when the
// schema is structured. The user then sees the message inline on the offending
// field AND in the banner.
describe('structured categories key metadata errors onto the registered field', () => {
  it('createItem keys a structured failure as `metadata.<field>`, not `metadata`', async () => {
    const result = await actions.createItem({
      name: 'Fridge',
      categorySlug: 'appliance',
      metadata: { applianceType: 'refrigerator', capacityCuFt: -5 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const keys = Object.keys(result.fieldErrors ?? {});
    expect(keys).toContain('metadata.capacityCuFt');
    // A bare `metadata` key would render nowhere on a structured form.
    expect(keys).not.toContain('metadata');
  });

  it('updateItem does the same', async () => {
    const appliance = await ctx.prisma.category.findUniqueOrThrow({
      where: { slug: 'appliance' },
    });
    const item = await ctx.prisma.item.create({
      data: { name: 'Fridge2', categoryId: appliance.id },
    });

    const result = await actions.updateItem({
      id: item.id,
      categorySlug: 'appliance',
      metadata: { applianceType: 'refrigerator', capacityCuFt: -5 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const keys = Object.keys(result.fieldErrors ?? {});
    expect(keys).toContain('metadata.capacityCuFt');
    expect(keys).not.toContain('metadata');
  });
});
