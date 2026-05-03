import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from '../helpers';

let _currentUserId: string | null = null;
function signInAs(id: string | null) {
  _currentUserId = id;
}

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => (_currentUserId ? { user: { id: _currentUserId } } : null)),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

describe('saveAcceptedReminders', () => {
  let ctx: IntegrationContext;
  let saveAcceptedReminders: typeof import('@/lib/ai/suggest/actions').saveAcceptedReminders;
  let userId: string;
  let logId: string;
  let categoryId: string;

  beforeAll(async () => {
    ctx = await setupIntegration();
    ({ saveAcceptedReminders } = await import('@/lib/ai/suggest/actions'));
    const cat = await ctx.prisma.category.upsert({
      where: { slug: 'hvac' },
      create: { slug: 'hvac', name: 'HVAC', sortOrder: 20 },
      update: {},
    });
    categoryId = cat.id;
  }, 60_000);

  afterAll(async () => {
    await teardownIntegration(ctx);
  });

  beforeEach(async () => {
    // FK-safe cleanup order
    await ctx.prisma.reminderCompletion.deleteMany();
    await ctx.prisma.notificationLog.deleteMany();
    await ctx.prisma.reminder.deleteMany();
    await ctx.prisma.aISuggestionLog.deleteMany();
    await ctx.prisma.item.deleteMany();
    await ctx.prisma.session.deleteMany();
    await ctx.prisma.account.deleteMany();
    await ctx.prisma.user.deleteMany();
    const u = await ctx.prisma.user.create({ data: { email: 'sr@x', name: 'S' } });
    userId = u.id;
    const log = await ctx.prisma.aISuggestionLog.create({
      data: {
        userId,
        kind: 'reminders',
        systemPromptVersion: 'v1',
        model: 'm',
        inventorySnapshotIds: [],
      },
    });
    logId = log.id;
    signInAs(userId);
  });

  it('inserts reminders + updates acceptedItemIds in one transaction', async () => {
    const result = await saveAcceptedReminders({
      logId,
      accepted: [
        {
          title: 'Replace filter',
          description: 'q90d',
          recurrence: { kind: 'interval', days: 90 },
          leadTimeDays: 7,
          rationale: 'spec',
        },
        {
          title: 'Annual inspection',
          recurrence: { kind: 'yearly', month: 10, day: 15 },
          leadTimeDays: 14,
          rationale: 'preseason',
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.data.savedIds).toHaveLength(2);

    const reminders = await ctx.prisma.reminder.findMany({
      where: { id: { in: result.data.savedIds } },
    });
    expect(reminders).toHaveLength(2);

    const log = await ctx.prisma.aISuggestionLog.findUniqueOrThrow({ where: { id: logId } });
    expect(log.acceptedItemIds).toEqual(result.data.savedIds);
  });

  it('attaches itemId when provided', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'X', categoryId } });
    const result = await saveAcceptedReminders({
      logId,
      itemId: item.id,
      accepted: [
        {
          title: 'Pinned',
          recurrence: { kind: 'interval', days: 30 },
          leadTimeDays: 3,
          rationale: 'r',
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    const r = await ctx.prisma.reminder.findUniqueOrThrow({
      where: { id: result.data.savedIds[0] },
    });
    expect(r.itemId).toBe(item.id);
  });

  it('rejects empty accepted list', async () => {
    const result = await saveAcceptedReminders({ logId, accepted: [] });
    expect(result.ok).toBe(false);
  });
});
