import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calDaysOut,
  type IntegrationContext,
  setupIntegration,
  teardownIntegration,
  todayCal,
} from './helpers';

let currentUserId: string | null = null;

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => (currentUserId ? { user: { id: currentUserId } } : null)),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/search/client', () => ({ enqueueSearchIndex: vi.fn(async () => {}) }));
vi.mock('@/lib/embedding/enqueue', () => ({ enqueueEmbed: vi.fn(async () => {}) }));

let ctx: IntegrationContext;
let actions: typeof import('@/lib/systems/actions');

beforeAll(async () => {
  ctx = await setupIntegration();
  // Dynamic import AFTER setupIntegration: lib/db builds its Prisma singleton
  // at import time from process.env.DATABASE_URL.
  actions = await import('@/lib/systems/actions');
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.warranty.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.partLink.deleteMany();
  await ctx.prisma.part.deleteMany();
  await ctx.prisma.system.deleteMany();
  await ctx.prisma.vendor.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@example.com', name: 'U1' } });
  currentUserId = 'u1';
});

const RECURRENCE = { kind: 'interval', every: 30, unit: 'day' };

async function makeSystem(name: string) {
  return ctx.prisma.system.create({ data: { name } });
}

async function makeReminder(
  kind: 'REMINDER' | 'CHORE',
  title: string,
  systemIds: string[],
  nextDueOn = todayCal(),
) {
  return ctx.prisma.reminder.create({
    data: {
      title,
      kind,
      recurrence: RECURRENCE,
      targets: { create: systemIds.map((systemId) => ({ systemId, nextDueOn })) },
    },
  });
}

async function makeWarranty(provider: string, systemIds: string[]) {
  return ctx.prisma.warranty.create({
    data: {
      provider,
      startsOn: todayCal(),
      endsOn: calDaysOut(365),
      targets: { create: systemIds.map((systemId) => ({ systemId })) },
    },
  });
}

async function makeServiceRecord(
  summary: string,
  systemIds: string[],
  anchor: { vendorId?: string; selfPerformed?: boolean } = {},
) {
  return ctx.prisma.serviceRecord.create({
    data: {
      summary,
      performedOn: todayCal(),
      ...anchor,
      targets: { create: systemIds.map((systemId) => ({ systemId })) },
    },
  });
}

describe('tryDeleteSystem refuses to orphan records', () => {
  it('lists a REMINDER whose only target is the system, and deletes nothing', async () => {
    const system = await makeSystem('Water heater');
    const reminder = await makeReminder('REMINDER', 'Flush water heater', [system.id]);

    const result = await actions.tryDeleteSystem(system.id);

    expect(result).toEqual({
      ok: false,
      hasDependents: true,
      dependents: [{ kind: 'reminder', id: reminder.id, label: 'Flush water heater' }],
    });
    expect(await ctx.prisma.system.findUnique({ where: { id: system.id } })).not.toBeNull();
    expect(await ctx.prisma.reminderTarget.count({ where: { reminderId: reminder.id } })).toBe(1);
  });

  it('lists a warranty and an unanchored service record, reminders first', async () => {
    const system = await makeSystem('Water heater');
    const warranty = await makeWarranty('Rheem limited warranty', [system.id]);
    const sr = await makeServiceRecord('Anode rod swap', [system.id]);
    const reminder = await makeReminder('REMINDER', 'Flush water heater', [system.id]);

    const result = await actions.tryDeleteSystem(system.id);

    if (result.ok || !('hasDependents' in result)) throw new Error('expected the dependents list');
    expect(result.dependents).toEqual([
      { kind: 'reminder', id: reminder.id, label: 'Flush water heater' },
      { kind: 'warranty', id: warranty.id, label: 'Rheem limited warranty' },
      { kind: 'serviceRecord', id: sr.id, label: 'Anode rod swap' },
    ]);
  });

  it('lets a service record with a vendor or self-performed marker become vendor-only/self-only', async () => {
    const system = await makeSystem('Water heater');
    const vendor = await ctx.prisma.vendor.create({ data: { name: 'Acme Plumbing' } });
    const withVendor = await makeServiceRecord('Annual service', [system.id], {
      vendorId: vendor.id,
    });
    const selfDone = await makeServiceRecord('Drained tank', [system.id], { selfPerformed: true });

    const result = await actions.tryDeleteSystem(system.id);

    expect(result).toEqual({ ok: true });
    for (const id of [withVendor.id, selfDone.id]) {
      expect(await ctx.prisma.serviceRecord.findUnique({ where: { id } })).not.toBeNull();
      expect(await ctx.prisma.serviceRecordTarget.count({ where: { serviceRecordId: id } })).toBe(
        0,
      );
    }
  });

  it('allows the delete when every record keeps another target', async () => {
    const system = await makeSystem('Water heater');
    const other = await makeSystem('Boiler');
    const reminder = await makeReminder('REMINDER', 'Check pressure', [system.id, other.id]);
    const warranty = await makeWarranty('Home warranty', [system.id, other.id]);

    const result = await actions.tryDeleteSystem(system.id);

    expect(result).toEqual({ ok: true });
    const rTargets = await ctx.prisma.reminderTarget.findMany({
      where: { reminderId: reminder.id },
    });
    expect(rTargets.map((t) => t.systemId)).toEqual([other.id]);
    const wTargets = await ctx.prisma.warrantyTarget.findMany({
      where: { warrantyId: warranty.id },
    });
    expect(wTargets.map((t) => t.systemId)).toEqual([other.id]);
  });

  // A cascade would delete the chore's only target row — and with it the
  // cadence and (ReminderCompletion.target is Cascade) the completion history.
  it('turns a sole-target CHORE into a standalone chore in place, keeping cadence and history', async () => {
    const system = await makeSystem('Water heater');
    const chore = await makeReminder('CHORE', 'Flush water heater', [system.id], calDaysOut(5));
    const target = await ctx.prisma.reminderTarget.findFirstOrThrow({
      where: { reminderId: chore.id },
    });
    const completedAt = new Date('2026-06-01T15:00:00Z');
    await ctx.prisma.reminderTarget.update({
      where: { id: target.id },
      data: { lastCompletedOn: completedAt },
    });
    await ctx.prisma.reminderCompletion.create({
      data: {
        reminderId: chore.id,
        targetId: target.id,
        completedById: 'u1',
        completedOn: completedAt,
      },
    });

    const result = await actions.tryDeleteSystem(system.id);

    expect(result).toEqual({ ok: true });
    const after = await ctx.prisma.reminderTarget.findMany({ where: { reminderId: chore.id } });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: target.id, itemId: null, systemId: null, partId: null });
    expect(after[0].nextDueOn).toEqual(calDaysOut(5));
    expect(after[0].lastCompletedOn).toEqual(completedAt);
    expect(await ctx.prisma.reminderCompletion.count({ where: { reminderId: chore.id } })).toBe(1);
  });

  it('reports blockers before the parts prompt', async () => {
    const system = await makeSystem('Water heater');
    const part = await ctx.prisma.part.create({ data: { name: 'Anode rod', kind: 'OTHER' } });
    await ctx.prisma.partLink.create({ data: { partId: part.id, systemId: system.id } });
    await makeReminder('REMINDER', 'Flush water heater', [system.id]);

    const result = await actions.tryDeleteSystem(system.id);

    expect(result.ok).toBe(false);
    expect('hasDependents' in result).toBe(true);
  });
});

describe('deleteSystemWithParts re-checks blockers inside its transaction', () => {
  it('rolls back and returns the blockers when a sole-target reminder appears after the prompt', async () => {
    const system = await makeSystem('Water heater');
    const part = await ctx.prisma.part.create({ data: { name: 'Anode rod', kind: 'OTHER' } });
    await ctx.prisma.partLink.create({ data: { partId: part.id, systemId: system.id } });

    const prompt = await actions.tryDeleteSystem(system.id);
    if (prompt.ok || !('hasParts' in prompt)) throw new Error('expected the parts prompt');

    const reminder = await makeReminder('REMINDER', 'Flush water heater', [system.id]);

    const result = await actions.deleteSystemWithParts({
      systemId: system.id,
      archivePartIds: [part.id],
      keepPartIds: [],
    });

    expect(result).toEqual({
      ok: false,
      hasDependents: true,
      dependents: [{ kind: 'reminder', id: reminder.id, label: 'Flush water heater' }],
    });
    expect(await ctx.prisma.system.findUnique({ where: { id: system.id } })).not.toBeNull();
    expect(
      (await ctx.prisma.part.findUniqueOrThrow({ where: { id: part.id } })).archivedAt,
    ).toBeNull();
  });
});
