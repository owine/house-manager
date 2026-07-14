import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type IntegrationContext,
  setupIntegration,
  teardownIntegration,
  todayCal,
} from './helpers';

let queries: typeof import('@/lib/reminders/queries');

let ctx: IntegrationContext;
let categoryId: string;
let itemId: string;
let userId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  queries = await import('@/lib/reminders/queries');
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'hvac' },
    create: { slug: 'hvac', name: 'HVAC', sortOrder: 20 },
    update: {},
  });
  categoryId = cat.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.reminderCompletion.deleteMany();
  await ctx.prisma.notificationLog.deleteMany();
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.attachment.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({
    data: { id: 'test-user', email: 'test@example.com', name: 'Test User' },
  });
  userId = 'test-user';
  const item = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId } });
  itemId = item.id;
});

describe('Reminder CRUD', () => {
  it('creates a reminder with interval recurrence + one item target', async () => {
    const r = await ctx.prisma.reminder.create({
      data: {
        title: 'Replace HVAC filter',
        recurrence: { kind: 'interval', days: 60 },
        notifyUserIds: [userId],
        targets: { create: [{ itemId, nextDueOn: new Date('2026-06-30') }] },
      },
      include: { targets: true },
    });
    expect(r.title).toBe('Replace HVAC filter');
    expect(r.notifyUserIds).toEqual([userId]);
    expect(r.targets).toHaveLength(1);
    expect(r.targets[0].itemId).toBe(itemId);
  });

  it('cascade-deletes completions and targets when reminder is deleted', async () => {
    const r = await ctx.prisma.reminder.create({
      data: {
        title: 'X',
        recurrence: { kind: 'interval', days: 30 },
        notifyUserIds: [userId],
        targets: { create: [{ itemId, nextDueOn: todayCal() }] },
      },
      include: { targets: true },
    });
    const c = await ctx.prisma.reminderCompletion.create({
      data: {
        reminderId: r.id,
        targetId: r.targets[0].id,
        completedById: userId,
        completedOn: new Date(),
      },
    });
    await ctx.prisma.reminder.delete({ where: { id: r.id } });
    const orphan = await ctx.prisma.reminderCompletion.findUnique({ where: { id: c.id } });
    expect(orphan).toBeNull();
    const orphanTarget = await ctx.prisma.reminderTarget.findUnique({
      where: { id: r.targets[0].id },
    });
    expect(orphanTarget).toBeNull();
  });

  it('cascade-deletes target rows when parent Item is hard-deleted', async () => {
    const r = await ctx.prisma.reminder.create({
      data: {
        title: 'X',
        recurrence: { kind: 'interval', days: 30 },
        notifyUserIds: [userId],
        targets: { create: [{ itemId, nextDueOn: todayCal() }] },
      },
      include: { targets: true },
    });
    await ctx.prisma.item.delete({ where: { id: itemId } });
    const r2 = await ctx.prisma.reminder.findUnique({
      where: { id: r.id },
      include: { targets: true },
    });
    // Reminder row remains; its item-targeting target row was cascaded out.
    expect(r2).not.toBeNull();
    expect(r2?.targets).toHaveLength(0);
  });
});

describe('ReminderCompletion + ServiceRecord linkage', () => {
  it('creates a completion linked to a service record', async () => {
    const r = await ctx.prisma.reminder.create({
      data: {
        title: 'X',
        recurrence: { kind: 'interval', days: 30 },
        notifyUserIds: [userId],
        autoCreateServiceRecord: true,
        targets: { create: [{ itemId, nextDueOn: todayCal() }] },
      },
      include: { targets: true },
    });
    const sr = await ctx.prisma.serviceRecord.create({
      data: {
        performedOn: todayCal(),
        summary: 'filter replaced',
        targets: { create: [{ itemId }] },
      },
    });
    const c = await ctx.prisma.reminderCompletion.create({
      data: {
        reminderId: r.id,
        targetId: r.targets[0].id,
        completedById: userId,
        completedOn: new Date(),
        createdServiceRecordId: sr.id,
      },
    });
    const reread = await ctx.prisma.reminderCompletion.findUnique({
      where: { id: c.id },
      include: { createdServiceRecord: true },
    });
    expect(reread?.createdServiceRecord?.summary).toBe('filter replaced');
  });

  it('SetNulls createdServiceRecordId when ServiceRecord is hard-deleted', async () => {
    const r = await ctx.prisma.reminder.create({
      data: {
        title: 'X',
        recurrence: { kind: 'interval', days: 30 },
        notifyUserIds: [userId],
        targets: { create: [{ itemId, nextDueOn: todayCal() }] },
      },
      include: { targets: true },
    });
    const sr = await ctx.prisma.serviceRecord.create({
      data: {
        performedOn: todayCal(),
        summary: 'X',
        targets: { create: [{ itemId }] },
      },
    });
    const c = await ctx.prisma.reminderCompletion.create({
      data: {
        reminderId: r.id,
        targetId: r.targets[0].id,
        completedById: userId,
        completedOn: new Date(),
        createdServiceRecordId: sr.id,
      },
    });
    await ctx.prisma.serviceRecord.delete({ where: { id: sr.id } });
    const reread = await ctx.prisma.reminderCompletion.findUnique({ where: { id: c.id } });
    expect(reread?.createdServiceRecordId).toBeNull();
  });
});

describe('listReminders ordering', () => {
  it('orders by earliest target nextDueOn across all targets, ascending', async () => {
    const itemB = await ctx.prisma.item.create({ data: { name: 'B', categoryId } });
    const itemC = await ctx.prisma.item.create({ data: { name: 'C', categoryId } });

    // Created in reverse-due order to prove we sort by due-date, not createdAt.
    // "Late" reminder: only target due 2027-12-01.
    await ctx.prisma.reminder.create({
      data: {
        title: 'Late',
        recurrence: { kind: 'interval', days: 365 },
        notifyUserIds: [userId],
        targets: { create: [{ itemId, nextDueOn: new Date('2027-12-01') }] },
      },
    });

    // "Middle" reminder: two targets — earliest is 2027-03-01.
    await ctx.prisma.reminder.create({
      data: {
        title: 'Middle',
        recurrence: { kind: 'interval', days: 90 },
        notifyUserIds: [userId],
        targets: {
          create: [
            { itemId, nextDueOn: new Date('2027-09-01') },
            { itemId: itemB.id, nextDueOn: new Date('2027-03-01') },
          ],
        },
      },
    });

    // "Early" reminder: single target due 2026-06-01 — should come first.
    await ctx.prisma.reminder.create({
      data: {
        title: 'Early',
        recurrence: { kind: 'interval', days: 30 },
        notifyUserIds: [userId],
        targets: { create: [{ itemId: itemC.id, nextDueOn: new Date('2026-06-01') }] },
      },
    });

    const { reminders } = await queries.listReminders({
      page: 1,
      pageSize: 20,
      filters: {},
    });
    expect(reminders.map((r) => r.title)).toEqual(['Early', 'Middle', 'Late']);
  });
});
