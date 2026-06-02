import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

// Auth gate: each test sets `currentUserId` to switch the simulated session.
let currentUserId: string | null = null;

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => (currentUserId ? { user: { id: currentUserId } } : null)),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/search/client', () => ({
  enqueueSearchIndex: vi.fn(async () => {}),
}));

let ctx: IntegrationContext;
let actions: typeof import('@/lib/reminders/actions');
let categoryId: string;
let itemId: string;
let systemId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  actions = await import('@/lib/reminders/actions');
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.reminderCompletion.deleteMany();
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.system.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@example.com', name: 'U1' } });
  currentUserId = 'u1';

  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'per-target-completion' },
    create: { slug: 'per-target-completion', name: 'HVAC', sortOrder: 30 },
    update: {},
  });
  categoryId = cat.id;
  const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
  systemId = sys.id;
  const item = await ctx.prisma.item.create({
    data: { name: 'Furnace', categoryId, systemId },
  });
  itemId = item.id;
});

async function createReminderWithTwoTargets(autoCreateServiceRecord = false) {
  const dueOn = new Date('2026-08-01T00:00:00Z');
  const r = await ctx.prisma.reminder.create({
    data: {
      title: 'HVAC service',
      recurrence: { kind: 'interval', days: 60 },
      notifyUserIds: ['u1'],
      autoCreateServiceRecord,
      targets: {
        create: [
          { itemId, nextDueOn: dueOn },
          { systemId, nextDueOn: dueOn },
        ],
      },
    },
    include: { targets: true },
  });
  return r;
}

describe('Per-target completion', () => {
  // completeReminder advances nextDueOn to `now + interval` (here, now + 60d).
  // The fixture's nextDueOn is hardcoded to 2026-08-01, so on the one real-world
  // day where now + 60d === 2026-08-01 (i.e. 2026-06-02) the "advanced" date
  // collides with the original and the `.not.toBe(originalDueOn)` assertions
  // fail. Freeze the wall clock to a fixed, non-colliding instant so the test is
  // deterministic regardless of when it runs. Fake only Date — the integration
  // DB driver and async waits depend on real setTimeout/setInterval.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('completing only one targetId writes one ReminderCompletion and only advances the matching target', async () => {
    const r = await createReminderWithTwoTargets();
    const itemTarget = r.targets.find((t) => t.itemId === itemId);
    const systemTarget = r.targets.find((t) => t.systemId === systemId);
    if (!itemTarget || !systemTarget) throw new Error('expected both targets');
    const originalDueOn = itemTarget.nextDueOn;
    const beforeCompletion = Date.now();

    const result = await actions.completeReminder({
      id: r.id,
      targetIds: [itemTarget.id],
      notes: 'changed filter',
    });
    expect(result.ok).toBe(true);

    const completions = await ctx.prisma.reminderCompletion.findMany({
      where: { reminderId: r.id },
    });
    expect(completions).toHaveLength(1);
    expect(completions[0].targetId).toBe(itemTarget.id);
    expect(completions[0].completedById).toBe('u1');
    expect(completions[0].notes).toBe('changed filter');

    const itemTargetAfter = await ctx.prisma.reminderTarget.findUniqueOrThrow({
      where: { id: itemTarget.id },
    });
    const systemTargetAfter = await ctx.prisma.reminderTarget.findUniqueOrThrow({
      where: { id: systemTarget.id },
    });
    expect(itemTargetAfter.lastCompletedOn).not.toBeNull();
    expect(itemTargetAfter.lastCompletedOn?.getTime()).toBeGreaterThanOrEqual(beforeCompletion);
    // For a 60-day interval recurrence, nextDueOn advances ~60 days past now.
    expect(itemTargetAfter.nextDueOn.getTime()).toBeGreaterThan(beforeCompletion);
    expect(itemTargetAfter.nextDueOn.toISOString()).not.toBe(originalDueOn.toISOString());
    // The other target is untouched.
    expect(systemTargetAfter.lastCompletedOn).toBeNull();
    expect(systemTargetAfter.nextDueOn.toISOString()).toBe(originalDueOn.toISOString());
  });

  it('completing both targetIds writes two completions and advances both targets', async () => {
    const r = await createReminderWithTwoTargets();
    const originalDueOn = r.targets[0].nextDueOn;
    const beforeCompletion = Date.now();

    const result = await actions.completeReminder({
      id: r.id,
      targetIds: r.targets.map((t) => t.id),
    });
    expect(result.ok).toBe(true);

    const completions = await ctx.prisma.reminderCompletion.findMany({
      where: { reminderId: r.id },
    });
    expect(completions).toHaveLength(2);

    const targetsAfter = await ctx.prisma.reminderTarget.findMany({
      where: { reminderId: r.id },
    });
    for (const t of targetsAfter) {
      expect(t.lastCompletedOn).not.toBeNull();
      expect(t.lastCompletedOn?.getTime()).toBeGreaterThanOrEqual(beforeCompletion);
      expect(t.nextDueOn.toISOString()).not.toBe(originalDueOn.toISOString());
    }
  });

  it('with autoCreateServiceRecord=true, completing a target creates one ServiceRecord + ServiceRecordTarget mirroring the target, and wires createdServiceRecordId', async () => {
    const r = await createReminderWithTwoTargets(true);
    const itemTarget = r.targets.find((t) => t.itemId === itemId);
    if (!itemTarget) throw new Error('expected item target');

    const result = await actions.completeReminder({
      id: r.id,
      targetIds: [itemTarget.id],
      serviceRecord: { summary: 'replaced filter', cost: 25 },
    });
    expect(result.ok).toBe(true);

    const completion = await ctx.prisma.reminderCompletion.findFirstOrThrow({
      where: { reminderId: r.id, targetId: itemTarget.id },
      include: {
        createdServiceRecord: { include: { targets: true } },
      },
    });
    expect(completion.createdServiceRecordId).not.toBeNull();
    expect(completion.createdServiceRecord?.summary).toBe('replaced filter');
    expect(completion.createdServiceRecord?.targets).toHaveLength(1);
    expect(completion.createdServiceRecord?.targets[0].itemId).toBe(itemId);
    expect(completion.createdServiceRecord?.targets[0].systemId).toBeNull();
  });

  it('with autoCreateServiceRecord=true on a system target, ServiceRecordTarget is wired to the system, not an item', async () => {
    const r = await createReminderWithTwoTargets(true);
    const systemTarget = r.targets.find((t) => t.systemId === systemId);
    if (!systemTarget) throw new Error('expected system target');

    const result = await actions.completeReminder({
      id: r.id,
      targetIds: [systemTarget.id],
      serviceRecord: { summary: 'system tune-up' },
    });
    expect(result.ok).toBe(true);

    const completion = await ctx.prisma.reminderCompletion.findFirstOrThrow({
      where: { reminderId: r.id, targetId: systemTarget.id },
      include: { createdServiceRecord: { include: { targets: true } } },
    });
    expect(completion.createdServiceRecord?.targets).toHaveLength(1);
    expect(completion.createdServiceRecord?.targets[0].systemId).toBe(systemId);
    expect(completion.createdServiceRecord?.targets[0].itemId).toBeNull();
  });

  it('rejects targetIds that do not belong to the reminder', async () => {
    const r = await createReminderWithTwoTargets();
    const result = await actions.completeReminder({
      id: r.id,
      targetIds: ['rt_does_not_exist'],
    });
    expect(result).toEqual({ ok: false, formError: 'Target not found' });
  });

  it('defaults to completing all targets when targetIds is omitted (single-target back-compat)', async () => {
    const r = await createReminderWithTwoTargets();
    const result = await actions.completeReminder({ id: r.id });
    expect(result.ok).toBe(true);
    const completions = await ctx.prisma.reminderCompletion.findMany({
      where: { reminderId: r.id },
    });
    expect(completions).toHaveLength(2);
  });
});
