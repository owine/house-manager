import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEnv } from '@/lib/env';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

const sentPushes: unknown[] = [];
const sentEmails: unknown[] = [];

vi.mock('@/lib/notifications/push', () => ({
  sendPush: vi.fn(async (_sub: unknown, payload: unknown) => {
    sentPushes.push(payload);
    return { ok: true };
  }),
}));

vi.mock('@/lib/notifications/email', () => ({
  sendEmail: vi.fn(async (_to: string, payload: unknown) => {
    sentEmails.push(payload);
    return { ok: true };
  }),
}));

vi.mock('@/lib/env', () => ({
  getEnv: vi.fn(() => ({
    APP_URL: 'http://localhost:3000',
  })),
}));

let ctx: IntegrationContext;
let userId: string;
let reminderId: string;
let handleNotify: (
  // biome-ignore lint/suspicious/noExplicitAny: imported via dynamic import in beforeAll
  payload: any,
  deps?: { enqueueLater?: (delay: Date) => Promise<void> },
) => Promise<void>;

beforeAll(async () => {
  ctx = await setupIntegration();
  const mod = await import('@/worker/jobs/notify');
  handleNotify = mod.handleNotify;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  sentPushes.length = 0;
  sentEmails.length = 0;
  await ctx.prisma.notificationLog.deleteMany();
  await ctx.prisma.pushSubscription.deleteMany();
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

describe('handleNotify', () => {
  it('inserts a NotificationLog with status=sent on push success', async () => {
    await ctx.prisma.pushSubscription.create({
      data: { userId, endpoint: 'e1', p256dh: 'p1', auth: 'a1' },
    });
    await handleNotify({ reminderId, userId, channel: 'push', cycle: 'C1' });
    const log = await ctx.prisma.notificationLog.findFirst({ where: { reminderId, cycle: 'C1' } });
    expect(log?.status).toBe('sent');
    expect(sentPushes).toHaveLength(1);
  });

  it('skips on duplicate cycle (unique-constraint dedupe)', async () => {
    await ctx.prisma.pushSubscription.create({
      data: { userId, endpoint: 'e1', p256dh: 'p1', auth: 'a1' },
    });
    await ctx.prisma.notificationLog.create({
      data: { reminderId, userId, channel: 'push', cycle: 'C1', status: 'sent' },
    });
    await handleNotify({ reminderId, userId, channel: 'push', cycle: 'C1' });
    expect(sentPushes).toHaveLength(0); // no new push was sent
  });

  it('logs status=skipped when no push subscriptions', async () => {
    await handleNotify({ reminderId, userId, channel: 'push', cycle: 'C1' });
    const log = await ctx.prisma.notificationLog.findFirst({ where: { reminderId, cycle: 'C1' } });
    expect(log?.status).toBe('skipped');
    expect(log?.errorReason).toBe('no subscriptions');
  });

  it('logs status=sent on email success', async () => {
    await handleNotify({ reminderId, userId, channel: 'email', cycle: 'C1' });
    const log = await ctx.prisma.notificationLog.findFirst({ where: { reminderId, cycle: 'C1' } });
    expect(log?.status).toBe('sent');
    expect(sentEmails).toHaveLength(1);
  });

  it('composes a reminder email with title, target link, and CTA', async () => {
    // Arrange: seed a category + item + reminder target so the email contains item links.
    const cat = await ctx.prisma.category.create({
      data: { slug: 'appliances', name: 'Appliances' },
    });
    const item = await ctx.prisma.item.create({
      data: { name: 'Furnace Filter', categoryId: cat.id },
    });
    await ctx.prisma.reminderTarget.create({
      data: {
        reminderId,
        itemId: item.id,
        nextDueOn: new Date('2026-06-01T12:00:00Z'),
      },
    });

    // Act
    await handleNotify({ reminderId, userId, channel: 'email', cycle: '2026-06-01' });

    // Assert: payload was captured and contains expected content.
    expect(sentEmails).toHaveLength(1);
    const payload = sentEmails[0] as { subject: string; html: string; text: string };
    expect(payload.subject).toMatch(/^Reminder: /);
    expect(payload.html).toContain('X'); // reminder title seeded in beforeEach
    expect(payload.html).toMatch(new RegExp(`href="http://localhost:3000/items/${item.id}"`));
    expect(payload.html).toContain('View reminder');
    expect(payload.text.length).toBeGreaterThan(0);
  });

  it('marks the log skipped with reason "APP_URL not configured" when APP_URL is unset', async () => {
    // Arrange: seed a category + item + reminder target (same pattern as content test).
    const cat = await ctx.prisma.category.create({
      data: { slug: 'appliances-skip', name: 'Appliances Skip' },
    });
    const item = await ctx.prisma.item.create({
      data: { name: 'Water Heater', categoryId: cat.id },
    });
    await ctx.prisma.reminderTarget.create({
      data: {
        reminderId,
        itemId: item.id,
        nextDueOn: new Date('2026-06-02T12:00:00Z'),
      },
    });

    // Override getEnv for this one call only: APP_URL is undefined.
    vi.mocked(getEnv).mockReturnValueOnce({
      APP_URL: undefined,
    } as unknown as ReturnType<typeof getEnv>);

    // Act
    await handleNotify({ reminderId, userId, channel: 'email', cycle: '2026-06-02' });

    // Assert: no email sent; log is skipped with the expected reason.
    expect(sentEmails).toHaveLength(0);
    const log = await ctx.prisma.notificationLog.findFirst({
      where: { reminderId, channel: 'email', cycle: '2026-06-02' },
    });
    expect(log?.status).toBe('skipped');
    expect(log?.errorReason).toBe('APP_URL not configured');
  });

  it('does not insert a log when in quiet-hours and re-enqueues via deps.enqueueLater', async () => {
    // Set quiet hours to encompass now
    await ctx.prisma.user.update({
      where: { id: userId },
      data: {
        notificationPrefs: {
          pushEnabled: true,
          emailEnabled: false,
          quietStart: '00:00',
          quietEnd: '23:59',
          timezone: 'UTC',
        },
      },
    });
    let enqueued: Date | null = null;
    await handleNotify(
      { reminderId, userId, channel: 'push', cycle: 'C1' },
      {
        enqueueLater: async (d) => {
          enqueued = d;
        },
      },
    );
    expect(enqueued).not.toBeNull();
    const log = await ctx.prisma.notificationLog.findFirst({ where: { reminderId, cycle: 'C1' } });
    expect(log).toBeNull();
  });
});
