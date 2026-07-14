import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let currentUserId: string | null = null;

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => (currentUserId ? { user: { id: currentUserId } } : null)),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/search/client', () => ({ enqueueSearchIndex: vi.fn(async () => {}) }));
vi.mock('@/lib/embedding/enqueue', () => ({ enqueueEmbed: vi.fn(async () => {}) }));

let ctx: IntegrationContext;
let actions: typeof import('@/lib/reminders/actions');
let itemId: string;

/**
 * 20:00 CDT on Tue Jul 14 2026. In UTC that is already Jul 15 -- the window in
 * which every calendar-date-vs-instant bug in this codebase bites.
 */
const EVENING_IN_CHICAGO = new Date('2026-07-15T01:00:00Z');
const JUL_14 = new Date(Date.UTC(2026, 6, 14));

beforeAll(async () => {
  ctx = await setupIntegration();
  actions = await import('@/lib/reminders/actions');
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(EVENING_IN_CHICAGO);

  await ctx.prisma.reminderCompletion.deleteMany();
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.houseProfile.deleteMany();
  await ctx.prisma.houseProfile.create({ data: { timezone: 'America/Chicago' } });
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@example.com', name: 'U1' } });
  currentUserId = 'u1';
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'completion-house-day' },
    create: { slug: 'completion-house-day', name: 'CHD', sortOrder: 98 },
    update: {},
  });
  const item = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId: cat.id } });
  itemId = item.id;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('completing a reminder in the evening (house tz)', () => {
  const seed = (autoCreateServiceRecord = false) =>
    ctx.prisma.reminder.create({
      data: {
        title: 'Furnace filter',
        recurrence: { kind: 'interval', every: 30, unit: 'day' },
        notifyUserIds: ['u1'],
        autoCreateServiceRecord,
        targets: { create: [{ itemId, nextDueOn: JUL_14 }] },
      },
      include: { targets: true },
    });

  it('advances nextDueOn from the house day, not the UTC day', async () => {
    // `computeNextDueOn` was seeded with the raw completion instant. At 8pm
    // Chicago that instant is already Jul 15 in UTC, so an "every 30 days"
    // reminder came back on day 31.
    const r = await seed();
    const res = await actions.completeReminder({ id: r.id });
    expect(res.ok).toBe(true);

    const t = await ctx.prisma.reminderTarget.findUniqueOrThrow({
      where: { id: r.targets[0]?.id as string },
    });
    // Jul 14 + 30 days = Aug 13. (Seeded from the UTC day it would be Aug 14.)
    expect(t.nextDueOn.toISOString().slice(0, 10)).toBe('2026-08-13');
  });

  it('files the auto-created service record under the house day', async () => {
    // `performedOn` is a calendar date. Written as the raw instant it landed on
    // Jul 15 -- and /service filters `performedOn: { lte: <UTC midnight> }`, so a
    // "to: 2026-07-14" range would silently omit a record created this evening.
    const r = await seed(true);
    const res = await actions.completeReminder({
      id: r.id,
      serviceRecord: { summary: 'Swapped filter' },
    });
    expect(res.ok).toBe(true);

    const sr = await ctx.prisma.serviceRecord.findFirstOrThrow();
    expect(sr.performedOn.toISOString()).toBe('2026-07-14T00:00:00.000Z');
  });

  it('keeps completedOn as a real instant', async () => {
    // The completion *moment* is genuinely an instant -- only the calendar-date
    // columns get reduced to the house day.
    const r = await seed();
    await actions.completeReminder({ id: r.id });
    const c = await ctx.prisma.reminderCompletion.findFirstOrThrow();
    expect(c.completedOn.toISOString()).toBe(EVENING_IN_CHICAGO.toISOString());
  });
});
