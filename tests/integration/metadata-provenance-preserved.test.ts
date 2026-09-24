import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

// Q-H3's server half. Reserved metadata keys (`_provenance`, written only by
// chat apply) are server-owned: the edit forms never carry them, freeform
// validation rejects them, and every STRUCTURED schema is a plain z.object that
// silently strips them. So an update that wrote the validated blob verbatim
// dropped provenance on every edit. These pin that updateItem / updatePart
// re-attach the stored keys, and that a client can never overwrite them.
vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'u1', name: 'Test' } })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/search/client', () => ({ enqueueSearchIndex: vi.fn(async () => {}) }));
vi.mock('@/lib/embedding/enqueue', () => ({ enqueueEmbed: vi.fn(async () => {}) }));

const PROVENANCE = { name: 'user', model: 'inferred' };

let ctx: IntegrationContext;
let items: typeof import('@/lib/items/actions');
let parts: typeof import('@/lib/parts/actions');
let otherCategoryId: string;
let applianceCategoryId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  items = await import('@/lib/items/actions');
  parts = await import('@/lib/parts/actions');
  otherCategoryId = (
    await ctx.prisma.category.upsert({
      where: { slug: 'other' },
      create: { slug: 'other', name: 'Other', sortOrder: 999 },
      update: {},
    })
  ).id;
  applianceCategoryId = (
    await ctx.prisma.category.upsert({
      where: { slug: 'appliance' },
      create: { slug: 'appliance', name: 'Appliance', sortOrder: 10 },
      update: {},
    })
  ).id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.partLink.deleteMany();
  await ctx.prisma.part.deleteMany();
  await ctx.prisma.item.deleteMany();
});

describe('updateItem keeps server-owned metadata keys', () => {
  it('re-attaches _provenance on a freeform item', async () => {
    const item = await ctx.prisma.item.create({
      data: {
        name: 'String lights',
        categoryId: otherCategoryId,
        metadata: { _provenance: PROVENANCE, bulbBase: 'E26' },
      },
    });

    const r = await items.updateItem({
      id: item.id,
      name: 'String lights',
      categorySlug: 'other',
      metadata: { bulbBase: 'E27' },
    });

    expect(r).toEqual({ ok: true, data: { id: item.id } });
    const after = await ctx.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.metadata).toEqual({ bulbBase: 'E27', _provenance: PROVENANCE });
  });

  // The silent half: a structured z.object strips unknown keys, so this lost
  // provenance on every edit even before the form bug surfaced.
  it('re-attaches _provenance on a structured-category item', async () => {
    const item = await ctx.prisma.item.create({
      data: {
        name: 'Fridge',
        categoryId: applianceCategoryId,
        metadata: { _provenance: PROVENANCE, applianceType: 'refrigerator' },
      },
    });

    const r = await items.updateItem({
      id: item.id,
      categorySlug: 'appliance',
      metadata: { applianceType: 'freezer' },
    });

    expect(r.ok).toBe(true);
    const after = await ctx.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.metadata).toEqual({ applianceType: 'freezer', _provenance: PROVENANCE });
  });

  it('never lets a client overwrite the stored _provenance', async () => {
    const item = await ctx.prisma.item.create({
      data: {
        name: 'Fridge',
        categoryId: applianceCategoryId,
        metadata: { _provenance: PROVENANCE, applianceType: 'refrigerator' },
      },
    });

    const r = await items.updateItem({
      id: item.id,
      categorySlug: 'appliance',
      metadata: { applianceType: 'freezer', _provenance: { name: 'forged' } },
    });

    expect(r.ok).toBe(true);
    const after = await ctx.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.metadata).toEqual({ applianceType: 'freezer', _provenance: PROVENANCE });
  });
});

describe('updatePart keeps server-owned metadata keys', () => {
  it('re-attaches _provenance on a freeform (OTHER) part', async () => {
    const part = await ctx.prisma.part.create({
      data: {
        name: 'Mystery fuse',
        kind: 'OTHER',
        metadata: { _provenance: PROVENANCE, amps: 15 },
      },
    });

    const r = await parts.updatePart({
      id: part.id,
      name: 'Mystery fuse',
      kind: 'OTHER',
      metadata: { amps: 20 },
    });

    expect(r).toEqual({ ok: true, data: { id: part.id } });
    const after = await ctx.prisma.part.findUniqueOrThrow({ where: { id: part.id } });
    expect(after.metadata).toEqual({ amps: 20, _provenance: PROVENANCE });
  });

  it('re-attaches _provenance on a structured kind when kind is not resent', async () => {
    const part = await ctx.prisma.part.create({
      data: { name: 'Can light', kind: 'BULB', metadata: { _provenance: PROVENANCE, base: 'E26' } },
    });

    const r = await parts.updatePart({ id: part.id, metadata: { base: 'E12' } });

    expect(r.ok).toBe(true);
    const after = await ctx.prisma.part.findUniqueOrThrow({ where: { id: part.id } });
    expect(after.metadata).toEqual({ base: 'E12', _provenance: PROVENANCE });
  });
});
