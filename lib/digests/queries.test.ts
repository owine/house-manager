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
let getOverdueForUser: (userId: string, tz: string, now?: Date) => Promise<DigestItem[]>;
let getWeeklyForUser: (userId: string, tz: string, now?: Date) => Promise<DigestItem[]>;

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

// `nextDueOn` is a calendar date stored at UTC midnight (see computeNextDueOn),
// and `getOverdueForUser` cuts at startOfDayUtc(now, tz). Seeding a wall-clock
// instant (`Date.now() - 24h`) instead mixed the two conventions: in a negative-
// offset zone the cutoff rolls back to the previous UTC date whenever the UTC
// hour is 00:00-03:59, so "24h ago" was no longer strictly before it and the row
// vanished. That made these tests fail on any CI run in that window. Seed UTC
// midnight and pin `now`, so the assertions depend only on the fixtures.
const TZ = 'America/New_York';
const NOW = new Date('2026-07-14T15:00:00Z'); // 11:00 EDT on Jul 14
const cal = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const YESTERDAY = cal(2026, 7, 13);
const WEEK_AGO = cal(2026, 7, 7);

describe('getOverdueForUser', () => {
  it('returns items where nextDueOn < startOfToday in the user tz', async () => {
    await ctx.prisma.reminder.create({
      data: {
        title: 'Overdue thing',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: YESTERDAY }] },
      },
    });
    const rows = await getOverdueForUser(userId, TZ, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Overdue thing');
    expect(rows[0]?.daysOverdue).toBeGreaterThan(0);
    expect(rows[0]?.targets).toHaveLength(1);
    expect(rows[0]?.targets[0]).toMatchObject({ kind: 'item', id: itemId, name: 'TestItem' });
  });

  it('excludes inactive reminders', async () => {
    await ctx.prisma.reminder.create({
      data: {
        title: 'Inactive overdue',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: false,
        targets: { create: [{ itemId, nextDueOn: YESTERDAY }] },
      },
    });
    expect(await getOverdueForUser(userId, TZ, NOW)).toHaveLength(0);
  });

  it('excludes reminders that do not list the user in notifyUserIds', async () => {
    await ctx.prisma.reminder.create({
      data: {
        title: 'Not for me',
        recurrence: { kind: 'NONE' },
        notifyUserIds: ['someone-else'],
        active: true,
        targets: { create: [{ itemId, nextDueOn: YESTERDAY }] },
      },
    });
    expect(await getOverdueForUser(userId, TZ, NOW)).toHaveLength(0);
  });

  it('sorts most-overdue first', async () => {
    await ctx.prisma.reminder.create({
      data: {
        title: 'Recent overdue',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: YESTERDAY }] },
      },
    });
    await ctx.prisma.reminder.create({
      data: {
        title: 'Ancient overdue',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: WEEK_AGO }] },
      },
    });
    const rows = await getOverdueForUser(userId, TZ, NOW);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.title).toBe('Ancient overdue');
    expect(rows[1]?.title).toBe('Recent overdue');
  });

  it('returns empty array when nothing is overdue', async () => {
    expect(await getOverdueForUser(userId, TZ, NOW)).toEqual([]);
  });

  it('flips to overdue at house-local midnight, not UTC midnight', async () => {
    // The boundary the wall-clock-seed bomb hid. A reminder due Jul 13 is *due
    // today* while it is still Jul 13 in New York -- which is true right through
    // 03:59 UTC on Jul 14 (20:00-23:59 EDT on the 13th). It becomes overdue only
    // once NY rolls over to Jul 14, at 04:00 UTC. Overdue-ness must track the
    // house day, never the UTC day.
    await ctx.prisma.reminder.create({
      data: {
        title: 'Due Jul 13',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: YESTERDAY }] },
      },
    });
    const titlesAt = async (iso: string) =>
      (await getOverdueForUser(userId, TZ, new Date(iso))).map((r) => r.title);

    // Still Jul 13 in NY -> due today, not overdue.
    expect(await titlesAt('2026-07-13T16:00:00Z')).toEqual([]); // 12:00 EDT Jul 13
    expect(await titlesAt('2026-07-14T03:59:59Z')).toEqual([]); // 23:59 EDT Jul 13
    // NY has rolled over to Jul 14 -> overdue.
    expect(await titlesAt('2026-07-14T04:00:00Z')).toEqual(['Due Jul 13']); // 00:00 EDT Jul 14
    expect(await titlesAt('2026-07-14T15:00:00Z')).toEqual(['Due Jul 13']); // 11:00 EDT Jul 14
  });

  it('treats a chore due today (UTC-midnight) as NOT overdue, but yesterday as overdue', async () => {
    // Calendar-date convention: nextDueOn is stored at UTC midnight (Date.UTC,
    // no offset) the way computeNextDueOn produces it. "Overdue" means the
    // calendar date is strictly before today in the house tz.
    //
    // Fix "now" at 2026-07-01T16:00:00Z = 11:00 CDT on 2026-07-01 in America/Chicago,
    // so today-in-house = Jul-1 and the cutoff is UTC-midnight Jul-1.
    const now = new Date('2026-07-01T16:00:00Z');
    const tz = 'America/Chicago';

    // Due today (UTC midnight Jul-1). Under the old (buggy) tz-local-midnight
    // cutoff this was wrongly flagged overdue in a negative-offset zone.
    await ctx.prisma.reminder.create({
      data: {
        title: 'Due today',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: new Date(Date.UTC(2026, 6, 1)) }] },
      },
    });
    // Due yesterday (UTC midnight Jun-30) → strictly before today → OVERDUE.
    await ctx.prisma.reminder.create({
      data: {
        title: 'Due yesterday',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: new Date(Date.UTC(2026, 5, 30)) }] },
      },
    });

    const rows = await getOverdueForUser(userId, tz, now);
    expect(rows.map((r) => r.title)).toEqual(['Due yesterday']);
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
