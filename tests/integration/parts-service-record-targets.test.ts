import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type IntegrationContext,
  setupIntegration,
  teardownIntegration,
  todayCal,
} from './helpers';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'u1', name: 'Test' } })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// Without this, every mutation logs a (swallowed) "enqueue failed" warning
// because getEnv() has no AUTH_*/API keys under test. Mirrors service-records.test.ts.
vi.mock('@/lib/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/queue')>();
  return {
    ...orig,
    getBoss: vi.fn(async () => ({ send: vi.fn(async () => 'fake-job-id') })),
  };
});

let ctx: IntegrationContext;
let actions: typeof import('@/lib/service-records/actions');
let categoryId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  // Dynamic import AFTER setupIntegration: lib/db builds its Prisma singleton at
  // import time from process.env.DATABASE_URL.
  actions = await import('@/lib/service-records/actions');

  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'parts-sr-hvac' },
    create: { slug: 'parts-sr-hvac', name: 'HVAC', sortOrder: 20 },
    update: {},
  });
  categoryId = cat.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.serviceRecordTarget.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.partLink.deleteMany();
  await ctx.prisma.part.deleteMany();
  await ctx.prisma.item.deleteMany();
});

function seedPart(name: string) {
  return ctx.prisma.part.create({ data: { name, kind: 'AIR_FILTER' } });
}

// performedOn is a @db.Date calendar-date column: UTC midnight only, or the
// calendar-date write guard rejects it.
const PERFORMED = todayCal();

describe('service record part targets', () => {
  it('creates a service record targeting only a part', async () => {
    const part = await seedPart('20x25x1 furnace filter');
    const r = await actions.createServiceRecord({
      targets: [{ partId: part.id }],
      selfPerformed: true,
      performedOn: PERFORMED,
      summary: 'Replaced the furnace filter',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const rows = await ctx.prisma.serviceRecordTarget.findMany({
      where: { serviceRecordId: r.data.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].partId).toBe(part.id);
    expect(rows[0].itemId).toBeNull();
    expect(rows[0].systemId).toBeNull();
  });

  it('keeps the SAME target row when re-saved unchanged', async () => {
    const part = await seedPart('Fridge water filter');
    const r = await actions.createServiceRecord({
      targets: [{ partId: part.id }],
      selfPerformed: true,
      performedOn: PERFORMED,
      summary: 'Swapped the water filter',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const before = await ctx.prisma.serviceRecordTarget.findMany({
      where: { serviceRecordId: r.data.id },
    });
    expect(before).toHaveLength(1);

    const u = await actions.updateServiceRecord({
      id: r.data.id,
      targets: [{ partId: part.id }],
      summary: 'Swapped the water filter (again)',
    });
    expect(u).toEqual({ ok: true, data: { id: r.data.id } });

    const after = await ctx.prisma.serviceRecordTarget.findMany({
      where: { serviceRecordId: r.data.id },
    });
    expect(after).toHaveLength(1);
    // Row identity, not just partId: a delete-and-recreate would still show
    // the right partId while destroying per-row history.
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].partId).toBe(part.id);
  });

  it('keeps BOTH part targets across an update', async () => {
    const p1 = await seedPart('Fridge water filter');
    const p2 = await seedPart('Fridge air filter');
    const r = await actions.createServiceRecord({
      targets: [{ partId: p1.id }, { partId: p2.id }],
      selfPerformed: true,
      performedOn: PERFORMED,
      summary: 'Replaced both fridge filters',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const before = await ctx.prisma.serviceRecordTarget.findMany({
      where: { serviceRecordId: r.data.id },
    });
    expect(before.map((t) => t.partId).sort()).toEqual([p1.id, p2.id].sort());

    const u = await actions.updateServiceRecord({
      id: r.data.id,
      targets: [{ partId: p1.id }, { partId: p2.id }],
      summary: 'Replaced both fridge filters (edited)',
    });
    expect(u).toEqual({ ok: true, data: { id: r.data.id } });

    const after = await ctx.prisma.serviceRecordTarget.findMany({
      where: { serviceRecordId: r.data.id },
    });
    expect(after).toHaveLength(2);
    expect(after.map((t) => t.partId).sort()).toEqual([p1.id, p2.id].sort());
    expect(after.map((t) => t.id).sort()).toEqual(before.map((t) => t.id).sort());
  });

  it('keeps a mixed item + part target set across an update', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId } });
    const part = await seedPart('Furnace filter');
    const r = await actions.createServiceRecord({
      targets: [{ itemId: item.id }, { partId: part.id }],
      selfPerformed: true,
      performedOn: PERFORMED,
      summary: 'Furnace service, filter swapped',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const before = await ctx.prisma.serviceRecordTarget.findMany({
      where: { serviceRecordId: r.data.id },
    });
    expect(before).toHaveLength(2);

    const u = await actions.updateServiceRecord({
      id: r.data.id,
      targets: [{ itemId: item.id }, { partId: part.id }],
      summary: 'Furnace service, filter swapped (edited)',
    });
    expect(u).toEqual({ ok: true, data: { id: r.data.id } });

    const after = await ctx.prisma.serviceRecordTarget.findMany({
      where: { serviceRecordId: r.data.id },
    });
    expect(after).toHaveLength(2);
    expect(after.map((t) => t.id).sort()).toEqual(before.map((t) => t.id).sort());
    expect(after.find((t) => t.itemId === item.id)).toBeTruthy();
    expect(after.find((t) => t.partId === part.id)).toBeTruthy();
  });

  it('returns a form error (not an FK exception) for a bogus partId', async () => {
    const r = await actions.createServiceRecord({
      targets: [{ partId: 'nope-not-a-real-part' }],
      selfPerformed: true,
      performedOn: PERFORMED,
      summary: 'Bogus part',
    });
    expect(r).toEqual({ ok: false, formError: 'Part not found' });
  });
});
