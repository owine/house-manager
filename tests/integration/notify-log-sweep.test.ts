import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;
let handleNotifyLogSweep: typeof import('@/worker/jobs/notify-log-sweep').handleNotifyLogSweep;

beforeAll(async () => {
  ctx = await setupIntegration();
  ({ handleNotifyLogSweep } = await import('@/worker/jobs/notify-log-sweep'));
}, 60_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.notificationLog.deleteMany();
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({
    data: { id: 'sweep-u1', email: 'sweep@example.com', name: 'Sweep' },
  });
  await ctx.prisma.reminder.create({
    data: {
      id: 'sweep-r1',
      title: 'Filter',
      recurrence: { kind: 'interval', days: 90 },
      nextDueOn: new Date('2026-06-30'),
      notifyUserIds: ['sweep-u1'],
    },
  });
});

describe('handleNotifyLogSweep', () => {
  it('deletes only stale queued rows; leaves fresh queued and sent rows alone', async () => {
    const longAgo = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
    const justNow = new Date();

    await ctx.prisma.notificationLog.createMany({
      data: [
        // Stale queued — should be deleted.
        {
          reminderId: 'sweep-r1',
          userId: 'sweep-u1',
          channel: 'push',
          cycle: '2026-06-30',
          status: 'queued',
          sentAt: longAgo,
        },
        // Fresh queued — should be kept (might still be in-flight).
        {
          reminderId: 'sweep-r1',
          userId: 'sweep-u1',
          channel: 'email',
          cycle: '2026-06-30',
          status: 'queued',
          sentAt: justNow,
        },
        // Sent — should be kept regardless of age.
        {
          reminderId: 'sweep-r1',
          userId: 'sweep-u1',
          channel: 'push',
          cycle: '2026-05-30',
          status: 'sent',
          sentAt: longAgo,
        },
      ],
    });

    const result = await handleNotifyLogSweep();
    expect(result.deleted).toBe(1);

    const remaining = await ctx.prisma.notificationLog.findMany({
      orderBy: { sentAt: 'asc' },
    });
    expect(remaining).toHaveLength(2);
    const statuses = remaining.map((r) => r.status).sort();
    expect(statuses).toEqual(['queued', 'sent']);
  });

  it('returns deleted=0 when nothing is stale', async () => {
    await ctx.prisma.notificationLog.create({
      data: {
        reminderId: 'sweep-r1',
        userId: 'sweep-u1',
        channel: 'push',
        cycle: '2026-06-30',
        status: 'queued',
        sentAt: new Date(),
      },
    });
    const result = await handleNotifyLogSweep();
    expect(result.deleted).toBe(0);
  });
});
