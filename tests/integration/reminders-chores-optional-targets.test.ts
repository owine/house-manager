import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type IntegrationContext,
  setupIntegration,
  teardownIntegration,
  todayCal,
} from './helpers';

// Mirror reminders-auth.test.ts: per-test session via a mutable currentUserId.
let currentUserId: string | null = null;

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => (currentUserId ? { user: { id: currentUserId } } : null)),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

let ctx: IntegrationContext;
let actions: typeof import('@/lib/reminders/actions');
let categoryId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  actions = await import('@/lib/reminders/actions');
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.reminderCompletion.deleteMany();
  await ctx.prisma.notificationLog.deleteMany();
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({
    data: { id: 'u1', email: 'u1@example.com', name: 'U1' },
  });
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'chore-optional-test' },
    create: { slug: 'chore-optional-test', name: 'Chore optional', sortOrder: 99 },
    update: {},
  });
  categoryId = cat.id;
  currentUserId = 'u1';
});

async function seedItem(name = 'Dishwasher') {
  return ctx.prisma.item.create({ data: { name, categoryId } });
}

describe('chore reconciliation', () => {
  it('creates exactly one standalone ReminderTarget when chore has no links', async () => {
    const r = await actions.createReminder({
      title: 'Trash day',
      kind: 'CHORE',
      targets: [],
      recurrence: { kind: 'weekly', weekdays: [1], interval: 1 },
      nextDueOn: new Date('2026-06-01'),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const targets = await ctx.prisma.reminderTarget.findMany({
      where: { reminderId: r.data.id },
    });
    expect(targets).toHaveLength(1);
    expect(targets[0].itemId).toBeNull();
    expect(targets[0].systemId).toBeNull();
  });

  it('creates only link rows (no standalone) when chore has >=1 link', async () => {
    const item = await seedItem('Wipe-down dishwasher');
    const r = await actions.createReminder({
      title: 'Wipe down dishwasher',
      kind: 'CHORE',
      targets: [{ itemId: item.id }],
      recurrence: { kind: 'interval', every: 30, unit: 'day' },
      nextDueOn: new Date('2026-06-01'),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const targets = await ctx.prisma.reminderTarget.findMany({
      where: { reminderId: r.data.id },
    });
    expect(targets).toHaveLength(1);
    expect(targets[0].itemId).toBe(item.id);
    expect(targets[0].systemId).toBeNull();
  });

  it('transitions chore from links to standalone, inheriting schedule from most-recently-completed link', async () => {
    const item = await seedItem('Y-item');
    const r = await actions.createReminder({
      title: 'Y',
      kind: 'CHORE',
      targets: [{ itemId: item.id }],
      recurrence: { kind: 'interval', every: 30, unit: 'day' },
      nextDueOn: new Date('2026-06-01'),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Simulate a completion so lastCompletedOn is non-null on the link row.
    const c = await actions.completeReminder({ id: r.data.id });
    expect(c.ok).toBe(true);

    const u = await actions.updateReminder({
      id: r.data.id,
      kind: 'CHORE',
      targets: [],
    });
    expect(u.ok).toBe(true);

    const targets = await ctx.prisma.reminderTarget.findMany({
      where: { reminderId: r.data.id },
    });
    expect(targets).toHaveLength(1);
    expect(targets[0].itemId).toBeNull();
    expect(targets[0].systemId).toBeNull();
    expect(targets[0].lastCompletedOn).not.toBeNull();
  });

  it('transitions chore from standalone to links, seeding link rows with standalone schedule', async () => {
    const r = await actions.createReminder({
      title: 'Z',
      kind: 'CHORE',
      targets: [],
      recurrence: { kind: 'interval', every: 30, unit: 'day' },
      nextDueOn: new Date('2026-06-01'),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const item = await seedItem('Z-item');
    const u = await actions.updateReminder({
      id: r.data.id,
      kind: 'CHORE',
      targets: [{ itemId: item.id }],
    });
    expect(u.ok).toBe(true);

    const targets = await ctx.prisma.reminderTarget.findMany({
      where: { reminderId: r.data.id },
    });
    expect(targets).toHaveLength(1);
    expect(targets[0].itemId).toBe(item.id);
    expect(targets[0].nextDueOn).toEqual(new Date('2026-06-01'));
  });

  it('rejects a REMINDER create with empty targets (existing rule preserved)', async () => {
    const r = await actions.createReminder({
      title: 'A',
      kind: 'REMINDER',
      targets: [],
      recurrence: { kind: 'interval', every: 60, unit: 'day' },
      nextDueOn: todayCal(),
    });
    expect(r.ok).toBe(false);
  });

  it('transitions REMINDER → CHORE with empty targets (cross-kind flip mints standalone)', async () => {
    const item = await seedItem('crosskind-item');
    const r = await actions.createReminder({
      title: 'Was a reminder',
      kind: 'REMINDER',
      targets: [{ itemId: item.id }],
      recurrence: { kind: 'interval', every: 60, unit: 'day' },
      nextDueOn: new Date('2026-06-01'),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const u = await actions.updateReminder({
      id: r.data.id,
      kind: 'CHORE',
      targets: [],
    });
    expect(u.ok).toBe(true);

    const targets = await ctx.prisma.reminderTarget.findMany({
      where: { reminderId: r.data.id },
    });
    expect(targets).toHaveLength(1);
    expect(targets[0].itemId).toBeNull();
    expect(targets[0].systemId).toBeNull();
  });
});

describe('editing the due date with the targets unchanged (what the edit form sends)', () => {
  const dueOf = async (reminderId: string) =>
    (
      await ctx.prisma.reminderTarget.findMany({
        where: { reminderId },
        orderBy: { nextDueOn: 'asc' },
        select: { nextDueOn: true },
      })
    ).map((t) => t.nextDueOn.toISOString().slice(0, 10));

  it('moves the kept targets to the new date', async () => {
    const item = await seedItem('Furnace');
    const r = await actions.createReminder({
      title: 'Filter',
      kind: 'REMINDER',
      targets: [{ itemId: item.id }],
      recurrence: { kind: 'interval', every: 90, unit: 'day' },
      nextDueOn: new Date('2026-06-01'),
    });
    if (!r.ok) throw new Error('create failed');

    const u = await actions.updateReminder({
      id: r.data.id,
      kind: 'REMINDER',
      targets: [{ itemId: item.id }],
      nextDueOn: new Date('2026-07-15'),
    });
    expect(u).toMatchObject({ ok: true });
    expect(await dueOf(r.data.id)).toEqual(['2026-07-15']);
  });

  it('leaves per-target dates alone when the shown (earliest) date was not changed', async () => {
    const a = await seedItem('A');
    const b = await seedItem('B');
    const r = await actions.createReminder({
      title: 'Two',
      kind: 'REMINDER',
      targets: [{ itemId: a.id }, { itemId: b.id }],
      recurrence: { kind: 'interval', every: 90, unit: 'day' },
      nextDueOn: new Date('2026-06-01'),
    });
    if (!r.ok) throw new Error('create failed');
    await ctx.prisma.reminderTarget.updateMany({
      where: { reminderId: r.data.id, itemId: b.id },
      data: { nextDueOn: new Date('2026-09-01') },
    });

    const u = await actions.updateReminder({
      id: r.data.id,
      kind: 'REMINDER',
      title: 'Two, renamed',
      targets: [{ itemId: a.id }, { itemId: b.id }],
      nextDueOn: new Date('2026-06-01'),
    });
    expect(u).toMatchObject({ ok: true });
    expect(await dueOf(r.data.id)).toEqual(['2026-06-01', '2026-09-01']);
  });

  it('re-arms a completed one-time reminder from the date the form offers', async () => {
    const item = await seedItem('Gutter');
    const r = await actions.createReminder({
      title: 'Once',
      kind: 'REMINDER',
      targets: [{ itemId: item.id }],
      recurrence: { kind: 'once' },
      nextDueOn: new Date('2026-06-01'),
    });
    if (!r.ok) throw new Error('create failed');
    expect((await actions.completeReminder({ id: r.data.id })).ok).toBe(true);
    expect(await dueOf(r.data.id)).toEqual(['9999-12-31']);

    const u = await actions.updateReminder({
      id: r.data.id,
      kind: 'REMINDER',
      targets: [{ itemId: item.id }],
      nextDueOn: new Date('2026-08-01'),
    });
    expect(u).toMatchObject({ ok: true });
    expect(await dueOf(r.data.id)).toEqual(['2026-08-01']);
  });
});
