import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from '../helpers';

describe('checkRateLimit', () => {
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
    const r = await mod.checkRateLimit(userId);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(1);
  });

  it('blocks at the 11th call', async () => {
    await seedLogs(10);
    const r = await mod.checkRateLimit(userId);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it('does not count rows older than 1 hour', async () => {
    await seedLogs(15, 75);
    const r = await mod.checkRateLimit(userId);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(10);
  });
});
