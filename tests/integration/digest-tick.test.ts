import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEnv } from '@/lib/env';
import {
  calDaysOut,
  type IntegrationContext,
  setupIntegration,
  teardownIntegration,
} from './helpers';

const sentEmails: unknown[] = [];

// The prefs below are seeded from "now" and handleDigestTick reads its own
// "now" to decide whether this is the user's hour (and, weekly, their day).
// On the real clock those are two reads tens of ms apart, and a tick that
// lands after the top of the hour sends nothing. Freeze Date mid-hour instead.
// No HouseProfile row exists, so the house timezone is UTC.
const MID_HOUR = new Date('2026-07-15T14:30:00Z'); // a Wednesday

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
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(MID_HOUR);
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

afterEach(() => {
  vi.useRealTimers();
});

async function seedOverdue() {
  const yesterday = calDaysOut(-1);
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
        notificationPrefs: { emailEnabled: true, overdueDigestEnabled: false },
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
          overdueDigestEnabled: false,
          weeklySummaryEnabled: true,
          weeklySummaryDay: dayIdx,
          weeklySummaryHour: hour,
        },
      },
    });
    const inThreeDays = calDaysOut(3);
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

describe('handleDigestTick — catch-up window (house in Chicago)', () => {
  const tickAt = async (iso: string) => {
    vi.setSystemTime(new Date(iso));
    await handleDigestTick();
  };
  const setPrefs = (prefs: Record<string, unknown>) =>
    ctx.prisma.user.update({
      where: { id: userId },
      data: { notificationPrefs: { emailEnabled: true, ...prefs } },
    });
  const sentKinds = async () =>
    (await ctx.prisma.digestLog.findMany({ where: { userId, status: 'sent' } }))
      .map((l) => `${l.kind}:${l.cycle}`)
      .sort();

  beforeEach(async () => {
    await ctx.prisma.houseProfile.deleteMany();
    await ctx.prisma.houseProfile.create({ data: { timezone: 'America/Chicago' } });
  });
  afterEach(async () => {
    await ctx.prisma.houseProfile.deleteMany();
  });

  it('a 02:00 digest still goes out on spring-forward Sunday, when 02:00 never happens', async () => {
    // Sun 2027-03-14 in Chicago: ticks read 01:00, 01:30, then 03:00 CDT.
    vi.setSystemTime(new Date('2027-03-14T07:00:00Z'));
    await seedOverdue();
    await ctx.prisma.reminder.create({
      data: {
        title: 'Upcoming',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: calDaysOut(3) }] },
      },
    });
    await setPrefs({
      overdueDigestEnabled: true,
      overdueDigestHour: 2,
      weeklySummaryEnabled: true,
      weeklySummaryDay: 0,
      weeklySummaryHour: 2,
    });

    for (const t of ['07:00', '07:30', '08:00', '08:30']) await tickAt(`2027-03-14T${t}:00Z`);

    expect(await sentKinds()).toEqual(['overdue:2027-03-14', 'weekly:2027-W10']);
    expect(sentEmails).toHaveLength(2);
  });

  it('catches up after missed ticks in the chosen hour, once', async () => {
    // The worker was down for 08:00 and 08:30 CDT; it is back at 10:30.
    vi.setSystemTime(new Date('2026-07-15T15:30:00Z'));
    await seedOverdue();
    await setPrefs({ overdueDigestEnabled: true, overdueDigestHour: 8 });

    await tickAt('2026-07-15T15:30:00Z'); // 10:30 CDT
    await tickAt('2026-07-15T16:00:00Z'); // 11:00 CDT

    expect(sentEmails).toHaveLength(1);
    expect(await sentKinds()).toEqual(['overdue:2026-07-15']);
  });

  it('does not send before the chosen hour, or after the catch-up window closes', async () => {
    vi.setSystemTime(new Date('2026-07-15T12:30:00Z'));
    await seedOverdue();
    await setPrefs({ overdueDigestEnabled: true, overdueDigestHour: 8 });

    await tickAt('2026-07-15T12:30:00Z'); // 07:30 CDT, too early
    await tickAt('2026-07-15T16:00:00Z'); // 11:00 CDT, window closed
    expect(sentEmails).toHaveLength(0);
  });

  it('does not wrap past midnight into the next day’s cycle', async () => {
    // A 23:00 digest caught up at 00:30 would be filed under the NEXT day,
    // and that day's own 23:00 send would make two.
    vi.setSystemTime(new Date('2026-07-16T05:30:00Z'));
    await seedOverdue();
    await setPrefs({ overdueDigestEnabled: true, overdueDigestHour: 23 });

    await tickAt('2026-07-16T05:30:00Z'); // 00:30 CDT Jul 16
    expect(sentEmails).toHaveLength(0);
  });
});
