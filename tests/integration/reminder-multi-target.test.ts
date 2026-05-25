import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;
let categoryId: string;
let itemId: string;
let systemId: string;

beforeAll(async () => {
  ctx = await setupIntegration();

  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'multi-target-reminder' },
    create: { slug: 'multi-target-reminder', name: 'HVAC', sortOrder: 20 },
    update: {},
  });
  categoryId = cat.id;

  const sys = await ctx.prisma.system.create({
    data: { name: 'HVAC system' },
  });
  systemId = sys.id;

  const item = await ctx.prisma.item.create({
    data: { name: 'Furnace', categoryId, systemId },
  });
  itemId = item.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.reminderCompletion.deleteMany();
  await ctx.prisma.reminder.deleteMany();
});

describe('ReminderTarget multi-target', () => {
  it('creates a reminder with two targets (one item, one system) — both share the initial nextDueOn', async () => {
    const dueOn = new Date('2026-08-01T00:00:00Z');
    const r = await ctx.prisma.reminder.create({
      data: {
        title: 'Replace HVAC filter',
        recurrence: { kind: 'interval', days: 60 },
        notifyUserIds: [],
        targets: {
          create: [
            { itemId, nextDueOn: dueOn },
            { systemId, nextDueOn: dueOn },
          ],
        },
      },
      include: { targets: true },
    });

    expect(r.targets).toHaveLength(2);
    const targetItemIds = r.targets.map((t) => t.itemId).filter(Boolean);
    const targetSystemIds = r.targets.map((t) => t.systemId).filter(Boolean);
    expect(targetItemIds).toEqual([itemId]);
    expect(targetSystemIds).toEqual([systemId]);
    for (const t of r.targets) {
      expect(t.nextDueOn.toISOString()).toBe(dueOn.toISOString());
      expect(t.lastCompletedOn).toBeNull();
    }
  });

  it('rejects a target row with both itemId and systemId set (XOR CHECK)', async () => {
    const r = await ctx.prisma.reminder.create({
      data: {
        title: 'XOR violation parent',
        recurrence: { kind: 'interval', days: 60 },
        notifyUserIds: [],
      },
    });
    await expect(
      ctx.prisma.$executeRaw`
        INSERT INTO reminder_targets (id, "reminderId", "itemId", "systemId", "nextDueOn")
        VALUES ('rt_xor_both', ${r.id}, ${itemId}, ${systemId}, NOW())
      `,
    ).rejects.toThrow();
  });

  it('allows a target row with neither itemId nor systemId set (chore standalone row)', async () => {
    // The relaxed `reminder_targets_parent_at_most_one` constraint permits
    // both-NULL rows so chores can carry their schedule + completion
    // history without a linked item/system. The "only CHORE parents may
    // own a both-NULL row" rule is enforced in the server reconciliation,
    // not at the DB level.
    const r = await ctx.prisma.reminder.create({
      data: {
        title: 'Standalone-allowed parent',
        kind: 'CHORE',
        recurrence: { kind: 'interval', days: 60 },
        notifyUserIds: [],
      },
    });
    await expect(
      ctx.prisma.$executeRaw`
        INSERT INTO reminder_targets (id, "reminderId", "itemId", "systemId", "nextDueOn")
        VALUES ('rt_standalone_ok', ${r.id}, NULL, NULL, NOW())
      `,
    ).resolves.toBe(1);
  });

  it('rejects duplicate (reminderId, itemId, systemId) (unique constraint)', async () => {
    const r = await ctx.prisma.reminder.create({
      data: {
        title: 'Duplicate target parent',
        recurrence: { kind: 'interval', days: 60 },
        notifyUserIds: [],
        targets: { create: [{ itemId, nextDueOn: new Date() }] },
      },
    });
    await expect(
      ctx.prisma.reminderTarget.create({
        data: { reminderId: r.id, itemId, nextDueOn: new Date() },
      }),
    ).rejects.toThrow();
  });
});
