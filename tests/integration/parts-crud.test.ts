import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

// Per-test session via a mutable currentUserId (mirrors reminders-auth.test.ts).
let currentUserId: string | null = null;

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => (currentUserId ? { user: { id: currentUserId } } : null)),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

let ctx: IntegrationContext;
let actions: typeof import('@/lib/parts/actions');
let queries: typeof import('@/lib/parts/queries');
let categoryId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  // Dynamic import AFTER setupIntegration: lib/db builds its Prisma singleton at
  // import time from process.env.DATABASE_URL.
  actions = await import('@/lib/parts/actions');
  queries = await import('@/lib/parts/queries');

  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'parts-crud' },
    create: { slug: 'parts-crud', name: 'Fixtures', sortOrder: 30 },
    update: {},
  });
  categoryId = cat.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.partLink.deleteMany();
  await ctx.prisma.part.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.system.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@example.com', name: 'U1' } });
  currentUserId = 'u1';
});

describe('part CRUD round-trip', () => {
  it('creates, updates, archives and restores', async () => {
    const created = await actions.createPart({
      name: 'BR30 dimmable',
      kind: 'BULB',
      manufacturer: 'Philips',
      model: 'BR30-927-DIM',
      typicalCost: '4.50',
      packQuantity: '6',
      purchaseLinks: [{ label: 'Amazon', url: 'https://example.com/dp/B0' }],
      metadata: { base: 'E26', shape: 'BR30', watts: 9 },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const row = await ctx.prisma.part.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(row.kind).toBe('BULB');
    expect(Number(row.typicalCost)).toBe(4.5);
    expect(row.packQuantity).toBe(6);
    expect(row.metadata).toEqual({ base: 'E26', shape: 'BR30', watts: 9 });
    expect(row.purchaseLinks).toEqual([{ label: 'Amazon', url: 'https://example.com/dp/B0' }]);

    const updated = await actions.updatePart({ id: created.data.id, name: 'BR30 soft white' });
    expect(updated).toEqual({ ok: true, data: { id: created.data.id } });
    expect((await ctx.prisma.part.findUniqueOrThrow({ where: { id: created.data.id } })).name).toBe(
      'BR30 soft white',
    );

    const archived = await actions.archivePart(created.data.id);
    expect(archived.ok).toBe(true);
    expect(
      (await ctx.prisma.part.findUniqueOrThrow({ where: { id: created.data.id } })).archivedAt,
    ).not.toBeNull();

    const restored = await actions.restorePart(created.data.id);
    expect(restored.ok).toBe(true);
    expect(
      (await ctx.prisma.part.findUniqueOrThrow({ where: { id: created.data.id } })).archivedAt,
    ).toBeNull();
  });

  it('rejects an unauthenticated create without throwing', async () => {
    currentUserId = null;
    expect(await actions.createPart({ name: 'x' })).toEqual({
      ok: false,
      formError: 'Unauthorized',
    });
  });

  it('validates metadata against the stored kind when the update omits kind', async () => {
    const created = await actions.createPart({ name: 'Bulb', kind: 'BULB' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const bad = await actions.updatePart({ id: created.data.id, metadata: { base: 'E27' } });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.fieldErrors?.metadata?.join(' ')).toContain('base');
  });
});

describe('linkPartToParent / unlinkPart', () => {
  async function seed() {
    const part = await ctx.prisma.part.create({ data: { name: 'Filter', kind: 'AIR_FILTER' } });
    const item = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId } });
    const system = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    return { part, item, system };
  }

  it('is idempotent — a repeat link is one row and ok:true both times', async () => {
    const { part, item } = await seed();

    const first = await actions.linkPartToParent({ partId: part.id, itemId: item.id });
    const second = await actions.linkPartToParent({ partId: part.id, itemId: item.id });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.data.id).toBe(first.data.id);

    const links = await ctx.prisma.partLink.findMany({ where: { partId: part.id } });
    expect(links).toHaveLength(1);
  });

  it('is idempotent for a system link too (the NULLS NOT DISTINCT itemId)', async () => {
    const { part, system } = await seed();
    expect((await actions.linkPartToParent({ partId: part.id, systemId: system.id })).ok).toBe(
      true,
    );
    expect((await actions.linkPartToParent({ partId: part.id, systemId: system.id })).ok).toBe(
      true,
    );
    expect(await ctx.prisma.partLink.count({ where: { partId: part.id } })).toBe(1);
  });

  it('rejects two parents in one call', async () => {
    const { part, item, system } = await seed();
    const result = await actions.linkPartToParent({
      partId: part.id,
      itemId: item.id,
      systemId: system.id,
    });
    expect(result.ok).toBe(false);
    expect(await ctx.prisma.partLink.count()).toBe(0);
  });

  it('rejects zero parents', async () => {
    const { part } = await seed();
    expect((await actions.linkPartToParent({ partId: part.id })).ok).toBe(false);
    expect(await ctx.prisma.partLink.count()).toBe(0);
  });

  it('unlinks by link id, leaving the part behind', async () => {
    const { part, item } = await seed();
    const linked = await actions.linkPartToParent({
      partId: part.id,
      itemId: item.id,
      location: 'Basement',
      quantityInstalled: 2,
    });
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;

    const stored = await ctx.prisma.partLink.findUniqueOrThrow({ where: { id: linked.data.id } });
    expect(stored.location).toBe('Basement');
    expect(stored.quantityInstalled).toBe(2);

    expect(await actions.unlinkPart({ linkId: linked.data.id })).toEqual({
      ok: true,
      data: undefined,
    });
    expect(await ctx.prisma.partLink.count()).toBe(0);
    expect(await ctx.prisma.part.count({ where: { id: part.id } })).toBe(1);
  });
});

/**
 * The derived-archive rule is the whole point of LIVE_PART / ARCHIVED_PART: a
 * part is archived wherever ALL of its parents are archived, and that is never
 * stored. The two predicates must form a genuine partition — every part matches
 * exactly one — or the /parts archived filter drops or duplicates rows.
 */
describe('LIVE_PART / ARCHIVED_PART partition', () => {
  const ARCHIVED_AT = new Date('2026-01-01T00:00:00.000Z');

  async function seedFixtures() {
    const liveItem = await ctx.prisma.item.create({ data: { name: 'Live fixture', categoryId } });
    const deadItem = await ctx.prisma.item.create({
      data: { name: 'Dead fixture', categoryId, archivedAt: ARCHIVED_AT },
    });
    const liveSystem = await ctx.prisma.system.create({ data: { name: 'Live system' } });
    const deadSystem = await ctx.prisma.system.create({
      data: { name: 'Dead system', archivedAt: ARCHIVED_AT },
    });

    // 1. no links, not archived -> live ("generic bulbs")
    const unlinked = await ctx.prisma.part.create({ data: { name: 'Generic bulbs' } });

    // 2. Part.archivedAt set -> archived (stopped buying it, fixture still live)
    const selfArchived = await ctx.prisma.part.create({
      data: {
        name: 'Discontinued bulb',
        archivedAt: ARCHIVED_AT,
        links: {
          create: [{ itemId: liveItem.id }],
        },
      },
    });

    // 3. only parent is an archived item -> archived
    const deadParent = await ctx.prisma.part.create({
      data: { name: 'Bulb for dead fixture', links: { create: [{ itemId: deadItem.id }] } },
    });

    // 4. one archived + one live parent -> live
    const mixedParents = await ctx.prisma.part.create({
      data: {
        name: 'Bulb in two fixtures',
        links: { create: [{ itemId: deadItem.id }, { itemId: liveItem.id }] },
      },
    });

    // 5. only parent is a live SYSTEM (itemId NULL on that row) -> live
    const systemOnly = await ctx.prisma.part.create({
      data: { name: 'Softener salt', links: { create: [{ systemId: liveSystem.id }] } },
    });

    // 6. only parent is an archived SYSTEM -> archived
    const deadSystemOnly = await ctx.prisma.part.create({
      data: { name: 'Salt for dead softener', links: { create: [{ systemId: deadSystem.id }] } },
    });

    return { unlinked, selfArchived, deadParent, mixedParents, systemOnly, deadSystemOnly };
  }

  it('sorts every fixture into exactly one bucket', async () => {
    const f = await seedFixtures();

    const live = (await ctx.prisma.part.findMany({ where: queries.LIVE_PART })).map((p) => p.id);
    const archived = (await ctx.prisma.part.findMany({ where: queries.ARCHIVED_PART })).map(
      (p) => p.id,
    );

    expect(live.sort()).toEqual([f.unlinked.id, f.mixedParents.id, f.systemOnly.id].sort());
    expect(archived.sort()).toEqual(
      [f.selfArchived.id, f.deadParent.id, f.deadSystemOnly.id].sort(),
    );
  });

  it('is a genuine partition — nothing matches both or neither', async () => {
    await seedFixtures();

    const all = await ctx.prisma.part.count();
    const live = await ctx.prisma.part.count({ where: queries.LIVE_PART });
    const archived = await ctx.prisma.part.count({ where: queries.ARCHIVED_PART });
    const both = await ctx.prisma.part.count({
      where: { AND: [queries.LIVE_PART, queries.ARCHIVED_PART] },
    });
    const neither = await ctx.prisma.part.count({
      where: { NOT: { OR: [queries.LIVE_PART, queries.ARCHIVED_PART] } },
    });

    expect(both).toBe(0);
    expect(neither).toBe(0);
    expect(live + archived).toBe(all);
  });

  it('restoring the parent brings the part back with no write to the part', async () => {
    const f = await seedFixtures();
    const before = await ctx.prisma.part.findUniqueOrThrow({ where: { id: f.deadParent.id } });

    const deadItemId = (
      await ctx.prisma.partLink.findFirstOrThrow({ where: { partId: f.deadParent.id } })
    ).itemId as string;
    await ctx.prisma.item.update({ where: { id: deadItemId }, data: { archivedAt: null } });

    const live = await ctx.prisma.part.findMany({ where: queries.LIVE_PART });
    expect(live.map((p) => p.id)).toContain(f.deadParent.id);

    const after = await ctx.prisma.part.findUniqueOrThrow({ where: { id: f.deadParent.id } });
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.archivedAt).toBeNull();
  });

  it('listPartsForPicker returns only live parts', async () => {
    const f = await seedFixtures();
    const picker = await queries.listPartsForPicker();
    expect(picker.map((p) => p.id).sort()).toEqual(
      [f.unlinked.id, f.mixedParents.id, f.systemOnly.id].sort(),
    );
  });
});
