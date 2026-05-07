import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;
let handleRemindersTick: typeof import('@/worker/jobs/reminders-tick').handleRemindersTick;

beforeAll(async () => {
  ctx = await setupIntegration();
  ({ handleRemindersTick } = await import('@/worker/jobs/reminders-tick'));
}, 60_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

let recoveryItemId: string;

beforeEach(async () => {
  await ctx.prisma.notificationLog.deleteMany();
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({
    data: { id: 'r1u', email: 'recovery@example.com', name: 'R' },
  });
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'recovery-test' },
    create: { slug: 'recovery-test', name: 'Recovery test', sortOrder: 99 },
    update: {},
  });
  const item = await ctx.prisma.item.create({ data: { name: 'F', categoryId: cat.id } });
  recoveryItemId = item.id;
});

describe('missed-tick recovery', () => {
  it('enqueues notify jobs for past-due reminders that have no NotificationLog row', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await ctx.prisma.reminder.create({
      data: {
        id: 'past-due-r1',
        title: 'Furnace filter',
        recurrence: { kind: 'interval', days: 90 },
        leadTimeDays: 0,
        notifyUserIds: ['r1u'],
        targets: { create: [{ nextDueOn: twoHoursAgo, itemId: recoveryItemId }] },
      },
    });

    const enqueued: Array<{ reminderId: string; userId: string; channel: string; cycle: string }> =
      [];
    const result = await handleRemindersTick({
      enqueue: async (job) => {
        enqueued.push(job);
      },
    });

    expect(result.enqueued).toBeGreaterThan(0);
    expect(enqueued.some((j) => j.reminderId === 'past-due-r1')).toBe(true);
  });

  it('locks in tick-side dedup behavior: tick re-enqueues even when a NotificationLog exists; the unique constraint at the notify handler is what dedupes', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const cycle = twoHoursAgo.toISOString().slice(0, 10);
    await ctx.prisma.reminder.create({
      data: {
        id: 'past-due-r2',
        title: 'Already notified',
        recurrence: { kind: 'interval', days: 90 },
        leadTimeDays: 0,
        notifyUserIds: ['r1u'],
        targets: { create: [{ nextDueOn: twoHoursAgo, itemId: recoveryItemId }] },
      },
    });
    await ctx.prisma.notificationLog.create({
      data: {
        reminderId: 'past-due-r2',
        userId: 'r1u',
        channel: 'push',
        cycle,
        status: 'sent',
      },
    });

    const result = await handleRemindersTick({
      enqueue: async () => {},
    });
    expect(result.enqueued).toBeGreaterThanOrEqual(1);
    const logs = await ctx.prisma.notificationLog.findMany({
      where: { reminderId: 'past-due-r2' },
    });
    expect(logs).toHaveLength(1);
  });
});
