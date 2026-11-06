import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from '../helpers';

describe('reserveRateLimit', () => {
  let ctx: IntegrationContext;
  let userId: string;
  let mod: typeof import('@/lib/ai/rate-limit');

  beforeAll(async () => {
    ctx = await setupIntegration();
    mod = await import('@/lib/ai/rate-limit');
  }, 60_000);
  afterAll(async () => {
    await teardownIntegration(ctx);
  });

  beforeEach(async () => {
    await ctx.prisma.aISuggestionLog.deleteMany({});
    const user = await ctx.prisma.user.upsert({
      where: { email: 'rl@x' },
      create: { email: 'rl@x', name: 'RL' },
      update: {},
    });
    userId = user.id;
  });

  async function seedLogs(count: number, ageMinutes = 0) {
    const now = new Date();
    for (let i = 0; i < count; i++) {
      await ctx.prisma.aISuggestionLog.create({
        data: {
          userId,
          kind: 'reminders',
          systemPromptVersion: 'v1',
          model: 'm',
          createdAt: new Date(now.getTime() - ageMinutes * 60_000),
          inventorySnapshotIds: [],
        },
      });
    }
  }

  it('allows when under limit', async () => {
    await seedLogs(9);
    const r = await mod.reserveRateLimit(userId, 'reminders', 'm');
    expect(r.allowed).toBe(true);
    // The reservation took the last slot.
    expect(r.remaining).toBe(0);
    expect(r.reservationId).not.toBeNull();
  });

  it('blocks at the 11th call', async () => {
    await seedLogs(10);
    const r = await mod.reserveRateLimit(userId, 'reminders', 'm');
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.reservationId).toBeNull();
    // A refusal reserves nothing.
    expect(await ctx.prisma.aISuggestionLog.count()).toBe(10);
  });

  it('does not count rows older than 1 hour', async () => {
    await seedLogs(15, 75);
    const r = await mod.reserveRateLimit(userId, 'reminders', 'm');
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(9);
  });

  it('does not let usage of a different kind count against the kind under test', async () => {
    // 10 'reminders' logs would exhaust the 'reminders' budget, but they must
    // not affect the independent 'ask' budget — that isolation is the entire
    // point of scoping the rate limit per kind.
    await seedLogs(10);
    const reminders = await mod.reserveRateLimit(userId, 'reminders', 'm');
    expect(reminders.allowed).toBe(false);

    const ask = await mod.reserveRateLimit(userId, 'ask', 'm');
    expect(ask.allowed).toBe(true);
    expect(ask.used).toBe(1);
    expect(ask.remaining).toBe(9);
  });

  // The bug this replaced: the count and the budget-consuming write were
  // separated by the model call, so a burst of overlapping requests all saw
  // the same count and every one got a paid call.
  it('a concurrent burst gets exactly the remaining budget', async () => {
    await seedLogs(7);
    const burst = await Promise.all(
      Array.from({ length: 12 }, () => mod.reserveRateLimit(userId, 'reminders', 'm')),
    );
    expect(burst.filter((r) => r.allowed)).toHaveLength(3);
    expect(await ctx.prisma.aISuggestionLog.count({ where: { userId, kind: 'reminders' } })).toBe(
      10,
    );
  });

  it('the outcome fills the reserved row instead of adding one', async () => {
    const { createSuggestionLog } = await import('@/lib/ai/log');
    const r = await mod.reserveRateLimit(userId, 'reminders', 'm');
    const reserved = await ctx.prisma.aISuggestionLog.findUniqueOrThrow({
      where: { id: r.reservationId as string },
    });
    expect(reserved.errorReason).toBe(mod.IN_FLIGHT);

    await createSuggestionLog({
      reservationId: r.reservationId,
      userId,
      kind: 'reminders',
      userPrompt: null,
      inventorySnapshotIds: ['i1'],
      response: { proposals: [] },
      model: 'm',
      inputTokens: 5,
    });

    const rows = await ctx.prisma.aISuggestionLog.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(r.reservationId);
    // The success write clears the in_flight marker.
    expect(rows[0]?.errorReason).toBeNull();
    expect(rows[0]?.inputTokens).toBe(5);
    expect(rows[0]?.inventorySnapshotIds).toEqual(['i1']);
  });
});
