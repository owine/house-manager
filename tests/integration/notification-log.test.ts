import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;
let userId: string;
let reminderId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.notificationLog.deleteMany();
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({
    data: { id: 'u1', email: 'u1@example.com', name: 'U1' },
  });
  userId = 'u1';
  const r = await ctx.prisma.reminder.create({
    data: {
      title: 'X',
      recurrence: { kind: 'interval', days: 30 },
      notifyUserIds: [userId],
    },
  });
  reminderId = r.id;
});

describe('NotificationLog unique constraint', () => {
  it('rejects duplicate (reminderId, userId, channel, cycle)', async () => {
    await ctx.prisma.notificationLog.create({
      data: { reminderId, userId, channel: 'push', cycle: 'reminder-x-2026-06-30', status: 'sent' },
    });
    await expect(
      ctx.prisma.notificationLog.create({
        data: {
          reminderId,
          userId,
          channel: 'push',
          cycle: 'reminder-x-2026-06-30',
          status: 'sent',
        },
      }),
    ).rejects.toThrow();
  });

  it('allows different channels in the same cycle', async () => {
    await ctx.prisma.notificationLog.create({
      data: { reminderId, userId, channel: 'push', cycle: 'C', status: 'sent' },
    });
    const second = await ctx.prisma.notificationLog.create({
      data: { reminderId, userId, channel: 'email', cycle: 'C', status: 'sent' },
    });
    expect(second.channel).toBe('email');
  });

  it('allows different cycles for the same channel', async () => {
    await ctx.prisma.notificationLog.create({
      data: { reminderId, userId, channel: 'push', cycle: 'A', status: 'sent' },
    });
    const second = await ctx.prisma.notificationLog.create({
      data: { reminderId, userId, channel: 'push', cycle: 'B', status: 'sent' },
    });
    expect(second.cycle).toBe('B');
  });
});
