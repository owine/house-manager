import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;
let userId: string;
let itemId: string;
let categoryId: string;
let handleRemindersTick: (deps: {
  enqueue: (job: {
    reminderId: string;
    userId: string;
    channel: 'push' | 'email';
    cycle: string;
  }) => Promise<void>;
}) => Promise<{ enqueued: number }>;

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
        targets: { create: [{ nextDueOn: new Date(), itemId }] },
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
    const dueOn = new Date();
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
        targets: { create: [{ nextDueOn: new Date(), itemId }] },
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
          create: [{ nextDueOn: new Date(Date.now() + 10 * 86_400_000), itemId }],
        },
      },
    });
    const r = await handleRemindersTick({ enqueue: async () => {} });
    expect(r.enqueued).toBe(0);
  });
});
