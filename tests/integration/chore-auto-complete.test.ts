import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_AUTO_COMPLETE_USER_ID } from '@/lib/reminders/system-user';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

// Stub enqueueSearchIndex so tests don't need a live queue
vi.mock('@/lib/search/client', () => ({
  enqueueSearchIndex: vi.fn(async () => {}),
}));

let ctx: IntegrationContext;
let handleChoreAutoCompleteTick: (now?: Date) => Promise<void>;
let categoryId: string;
let itemId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  const mod = await import('@/worker/jobs/chore-auto-complete-tick');
  handleChoreAutoCompleteTick = mod.handleChoreAutoCompleteTick;
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'chore-auto-complete-test' },
    create: { slug: 'chore-auto-complete-test', name: 'Chore AC', sortOrder: 998 },
    update: {},
  });
  categoryId = cat.id;
  const item = await ctx.prisma.item.create({ data: { name: 'Boiler', categoryId } });
  itemId = item.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.reminderCompletion.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  // Seed test user + the sentinel user required by the completedBy FK
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@example.com', name: 'U1' } });
  await ctx.prisma.user.create({
    data: {
      id: SYSTEM_AUTO_COMPLETE_USER_ID,
      email: 'system+auto-complete@house-manager.local',
      name: 'System (Auto-complete)',
    },
  });
  // Set the house timezone so wall-clock logic is deterministic
  await ctx.prisma.houseProfile.deleteMany();
  await ctx.prisma.houseProfile.create({ data: { timezone: 'America/New_York' } });
});

// Fixed "now" reference: 2026-05-27 10:00 UTC = 06:00 New_York (no DST ambiguity)
const NOW = new Date('2026-05-27T10:00:00.000Z');
// "Two days ago" in UTC — safely before today in America/New_York too
const TWO_DAYS_AGO = new Date('2026-05-25T00:00:00.000Z');
// "Yesterday" in UTC
const YESTERDAY = new Date('2026-05-26T00:00:00.000Z');
// 2026-05-27 midnight America/New_York (EDT = UTC-4) → 2026-05-27T04:00:00Z
// startOfDayInTz(NOW, 'America/New_York') returns this value, so nextDueOn === startToday
// means the target is NOT strictly before today → should be skipped.
const TODAY_NY_MIDNIGHT = new Date('2026-05-27T04:00:00.000Z');

describe('handleChoreAutoCompleteTick', () => {
  it('auto-closes an overdue CHORE with autoComplete=true', async () => {
    const reminder = await ctx.prisma.reminder.create({
      data: {
        title: 'Monthly filter change',
        kind: 'CHORE',
        autoComplete: true,
        active: true,
        recurrence: { kind: 'interval', every: 1, unit: 'month' },
        notifyUserIds: ['u1'],
        targets: { create: [{ itemId, nextDueOn: TWO_DAYS_AGO }] },
      },
      include: { targets: true },
    });
    const target = reminder.targets[0];

    await handleChoreAutoCompleteTick(NOW);

    const completions = await ctx.prisma.reminderCompletion.findMany({
      where: { reminderId: reminder.id },
    });
    expect(completions).toHaveLength(1);
    expect(completions[0].completedById).toBe(SYSTEM_AUTO_COMPLETE_USER_ID);
    expect(completions[0].notes).toBe('Auto-completed');
    // completedOn should be end-of-due-day in NY tz, not far future
    expect(completions[0].completedOn.getTime()).toBeLessThan(NOW.getTime());

    const updatedTarget = await ctx.prisma.reminderTarget.findUniqueOrThrow({
      where: { id: target.id },
    });
    // nextDueOn advanced beyond the original
    expect(updatedTarget.nextDueOn.getTime()).toBeGreaterThan(TWO_DAYS_AGO.getTime());
    // lastCompletedOn set to completedOn
    expect(updatedTarget.lastCompletedOn?.getTime()).toBe(completions[0].completedOn.getTime());
  });

  it('skips a chore whose nextDueOn is today in the house tz', async () => {
    await ctx.prisma.reminder.create({
      data: {
        title: 'Water plants',
        kind: 'CHORE',
        autoComplete: true,
        active: true,
        recurrence: { kind: 'interval', every: 7, unit: 'day' },
        notifyUserIds: ['u1'],
        // midnight America/New_York on 2026-05-27 = 04:00 UTC — "today" in NY
        targets: { create: [{ itemId, nextDueOn: TODAY_NY_MIDNIGHT }] },
      },
    });

    await handleChoreAutoCompleteTick(NOW);

    const count = await ctx.prisma.reminderCompletion.count();
    expect(count).toBe(0);
  });

  it('skips a chore with autoComplete=false even when overdue', async () => {
    await ctx.prisma.reminder.create({
      data: {
        title: 'Overdue but manual',
        kind: 'CHORE',
        autoComplete: false,
        active: true,
        recurrence: { kind: 'interval', every: 1, unit: 'week' },
        notifyUserIds: ['u1'],
        targets: { create: [{ itemId, nextDueOn: TWO_DAYS_AGO }] },
      },
    });

    await handleChoreAutoCompleteTick(NOW);

    const count = await ctx.prisma.reminderCompletion.count();
    expect(count).toBe(0);
  });

  it('skips kind=REMINDER even when autoComplete=true (bypassing schema)', async () => {
    // Directly insert a REMINDER with autoComplete=true to test the DB filter
    await ctx.prisma.reminder.create({
      data: {
        title: 'HVAC service',
        kind: 'REMINDER',
        autoComplete: true, // schema would coerce to false normally
        active: true,
        recurrence: { kind: 'interval', every: 6, unit: 'month' },
        notifyUserIds: ['u1'],
        targets: { create: [{ itemId, nextDueOn: TWO_DAYS_AGO }] },
      },
    });

    await handleChoreAutoCompleteTick(NOW);

    const count = await ctx.prisma.reminderCompletion.count();
    expect(count).toBe(0);
  });

  it('is idempotent: running the tick twice only creates one completion per target', async () => {
    await ctx.prisma.reminder.create({
      data: {
        title: 'Weekly trash',
        kind: 'CHORE',
        autoComplete: true,
        active: true,
        recurrence: { kind: 'interval', every: 7, unit: 'day' },
        notifyUserIds: ['u1'],
        targets: { create: [{ itemId, nextDueOn: YESTERDAY }] },
      },
    });

    await handleChoreAutoCompleteTick(NOW);
    await handleChoreAutoCompleteTick(NOW);

    const count = await ctx.prisma.reminderCompletion.count();
    expect(count).toBe(1);
  });

  it('does not create a ServiceRecord even when autoCreateServiceRecord=true', async () => {
    const reminder = await ctx.prisma.reminder.create({
      data: {
        title: 'Filter change with SR flag',
        kind: 'CHORE',
        autoComplete: true,
        autoCreateServiceRecord: true,
        active: true,
        recurrence: { kind: 'interval', every: 1, unit: 'month' },
        notifyUserIds: ['u1'],
        targets: { create: [{ itemId, nextDueOn: TWO_DAYS_AGO }] },
      },
    });

    await handleChoreAutoCompleteTick(NOW);

    const completions = await ctx.prisma.reminderCompletion.findMany({
      where: { reminderId: reminder.id },
    });
    expect(completions).toHaveLength(1);
    expect(completions[0].createdServiceRecordId).toBeNull();

    const srCount = await ctx.prisma.serviceRecord.count();
    expect(srCount).toBe(0);
  });

  it('falls back to UTC when no HouseProfile row exists (bootstrap case)', async () => {
    // Remove the NY profile set in beforeEach to exercise the `?? 'UTC'` fallback.
    await ctx.prisma.houseProfile.deleteMany();

    const reminder = await ctx.prisma.reminder.create({
      data: {
        title: 'UTC bootstrap chore',
        kind: 'CHORE',
        autoComplete: true,
        active: true,
        recurrence: { kind: 'interval', every: 1, unit: 'day' },
        notifyUserIds: ['u1'],
        // YESTERDAY (2026-05-26T00:00:00Z) is strictly before TODAY_UTC_MIDNIGHT
        // (2026-05-27T00:00:00Z). In NY tz YESTERDAY equals today's start
        // (00:00 EDT on the 26th maps to 04:00Z on 26th, still < 04:00Z on 27th),
        // so this test confirms the worker actually used UTC, not NY.
        targets: { create: [{ itemId, nextDueOn: YESTERDAY }] },
      },
      include: { targets: true },
    });
    const target = reminder.targets[0];

    await handleChoreAutoCompleteTick(NOW);

    const completions = await ctx.prisma.reminderCompletion.findMany({
      where: { reminderId: reminder.id },
    });
    expect(completions).toHaveLength(1);
    expect(completions[0].completedById).toBe(SYSTEM_AUTO_COMPLETE_USER_ID);
    // completedOn = endOfDayInTz(YESTERDAY, 'UTC') = 2026-05-26T23:59:59.999Z
    expect(completions[0].completedOn.toISOString()).toBe('2026-05-26T23:59:59.999Z');

    const updatedTarget = await ctx.prisma.reminderTarget.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(updatedTarget.nextDueOn.getTime()).toBeGreaterThan(YESTERDAY.getTime());
  });
});
