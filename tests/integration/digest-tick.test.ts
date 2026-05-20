import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEnv } from '@/lib/env';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

const sentEmails: unknown[] = [];

vi.mock('@/lib/notifications/email', () => ({
  sendEmail: vi.fn(async (_to: string, payload: unknown) => {
    sentEmails.push(payload);
    return { ok: true };
  }),
}));

vi.mock('@/lib/env', () => ({
  getEnv: vi.fn(() => ({ APP_URL: 'http://localhost:3000' })),
}));

let ctx: IntegrationContext;
let userId: string;
let categoryId: string;
let itemId: string;
let handleDigestTick: () => Promise<void>;

beforeAll(async () => {
  ctx = await setupIntegration();
  const mod = await import('@/worker/jobs/digest-tick');
  handleDigestTick = mod.handleDigestTick;
  const cat = await ctx.prisma.category.create({
    data: { slug: 'digest-tick-cat', name: 'DTCat', sortOrder: 999 },
  });
  categoryId = cat.id;
  const item = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId } });
  itemId = item.id;
});

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  sentEmails.length = 0;
  await ctx.prisma.digestLog.deleteMany({});
  await ctx.prisma.reminder.deleteMany({});
  await ctx.prisma.user.deleteMany({});
  const nowHour = new Date().getUTCHours();
  const user = await ctx.prisma.user.create({
    data: {
      email: 'tick@example.test',
      name: 'Tick',
      notificationPrefs: {
        emailEnabled: true,
        timezone: 'UTC',
        overdueDigestEnabled: true,
        overdueDigestHour: nowHour,
        weeklySummaryEnabled: false,
        weeklySummaryDay: 1,
        weeklySummaryHour: 8,
      },
    },
  });
  userId = user.id;
});

async function seedOverdue() {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await ctx.prisma.reminder.create({
    data: {
      title: 'Filter',
      recurrence: { kind: 'NONE' },
      notifyUserIds: [userId],
      active: true,
      targets: { create: [{ itemId, nextDueOn: yesterday }] },
    },
  });
}

describe('handleDigestTick — overdue path', () => {
  it('sends one email + writes a sent DigestLog row when an overdue item exists', async () => {
    await seedOverdue();
    await handleDigestTick();
    expect(sentEmails).toHaveLength(1);
    const payload = sentEmails[0] as { subject: string; html: string; text: string };
    expect(payload.subject).toMatch(/^Overdue: /);
    expect(payload.html).toContain('Filter');
    const log = await ctx.prisma.digestLog.findFirst({ where: { userId, kind: 'overdue' } });
    expect(log?.status).toBe('sent');
  });

  it('is idempotent: a second tick in the same cycle does not re-send', async () => {
    await seedOverdue();
    await handleDigestTick();
    await handleDigestTick();
    expect(sentEmails).toHaveLength(1);
    const logs = await ctx.prisma.digestLog.findMany({ where: { userId, kind: 'overdue' } });
    expect(logs).toHaveLength(1);
  });

  it('does not send when overdueDigestEnabled is false', async () => {
    await ctx.prisma.user.update({
      where: { id: userId },
      data: {
        notificationPrefs: { emailEnabled: true, timezone: 'UTC', overdueDigestEnabled: false },
      },
    });
    await seedOverdue();
    await handleDigestTick();
    expect(sentEmails).toHaveLength(0);
    expect(await ctx.prisma.digestLog.count()).toBe(0);
  });

  it('skips with "nothing to report" when no overdue items exist', async () => {
    await handleDigestTick();
    expect(sentEmails).toHaveLength(0);
    const log = await ctx.prisma.digestLog.findFirst({ where: { userId, kind: 'overdue' } });
    expect(log?.status).toBe('skipped');
    expect(log?.errorReason).toBe('nothing to report');
  });

  it('skips with "APP_URL not configured" when env.APP_URL is unset', async () => {
    vi.mocked(getEnv).mockReturnValueOnce({ APP_URL: undefined } as unknown as ReturnType<
      typeof getEnv
    >);
    await seedOverdue();
    await handleDigestTick();
    expect(sentEmails).toHaveLength(0);
    const log = await ctx.prisma.digestLog.findFirst({ where: { userId, kind: 'overdue' } });
    expect(log?.status).toBe('skipped');
    expect(log?.errorReason).toBe('APP_URL not configured');
  });
});

describe('handleDigestTick — weekly path', () => {
  it('sends the weekly digest when day + hour match and the query is non-empty', async () => {
    const now = new Date();
    const dayIdx = now.getUTCDay();
    const hour = now.getUTCHours();
    await ctx.prisma.user.update({
      where: { id: userId },
      data: {
        notificationPrefs: {
          emailEnabled: true,
          timezone: 'UTC',
          overdueDigestEnabled: false,
          weeklySummaryEnabled: true,
          weeklySummaryDay: dayIdx,
          weeklySummaryHour: hour,
        },
      },
    });
    const inThreeDays = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await ctx.prisma.reminder.create({
      data: {
        title: 'Upcoming',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: inThreeDays }] },
      },
    });
    await handleDigestTick();
    expect(sentEmails).toHaveLength(1);
    const payload = sentEmails[0] as { subject: string };
    expect(payload.subject).toMatch(/^This week: /);
    const log = await ctx.prisma.digestLog.findFirst({ where: { userId, kind: 'weekly' } });
    expect(log?.status).toBe('sent');
  });
});
