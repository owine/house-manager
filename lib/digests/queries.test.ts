import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type IntegrationContext,
  setupIntegration,
  teardownIntegration,
} from './../../tests/integration/helpers';
import type { DigestItem } from './queries';

let ctx: IntegrationContext;
let userId: string;
let categoryId: string;
let itemId: string;
let getOverdueForUser: (userId: string, tz: string) => Promise<DigestItem[]>;
let getWeeklyForUser: (userId: string, tz: string) => Promise<DigestItem[]>;

beforeAll(async () => {
  ctx = await setupIntegration();
  // Dynamic import to avoid the module-load DATABASE_URL trap.
  const mod = await import('./queries');
  getOverdueForUser = mod.getOverdueForUser;
  getWeeklyForUser = mod.getWeeklyForUser;

  const user = await ctx.prisma.user.create({
    data: { email: 'digest-test@example.test', name: 'Digest Test' },
  });
  userId = user.id;
  const cat = await ctx.prisma.category.create({
    data: { slug: 'digest-test-cat', name: 'DigestTestCat', sortOrder: 999 },
  });
  categoryId = cat.id;
  const item = await ctx.prisma.item.create({
    data: { name: 'TestItem', categoryId },
  });
  itemId = item.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.reminder.deleteMany({});
});

describe('getOverdueForUser', () => {
  it('returns items where nextDueOn < startOfToday in the user tz', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await ctx.prisma.reminder.create({
      data: {
        title: 'Overdue thing',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: yesterday }] },
      },
    });
    const rows = await getOverdueForUser(userId, 'America/New_York');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Overdue thing');
    expect(rows[0]?.daysOverdue).toBeGreaterThan(0);
    expect(rows[0]?.targets).toHaveLength(1);
    expect(rows[0]?.targets[0]).toMatchObject({ kind: 'item', id: itemId, name: 'TestItem' });
  });

  it('excludes inactive reminders', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await ctx.prisma.reminder.create({
      data: {
        title: 'Inactive overdue',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: false,
        targets: { create: [{ itemId, nextDueOn: yesterday }] },
      },
    });
    expect(await getOverdueForUser(userId, 'America/New_York')).toHaveLength(0);
  });

  it('excludes reminders that do not list the user in notifyUserIds', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await ctx.prisma.reminder.create({
      data: {
        title: 'Not for me',
        recurrence: { kind: 'NONE' },
        notifyUserIds: ['someone-else'],
        active: true,
        targets: { create: [{ itemId, nextDueOn: yesterday }] },
      },
    });
    expect(await getOverdueForUser(userId, 'America/New_York')).toHaveLength(0);
  });

  it('sorts most-overdue first', async () => {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await ctx.prisma.reminder.create({
      data: {
        title: 'Recent overdue',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: dayAgo }] },
      },
    });
    await ctx.prisma.reminder.create({
      data: {
        title: 'Ancient overdue',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: weekAgo }] },
      },
    });
    const rows = await getOverdueForUser(userId, 'America/New_York');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.title).toBe('Ancient overdue');
    expect(rows[1]?.title).toBe('Recent overdue');
  });

  it('returns empty array when nothing is overdue', async () => {
    expect(await getOverdueForUser(userId, 'America/New_York')).toEqual([]);
  });
});

describe('getWeeklyForUser', () => {
  it('returns items due within now..now+7d', async () => {
    const inThreeDays = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await ctx.prisma.reminder.create({
      data: {
        title: 'Coming up',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: inThreeDays }] },
      },
    });
    const rows = await getWeeklyForUser(userId, 'America/New_York');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Coming up');
    expect(rows[0]?.daysOverdue).toBe(0);
  });

  it('excludes items more than 7 days out', async () => {
    const inTenDays = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    await ctx.prisma.reminder.create({
      data: {
        title: 'Way later',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: inTenDays }] },
      },
    });
    expect(await getWeeklyForUser(userId, 'America/New_York')).toHaveLength(0);
  });

  it('sorts due date ascending', async () => {
    const inOneDay = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000);
    const inFiveDays = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    await ctx.prisma.reminder.create({
      data: {
        title: 'Friday thing',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: inFiveDays }] },
      },
    });
    await ctx.prisma.reminder.create({
      data: {
        title: 'Tomorrow thing',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: inOneDay }] },
      },
    });
    const rows = await getWeeklyForUser(userId, 'America/New_York');
    expect(rows.map((r) => r.title)).toEqual(['Tomorrow thing', 'Friday thing']);
  });

  it('returns empty array when nothing is due this week', async () => {
    expect(await getWeeklyForUser(userId, 'America/New_York')).toEqual([]);
  });
});
