import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

// Mirror reminders-auth.test.ts: per-test session via a mutable currentUserId.
let currentUserId: string | null = null;

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => (currentUserId ? { user: { id: currentUserId } } : null)),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

let ctx: IntegrationContext;
let actions: typeof import('@/lib/reminders/actions');
let categoryId: string;
let itemId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  actions = await import('@/lib/reminders/actions');
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'autocomplete-coerce-test' },
    create: { slug: 'autocomplete-coerce-test', name: 'AutoComplete coerce', sortOrder: 99 },
    update: {},
  });
  categoryId = cat.id;
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
  const item = await ctx.prisma.item.create({ data: { name: 'HVAC', categoryId } });
  itemId = item.id;
  currentUserId = 'u1';
});

describe('createReminder — autoComplete server-side coercion', () => {
  it('stores autoComplete=true when kind=CHORE', async () => {
    const result = await actions.createReminder({
      title: 'Water plants',
      kind: 'CHORE',
      recurrence: { kind: 'interval', every: 1, unit: 'week' },
      nextDueOn: new Date('2026-05-27'),
      targets: [],
      autoComplete: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await ctx.prisma.reminder.findUnique({ where: { id: result.data.id } });
    expect(row?.autoComplete).toBe(true);
  });

  it('coerces autoComplete to false when kind=REMINDER (even if client submits true)', async () => {
    const result = await actions.createReminder({
      title: 'HVAC service',
      kind: 'REMINDER',
      recurrence: { kind: 'interval', every: 6, unit: 'month' },
      nextDueOn: new Date('2026-05-27'),
      targets: [{ itemId }],
      autoComplete: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await ctx.prisma.reminder.findUnique({ where: { id: result.data.id } });
    expect(row?.autoComplete).toBe(false);
  });

  it('autoComplete defaults to false on CHORE when omitted', async () => {
    const result = await actions.createReminder({
      title: 'Trash day',
      kind: 'CHORE',
      recurrence: { kind: 'weekly', weekdays: [1], interval: 1 },
      nextDueOn: new Date('2026-05-27'),
      targets: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await ctx.prisma.reminder.findUnique({ where: { id: result.data.id } });
    expect(row?.autoComplete).toBe(false);
  });
});

describe('updateReminder — autoComplete server-side coercion', () => {
  it('coerces autoComplete to false when kind flips from CHORE to REMINDER', async () => {
    // Seed a CHORE with autoComplete=true
    const chore = await ctx.prisma.reminder.create({
      data: {
        title: 'Water plants',
        kind: 'CHORE',
        recurrence: { kind: 'interval', every: 1, unit: 'week' },
        notifyUserIds: ['u1'],
        autoComplete: true,
        targets: { create: [{ itemId, nextDueOn: new Date('2026-05-27') }] },
      },
    });

    // Flip to REMINDER, submitting autoComplete: true — server must coerce it
    const result = await actions.updateReminder({
      id: chore.id,
      kind: 'REMINDER',
      targets: [{ itemId }],
      autoComplete: true,
    });
    expect(result.ok).toBe(true);

    const row = await ctx.prisma.reminder.findUnique({ where: { id: chore.id } });
    expect(row?.autoComplete).toBe(false);
  });

  it('clears latent autoComplete=true on CHORE→REMINDER flip even when payload omits autoComplete', async () => {
    // Seed a CHORE with autoComplete=true, then flip to REMINDER WITHOUT
    // mentioning autoComplete in the payload. The latent true must be cleared.
    const chore = await ctx.prisma.reminder.create({
      data: {
        title: 'Water plants',
        kind: 'CHORE',
        recurrence: { kind: 'interval', every: 1, unit: 'week' },
        notifyUserIds: ['u1'],
        autoComplete: true,
        targets: { create: [{ itemId, nextDueOn: new Date('2026-05-27') }] },
      },
    });

    const result = await actions.updateReminder({
      id: chore.id,
      kind: 'REMINDER',
      targets: [{ itemId }],
    });
    expect(result.ok).toBe(true);

    const row = await ctx.prisma.reminder.findUnique({ where: { id: chore.id } });
    expect(row?.autoComplete).toBe(false);
  });

  it('preserves autoComplete=true when update keeps kind=CHORE', async () => {
    const chore = await ctx.prisma.reminder.create({
      data: {
        title: 'Water plants',
        kind: 'CHORE',
        recurrence: { kind: 'interval', every: 1, unit: 'week' },
        notifyUserIds: ['u1'],
        autoComplete: false,
        targets: { create: [{ itemId: null, systemId: null, nextDueOn: new Date('2026-05-27') }] },
      },
    });

    const result = await actions.updateReminder({
      id: chore.id,
      kind: 'CHORE',
      autoComplete: true,
    });
    expect(result.ok).toBe(true);

    const row = await ctx.prisma.reminder.findUnique({ where: { id: chore.id } });
    expect(row?.autoComplete).toBe(true);
  });

  it('coerces autoComplete to false when existing kind=REMINDER and kind is omitted in update', async () => {
    // Seed a REMINDER. autoComplete should always be false on REMINDERs, but
    // test the coercion path for a kind-omitted update payload.
    const reminder = await ctx.prisma.reminder.create({
      data: {
        title: 'HVAC service',
        kind: 'REMINDER',
        recurrence: { kind: 'interval', every: 6, unit: 'month' },
        notifyUserIds: ['u1'],
        autoComplete: false,
        targets: { create: [{ itemId, nextDueOn: new Date('2026-05-27') }] },
      },
    });

    // Submit autoComplete: true with no kind — effective kind is REMINDER
    const result = await actions.updateReminder({
      id: reminder.id,
      autoComplete: true,
    });
    expect(result.ok).toBe(true);

    const row = await ctx.prisma.reminder.findUnique({ where: { id: reminder.id } });
    expect(row?.autoComplete).toBe(false);
  });
});
