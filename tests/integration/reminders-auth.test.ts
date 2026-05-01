import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

// Auth gate: each test sets `currentUserId` to switch the simulated session.
let currentUserId: string | null = null;

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => (currentUserId ? { user: { id: currentUserId } } : null)),
}));

// revalidatePath has no effect in vitest; stub to silence "should be called from
// a Server Action" errors from next/cache when the actions invoke it.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

let ctx: IntegrationContext;
let actions: typeof import('@/lib/reminders/actions');
let reminderId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  actions = await import('@/lib/reminders/actions');
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.reminderCompletion.deleteMany();
  await ctx.prisma.notificationLog.deleteMany();
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.createMany({
    data: [
      { id: 'u1', email: 'u1@example.com', name: 'U1' },
      { id: 'u2', email: 'u2@example.com', name: 'U2' },
      { id: 'u3', email: 'u3@example.com', name: 'U3' },
    ],
  });

  // Reminder owned by u1 only.
  const r = await ctx.prisma.reminder.create({
    data: {
      title: 'Replace HVAC filter',
      recurrence: { kind: 'interval', days: 60 },
      nextDueOn: new Date('2026-06-30'),
      notifyUserIds: ['u1'],
    },
  });
  reminderId = r.id;
});

describe('per-resource auth — non-owner is rejected with "Not found"', () => {
  it('updateReminder by u2 is rejected; row is unchanged', async () => {
    currentUserId = 'u2';
    const result = await actions.updateReminder({ id: reminderId, title: 'PWNED' });
    expect(result).toEqual({ ok: false, formError: 'Not found' });

    const after = await ctx.prisma.reminder.findUnique({ where: { id: reminderId } });
    expect(after?.title).toBe('Replace HVAC filter');
  });

  it('deleteReminder by u2 is rejected; row still exists', async () => {
    currentUserId = 'u2';
    const result = await actions.deleteReminder(reminderId);
    expect(result).toEqual({ ok: false, formError: 'Not found' });

    const after = await ctx.prisma.reminder.findUnique({ where: { id: reminderId } });
    expect(after).not.toBeNull();
  });

  it('setReminderActive by u2 is rejected; active flag is unchanged', async () => {
    currentUserId = 'u2';
    const result = await actions.setReminderActive(reminderId, false);
    expect(result).toEqual({ ok: false, formError: 'Not found' });

    const after = await ctx.prisma.reminder.findUnique({ where: { id: reminderId } });
    expect(after?.active).toBe(true);
  });

  it('completeReminder by u2 is rejected; no completion row is written', async () => {
    currentUserId = 'u2';
    const result = await actions.completeReminder({ id: reminderId });
    expect(result).toEqual({ ok: false, formError: 'Not found' });

    const completions = await ctx.prisma.reminderCompletion.findMany({ where: { reminderId } });
    expect(completions).toHaveLength(0);
  });
});

describe('per-resource auth — owner succeeds', () => {
  it('updateReminder by u1 succeeds', async () => {
    currentUserId = 'u1';
    const result = await actions.updateReminder({ id: reminderId, title: 'New title' });
    expect(result.ok).toBe(true);

    const after = await ctx.prisma.reminder.findUnique({ where: { id: reminderId } });
    expect(after?.title).toBe('New title');
  });

  it('deleteReminder by u1 succeeds and removes the row', async () => {
    currentUserId = 'u1';
    const result = await actions.deleteReminder(reminderId);
    expect(result.ok).toBe(true);

    const after = await ctx.prisma.reminder.findUnique({ where: { id: reminderId } });
    expect(after).toBeNull();
  });

  it('setReminderActive by u1 succeeds and toggles the flag', async () => {
    currentUserId = 'u1';
    const result = await actions.setReminderActive(reminderId, false);
    expect(result.ok).toBe(true);

    const after = await ctx.prisma.reminder.findUnique({ where: { id: reminderId } });
    expect(after?.active).toBe(false);
  });

  it('completeReminder by u1 succeeds and writes a completion row', async () => {
    currentUserId = 'u1';
    const result = await actions.completeReminder({ id: reminderId });
    expect(result.ok).toBe(true);

    const completions = await ctx.prisma.reminderCompletion.findMany({ where: { reminderId } });
    expect(completions).toHaveLength(1);
    expect(completions[0].completedById).toBe('u1');
  });
});

describe('per-resource auth — multi-owner reminders', () => {
  // Proves notifyUserIds: { has: userId } matches elements at any position in
  // the array, not just the first. Critical for the multi-user path the
  // schema models — without this, a user added as a secondary owner would
  // get spurious "Not found" errors.
  it('any user in notifyUserIds[] can update; users not in the array cannot', async () => {
    const r = await ctx.prisma.reminder.create({
      data: {
        title: 'Shared reminder',
        recurrence: { kind: 'interval', days: 60 },
        nextDueOn: new Date('2026-06-30'),
        notifyUserIds: ['u1', 'u3'],
      },
    });

    // u3 is the second element of notifyUserIds — must succeed.
    currentUserId = 'u3';
    const ok = await actions.updateReminder({ id: r.id, title: 'Edited by u3' });
    expect(ok.ok).toBe(true);

    // u2 is not in the array — must fail with the same uniform 'Not found'.
    currentUserId = 'u2';
    const denied = await actions.updateReminder({ id: r.id, title: 'PWNED' });
    expect(denied).toEqual({ ok: false, formError: 'Not found' });

    const after = await ctx.prisma.reminder.findUnique({ where: { id: r.id } });
    expect(after?.title).toBe('Edited by u3');
  });
});
