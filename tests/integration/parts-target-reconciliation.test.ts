import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

// Per-test session via a mutable currentUserId (mirrors reminders-auth.test.ts).
let currentUserId: string | null = null;

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => (currentUserId ? { user: { id: currentUserId } } : null)),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

let ctx: IntegrationContext;
let actions: typeof import('@/lib/reminders/actions');

beforeAll(async () => {
  ctx = await setupIntegration();
  // Dynamic import AFTER setupIntegration: lib/db builds its Prisma singleton at
  // import time from process.env.DATABASE_URL.
  actions = await import('@/lib/reminders/actions');
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.reminderCompletion.deleteMany();
  await ctx.prisma.notificationLog.deleteMany();
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.serviceRecordTarget.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.partLink.deleteMany();
  await ctx.prisma.part.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@example.com', name: 'U1' } });
  currentUserId = 'u1';
});

function seedPart(name: string) {
  return ctx.prisma.part.create({ data: { name, kind: 'AIR_FILTER' } });
}

// A fixed calendar date (UTC midnight) — the shape @db.Date columns store.
const DUE = new Date('2026-06-01T00:00:00.000Z');

describe('part targets survive reminder reconciliation', () => {
  it('keeps a single part target (same row id) when re-saved unchanged', async () => {
    const part = await seedPart('20x25x1 furnace filter');
    const r = await actions.createReminder({
      title: 'Swap furnace filter',
      kind: 'REMINDER',
      targets: [{ partId: part.id }],
      recurrence: { kind: 'interval', every: 3, unit: 'month' },
      nextDueOn: DUE,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const before = await ctx.prisma.reminderTarget.findMany({ where: { reminderId: r.data.id } });
    expect(before).toHaveLength(1);
    expect(before[0].partId).toBe(part.id);

    const u = await actions.updateReminder({
      id: r.data.id,
      kind: 'REMINDER',
      targets: [{ partId: part.id }],
    });
    expect(u).toEqual({ ok: true, data: { id: r.data.id } });

    const after = await ctx.prisma.reminderTarget.findMany({ where: { reminderId: r.data.id } });
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].partId).toBe(part.id);
  });

  it('keeps BOTH part targets when a reminder has two', async () => {
    const p1 = await seedPart('Fridge water filter');
    const p2 = await seedPart('Fridge air filter');
    const r = await actions.createReminder({
      title: 'Fridge filters',
      kind: 'REMINDER',
      targets: [{ partId: p1.id }, { partId: p2.id }],
      recurrence: { kind: 'interval', every: 6, unit: 'month' },
      nextDueOn: DUE,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const before = await ctx.prisma.reminderTarget.findMany({ where: { reminderId: r.data.id } });
    expect(before.map((t) => t.partId).sort()).toEqual([p1.id, p2.id].sort());

    const u = await actions.updateReminder({
      id: r.data.id,
      kind: 'REMINDER',
      targets: [{ partId: p1.id }, { partId: p2.id }],
    });
    expect(u).toEqual({ ok: true, data: { id: r.data.id } });

    const after = await ctx.prisma.reminderTarget.findMany({ where: { reminderId: r.data.id } });
    expect(after).toHaveLength(2);
    expect(after.map((t) => t.partId).sort()).toEqual([p1.id, p2.id].sort());
    expect(after.map((t) => t.id).sort()).toEqual(before.map((t) => t.id).sort());
  });

  it('replaces a standalone chore sentinel with a part link, carrying cadence forward', async () => {
    const r = await actions.createReminder({
      title: 'Restock salt',
      kind: 'CHORE',
      targets: [],
      recurrence: { kind: 'interval', every: 1, unit: 'month' },
      nextDueOn: DUE,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const sentinel = await ctx.prisma.reminderTarget.findMany({ where: { reminderId: r.data.id } });
    expect(sentinel).toHaveLength(1);
    expect(sentinel[0].partId).toBeNull();

    const part = await seedPart('Water softener salt');
    const u = await actions.updateReminder({
      id: r.data.id,
      kind: 'CHORE',
      targets: [{ partId: part.id }],
    });
    expect(u).toEqual({ ok: true, data: { id: r.data.id } });

    const after = await ctx.prisma.reminderTarget.findMany({ where: { reminderId: r.data.id } });
    expect(after).toHaveLength(1);
    expect(after[0].partId).toBe(part.id);
    expect(after[0].itemId).toBeNull();
    expect(after[0].systemId).toBeNull();
    // Inherited the sentinel's schedule (the sentinel is replaced, not kept).
    expect(after[0].nextDueOn).toEqual(DUE);
  });
});

describe('completeReminder with a part target', () => {
  it('mirrors partId onto the auto-created ServiceRecordTarget', async () => {
    const part = await seedPart('Range hood grease filter');
    const r = await actions.createReminder({
      title: 'Clean hood filter',
      kind: 'REMINDER',
      targets: [{ partId: part.id }],
      recurrence: { kind: 'interval', every: 1, unit: 'month' },
      nextDueOn: DUE,
      autoCreateServiceRecord: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const c = await actions.completeReminder({
      id: r.data.id,
      serviceRecord: { summary: 'Degreased the hood filter' },
    });
    expect(c).toEqual({ ok: true, data: { id: r.data.id } });

    const srTargets = await ctx.prisma.serviceRecordTarget.findMany();
    expect(srTargets).toHaveLength(1);
    expect(srTargets[0].partId).toBe(part.id);
    expect(srTargets[0].itemId).toBeNull();
    expect(srTargets[0].systemId).toBeNull();
  });
});

describe('validateTargets part existence', () => {
  it('returns a form error (not an FK exception) for a bogus partId', async () => {
    const r = await actions.createReminder({
      title: 'Bogus part',
      kind: 'REMINDER',
      targets: [{ partId: 'nope-not-a-real-part' }],
      recurrence: { kind: 'interval', every: 1, unit: 'month' },
      nextDueOn: DUE,
    });
    expect(r).toEqual({ ok: false, formError: 'Part not found' });
  });
});
