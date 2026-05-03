import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from '../helpers';
import { mockParseError, resetMock } from './_mock-ai-client';
import { signInAs } from './_mock-auth';

vi.mock('@/lib/auth', async () => {
  const { currentUserId } = await import('./_mock-auth');
  return {
    auth: vi.fn(async () => {
      const id = currentUserId();
      return id ? { user: { id } } : null;
    }),
  };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/ai/client', async () => {
  const { mockParseFn } = await import('./_mock-ai-client');
  return {
    getAnthropic: vi.fn(() => ({ messages: { parse: mockParseFn } })),
    ANTHROPIC_MODEL: 'claude-haiku-4-5',
    ANTHROPIC_MAX_TOKENS: 2048,
  };
});

describe('proposeReminders error paths', () => {
  let ctx: IntegrationContext;
  let proposeReminders: typeof import('@/lib/ai/suggest/reminders').proposeReminders;
  let userId: string;

  beforeAll(async () => {
    ctx = await setupIntegration();
    ({ proposeReminders } = await import('@/lib/ai/suggest/reminders'));
  }, 60_000);

  afterAll(async () => {
    await teardownIntegration(ctx);
  });

  beforeEach(async () => {
    resetMock();
    await ctx.prisma.aISuggestionLog.deleteMany();
    await ctx.prisma.session.deleteMany();
    await ctx.prisma.account.deleteMany();
    await ctx.prisma.user.deleteMany();
    const u = await ctx.prisma.user.create({ data: { email: 'err@x', name: 'E' } });
    userId = u.id;
    signInAs(userId);
  });

  function classifiedError(status: number, msg = 'x') {
    const e = new Error(msg) as Error & { status?: number };
    e.status = status;
    return e;
  }

  it('429 → rate_limited', async () => {
    mockParseError(classifiedError(429));
    const r = await proposeReminders({});
    expect(r.ok).toBe(false);
    const log = await ctx.prisma.aISuggestionLog.findFirstOrThrow({ where: { userId } });
    expect(log.errorReason).toBe('rate_limited');
  });

  it('503 → upstream_5xx', async () => {
    mockParseError(classifiedError(503));
    await proposeReminders({});
    const log = await ctx.prisma.aISuggestionLog.findFirstOrThrow({ where: { userId } });
    expect(log.errorReason).toBe('upstream_5xx');
  });

  it('timeout', async () => {
    mockParseError(new Error('Request timed out'));
    await proposeReminders({});
    const log = await ctx.prisma.aISuggestionLog.findFirstOrThrow({ where: { userId } });
    expect(log.errorReason).toBe('timeout');
  });

  it('schema violation', async () => {
    mockParseError(new Error('ZodError: invalid input'));
    await proposeReminders({});
    const log = await ctx.prisma.aISuggestionLog.findFirstOrThrow({ where: { userId } });
    expect(log.errorReason).toBe('schema_violation');
  });

  it('per-user rate cap blocks call entirely', async () => {
    // Seed 10 successful logs in the last hour
    for (let i = 0; i < 10; i++) {
      await ctx.prisma.aISuggestionLog.create({
        data: {
          userId,
          kind: 'reminders',
          systemPromptVersion: 'v1',
          model: 'm',
          inventorySnapshotIds: [],
        },
      });
    }
    // No mockParseError queued — if the action calls Anthropic, it would throw "No response queued".
    const r = await proposeReminders({});
    expect(r.ok).toBe(false);
    const logs = await ctx.prisma.aISuggestionLog.findMany({ where: { userId } });
    const blocked = logs.find((l) => l.errorReason === 'user_rate_limit');
    expect(blocked).toBeTruthy();
  });
});
