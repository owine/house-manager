import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;
let categoryId: string;
let itemId: string;
let userId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
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
  it('creates a reminder with interval recurrence', async () => {
    const r = await ctx.prisma.reminder.create({
      data: {
        title: 'Replace HVAC filter',
        recurrence: { kind: 'interval', days: 60 },
        nextDueOn: new Date('2026-06-30'),
        notifyUserIds: [userId],
        itemId,
      },
    });
    expect(r.title).toBe('Replace HVAC filter');
    expect(r.notifyUserIds).toEqual([userId]);
  });

  it('cascade-deletes completions when reminder is deleted', async () => {
    const r = await ctx.prisma.reminder.create({
      data: {
        title: 'X',
        recurrence: { kind: 'interval', days: 30 },
        nextDueOn: new Date(),
        notifyUserIds: [userId],
      },
    });
    const c = await ctx.prisma.reminderCompletion.create({
      data: { reminderId: r.id, completedById: userId, completedOn: new Date() },
    });
    await ctx.prisma.reminder.delete({ where: { id: r.id } });
    const orphan = await ctx.prisma.reminderCompletion.findUnique({ where: { id: c.id } });
    expect(orphan).toBeNull();
  });

  it('SetNulls itemId when parent Item is hard-deleted', async () => {
    const r = await ctx.prisma.reminder.create({
      data: {
        title: 'X',
        recurrence: { kind: 'interval', days: 30 },
        nextDueOn: new Date(),
        notifyUserIds: [userId],
        itemId,
      },
    });
    await ctx.prisma.item.delete({ where: { id: itemId } });
    const r2 = await ctx.prisma.reminder.findUnique({ where: { id: r.id } });
    expect(r2?.itemId).toBeNull();
  });
});

describe('ReminderCompletion + ServiceRecord linkage', () => {
  it('creates a completion linked to a service record', async () => {
    const r = await ctx.prisma.reminder.create({
      data: {
        title: 'X',
        recurrence: { kind: 'interval', days: 30 },
        nextDueOn: new Date(),
        notifyUserIds: [userId],
        autoCreateServiceRecord: true,
        itemId,
      },
    });
    const sr = await ctx.prisma.serviceRecord.create({
      data: {
        performedOn: new Date(),
        summary: 'filter replaced',
        targets: { create: [{ itemId }] },
      },
    });
    const c = await ctx.prisma.reminderCompletion.create({
      data: {
        reminderId: r.id,
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
        nextDueOn: new Date(),
        notifyUserIds: [userId],
      },
    });
    const sr = await ctx.prisma.serviceRecord.create({
      data: {
        performedOn: new Date(),
        summary: 'X',
        targets: { create: [{ itemId }] },
      },
    });
    const c = await ctx.prisma.reminderCompletion.create({
      data: {
        reminderId: r.id,
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
