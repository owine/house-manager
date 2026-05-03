import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from '../helpers';

describe('AISuggestionLog writer', () => {
  let ctx: IntegrationContext;
  let logModule: typeof import('@/lib/ai/log');

  beforeAll(async () => {
    ctx = await setupIntegration();
    logModule = await import('@/lib/ai/log');
  }, 60_000);

  afterAll(async () => {
    await teardownIntegration(ctx);
  });

  it('createSuggestionLog persists a row with full telemetry', async () => {
    const user = await ctx.prisma.user.create({ data: { email: 'a@x', name: 'A' } });
    const row = await logModule.createSuggestionLog({
      userId: user.id,
      kind: 'reminders',
      userPrompt: 'free form',
      inventorySnapshotIds: ['cuid-a', 'cuid-b'],
      response: { proposals: [{ title: 'X' }] },
      model: 'claude-haiku-4-5',
      inputTokens: 5000,
      outputTokens: 200,
      cacheReadTokens: 4500,
      cacheCreationTokens: 0,
      latencyMs: 1234,
    });
    const persisted = await ctx.prisma.aISuggestionLog.findUniqueOrThrow({ where: { id: row.id } });
    expect(persisted.userId).toBe(user.id);
    expect(persisted.systemPromptVersion).toBe('v1');
    expect(persisted.inventorySnapshotIds).toEqual(['cuid-a', 'cuid-b']);
    expect(persisted.cacheReadTokens).toBe(4500);
    expect(persisted.acceptedItemIds).toEqual([]);
    expect(persisted.errorReason).toBeNull();
  });

  it('createSuggestionLog with errorReason sets response null', async () => {
    const user = await ctx.prisma.user.create({ data: { email: 'b@x', name: 'B' } });
    const row = await logModule.createSuggestionLog({
      userId: user.id,
      kind: 'checklist',
      userPrompt: null,
      inventorySnapshotIds: [],
      response: null,
      errorReason: 'upstream_5xx',
      model: 'claude-haiku-4-5',
    });
    expect(row.response).toBeNull();
    expect(row.errorReason).toBe('upstream_5xx');
  });

  it('markAccepted appends ids to the JSON array on the existing row', async () => {
    const user = await ctx.prisma.user.create({ data: { email: 'c@x', name: 'C' } });
    const row = await logModule.createSuggestionLog({
      userId: user.id,
      kind: 'reminders',
      userPrompt: null,
      inventorySnapshotIds: [],
      response: { proposals: [] },
      model: 'claude-haiku-4-5',
    });
    await logModule.markAccepted(row.id, ['rem-1', 'rem-2']);
    await logModule.markAccepted(row.id, ['rem-3']);
    const after = await ctx.prisma.aISuggestionLog.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.acceptedItemIds).toEqual(['rem-1', 'rem-2', 'rem-3']);
  });
});
