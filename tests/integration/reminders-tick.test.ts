import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

/**
 * `nextDueOn` is a CALENDAR DATE stored at UTC midnight -- that is what
 * computeNextDueOn produces and what the tick compares against. Seeding it with
 * a wall-clock instant (`new Date()`) mixes the two conventions and makes the
 * assertion depend on the hour the suite happens to run at.
 */
const todayCal = (): Date => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};
const calDaysOut = (n: number): Date => new Date(todayCal().getTime() + n * 86_400_000);

let ctx: IntegrationContext;
let userId: string;
let itemId: string;
let categoryId: string;
let handleRemindersTick: (
  deps: {
    enqueue: (job: {
      reminderId: string;
      userId: string;
      channel: 'push' | 'email';
      cycle: string;
    }) => Promise<void>;
  },
  now?: Date,
) => Promise<{ enqueued: number }>;

beforeAll(async () => {
  ctx = await setupIntegration();
  const mod = await import('@/worker/jobs/reminders-tick');
  handleRemindersTick = mod.handleRemindersTick;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.notificationLog.deleteMany();
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({
    data: {
      id: 'u1',
      email: 'u1@example.com',
      name: 'U1',
      notificationPrefs: { pushEnabled: true, emailEnabled: true },
    },
  });
  userId = 'u1';
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'tick-test' },
    create: { slug: 'tick-test', name: 'Tick test', sortOrder: 99 },
    update: {},
  });
  categoryId = cat.id;
  const item = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId } });
  itemId = item.id;
});

describe('handleRemindersTick', () => {
  it('enqueues 2 jobs (push + email) for a reminder due now with both channels enabled', async () => {
    await ctx.prisma.reminder.create({
      data: {
        title: 'X',
        recurrence: { kind: 'interval', days: 30 },
        leadTimeDays: 0,
        notifyUserIds: [userId],
        targets: { create: [{ nextDueOn: todayCal(), itemId }] },
      },
    });
    const enqueued: unknown[] = [];
    const r = await handleRemindersTick({
      enqueue: async (j) => {
        enqueued.push(j);
      },
    });
    expect(r.enqueued).toBe(2);
    expect(enqueued).toHaveLength(2);
  });

  it('skips reminders already logged for the cycle', async () => {
    const dueOn = todayCal();
    const reminder = await ctx.prisma.reminder.create({
      data: {
        title: 'X',
        recurrence: { kind: 'interval', days: 30 },
        leadTimeDays: 0,
        notifyUserIds: [userId],
        targets: { create: [{ nextDueOn: dueOn, itemId }] },
      },
    });
    const cycle = `reminder-${reminder.id}-${dueOn.toISOString().slice(0, 10)}`;
    await ctx.prisma.notificationLog.create({
      data: { reminderId: reminder.id, userId, channel: 'push', cycle, status: 'sent' },
    });
    await ctx.prisma.notificationLog.create({
      data: { reminderId: reminder.id, userId, channel: 'email', cycle, status: 'sent' },
    });
    const enqueued: unknown[] = [];
    const r = await handleRemindersTick({
      enqueue: async (j) => {
        enqueued.push(j);
      },
    });
    expect(r.enqueued).toBe(0);
  });

  it('skips inactive reminders', async () => {
    await ctx.prisma.reminder.create({
      data: {
        title: 'X',
        recurrence: { kind: 'interval', days: 30 },
        notifyUserIds: [userId],
        active: false,
        targets: { create: [{ nextDueOn: todayCal(), itemId }] },
      },
    });
    const r = await handleRemindersTick({ enqueue: async () => {} });
    expect(r.enqueued).toBe(0);
  });

  it('respects leadTimeDays — does not enqueue for reminder still 10 days out with leadTime=3', async () => {
    await ctx.prisma.reminder.create({
      data: {
        title: 'X',
        recurrence: { kind: 'interval', days: 30 },
        leadTimeDays: 3,
        notifyUserIds: [userId],
        targets: {
          create: [{ nextDueOn: calDaysOut(10), itemId }],
        },
      },
    });
    const r = await handleRemindersTick({ enqueue: async () => {} });
    expect(r.enqueued).toBe(0);
  });
});

describe('handleRemindersTick lead window (house timezone)', () => {
  // The tests above never seed a HouseProfile, so the tz defaults to 'UTC' --
  // the one timezone in which comparing a UTC-midnight nextDueOn against the
  // instant `now` happens to be right. In Chicago (UTC-5) the lead window opened
  // 5 hours early, so a 0-lead reminder due Jul 15 notified at 7pm on Jul 14.
  beforeEach(async () => {
    await ctx.prisma.houseProfile.deleteMany();
    await ctx.prisma.houseProfile.create({
      data: { timezone: 'America/Chicago' },
    });
  });

  const seedDueJul15 = () =>
    ctx.prisma.reminder.create({
      data: {
        title: 'Due Jul 15',
        recurrence: { kind: 'NONE' },
        leadTimeDays: 0,
        notifyUserIds: [userId],
        targets: { create: [{ nextDueOn: new Date(Date.UTC(2026, 6, 15)), itemId }] },
      },
    });

  it('does not notify the evening before, when UTC has rolled over but the house day has not', async () => {
    await seedDueJul15();
    // 20:00 CDT on Jul 14 == 01:00Z on Jul 15. Still Jul 14 in the house.
    const r = await handleRemindersTick(
      { enqueue: async () => {} },
      new Date('2026-07-15T01:00:00Z'),
    );
    expect(r.enqueued).toBe(0);
  });

  it('notifies on the morning of the due date in the house tz', async () => {
    await seedDueJul15();
    // 08:00 CDT on Jul 15.
    const r = await handleRemindersTick(
      { enqueue: async () => {} },
      new Date('2026-07-15T13:00:00Z'),
    );
    expect(r.enqueued).toBe(2); // push + email
  });
});
