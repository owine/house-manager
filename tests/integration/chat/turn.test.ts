import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCalendarDate } from '@/lib/chat/dates';
import type { ChatTurnInput } from '@/lib/chat/schema';
import dedupFixture from '@/tests/fixtures/chat/dedup-note.json';
import hallucinatedIdFixture from '@/tests/fixtures/chat/hallucinated-id.json';
import noteTooLongFixture from '@/tests/fixtures/chat/note-too-long.json';
import performedOnFixture from '@/tests/fixtures/chat/service-record-performed-on.json';
import serviceRecordXorFixture from '@/tests/fixtures/chat/service-record-xor.json';
import simpleReplyFixture from '@/tests/fixtures/chat/simple-reply.json';
import updateNoteAndCreateItemFixture from '@/tests/fixtures/chat/update-note-and-create-item.json';
import { signInAs } from '../ai/_mock-auth';
import { type IntegrationContext, setupIntegration, teardownIntegration } from '../helpers';

// ── Mocks ───────────────────────────────────────────────────────────────────
//
// vi.hoisted carries mutable state the per-file vi.mock factories close over
// (factories are hoisted above normal top-level consts by Vitest, so plain
// `const`s declared after them would be undefined inside the factory).

const hoisted = vi.hoisted(() => {
  const queryVector = new Float32Array(1024).fill(0.05);
  return {
    embedTextsMock: vi.fn(async () => [queryVector]),
    parseMock: vi.fn(),
    // The SECOND model call: parts are extracted unconstrained, via
    // `messages.create`, because the constrained grammar cannot afford the
    // part arms. Defaults to "no parts in this turn", which is the common case.
    createMock: vi.fn(),
    state: {
      askEnabled: true,
      parseResponse: null as unknown,
      lastParseArgs: null as Record<string, unknown> | null,
      // Text the parts call returns, as a complete document. There is no
      // assistant prefill any more, so the model emits the whole object.
      partsResponse: '{"proposals":[]}' as unknown,
      lastCreateArgs: null as Record<string, unknown> | null,
    },
  };
});

vi.mock('@/lib/auth', async () => {
  const { currentUserId } = await import('../ai/_mock-auth');
  return {
    auth: vi.fn(async () => {
      const id = currentUserId();
      return id ? { user: { id } } : null;
    }),
  };
});

// chatTurn gates on getEnv().ASK_ENABLED. helpers.ts sets only DATABASE_URL
// and MEILI_* — nothing sets ASK_ENABLED — so this mock is not optional.
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ ASK_ENABLED: hoisted.state.askEnabled }),
}));

vi.mock('@/lib/embedding/voyage', () => ({
  embedTexts: hoisted.embedTextsMock,
}));

vi.mock('@/lib/ask/retrieve', () => ({
  retrieveTopK: vi.fn(async () => []),
}));

hoisted.createMock.mockImplementation(async (args: Record<string, unknown>) => {
  hoisted.state.lastCreateArgs = args;
  if (hoisted.state.partsResponse instanceof Error) throw hoisted.state.partsResponse;
  return { content: [{ type: 'text', text: hoisted.state.partsResponse }], usage: {} };
});

hoisted.parseMock.mockImplementation(async (args: Record<string, unknown>) => {
  hoisted.state.lastParseArgs = args;
  if (hoisted.state.parseResponse instanceof Error) throw hoisted.state.parseResponse;
  return hoisted.state.parseResponse;
});
// Complete module replacement — every export lib/chat/actions.ts imports
// from '@/lib/ai/client' must be hand-listed here, or the factory throws
// `No "X" export is defined on the mock`.
vi.mock('@/lib/ai/client', () => ({
  getAnthropic: vi.fn(() => ({
    messages: { parse: hoisted.parseMock, create: hoisted.createMock },
  })),
  ANTHROPIC_MODEL: 'claude-haiku-4-5',
  ANTHROPIC_MAX_TOKENS: 2048,
  ANTHROPIC_CHAT_MAX_TOKENS: 4096,
  ANTHROPIC_CHAT_TIMEOUT_MS: 90_000,
}));

// chatTurn itself does not call revalidatePath, but Task 13 adds
// applyProposal to this same module, and that import happens at TOP LEVEL —
// without this mock now, this file would go green today and regress silently
// the moment Task 13 lands.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { createMock, embedTextsMock, parseMock, state } = hoisted;

let ctx: IntegrationContext;
let chatTurn: typeof import('@/lib/chat/actions').chatTurn;
let userId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  ({ chatTurn } = await import('@/lib/chat/actions'));
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

async function seed() {
  await ctx.prisma.chatProposal.deleteMany();
  await ctx.prisma.chatMessage.deleteMany();
  await ctx.prisma.chatSession.deleteMany();
  await ctx.prisma.aISuggestionLog.deleteMany();
  await ctx.prisma.serviceRecordTarget.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.note.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.system.deleteMany();
  await ctx.prisma.category.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();

  const u = await ctx.prisma.user.create({ data: { email: 'chat@x', name: 'C' } });
  userId = u.id;
  signInAs(userId);

  await ctx.prisma.category.create({ data: { id: 'cat-1', slug: 'appliance', name: 'Appliance' } });
  await ctx.prisma.item.create({
    data: { id: 'item-1', name: 'Furnace', categoryId: 'cat-1' },
  });
  await ctx.prisma.system.create({ data: { id: 'sys-1', name: 'HVAC' } });
  await ctx.prisma.note.create({
    data: { id: 'note-1', title: 'Lightbulbs', body: 'Assorted bulbs.' },
  });
}

function turnInput(content: string, sessionId?: string): ChatTurnInput {
  return { sessionId, messages: [{ role: 'user', content }] };
}

describe('chatTurn', () => {
  beforeEach(async () => {
    state.askEnabled = true;
    state.parseResponse = null;
    state.lastParseArgs = null;
    state.partsResponse = '{"proposals":[]}';
    state.lastCreateArgs = null;
    embedTextsMock.mockClear();
    parseMock.mockClear();
    createMock.mockClear();
    await seed();
  });

  it('drops a proposal whose id is absent from the snapshot, keeps the reply', async () => {
    state.parseResponse = hallucinatedIdFixture;

    const result = await chatTurn(turnInput("update the widget's serial number"));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.reply).toBe(hallucinatedIdFixture.parsed_output.reply);
    expect(result.data.proposals).toHaveLength(0);

    const count = await ctx.prisma.chatProposal.count();
    expect(count).toBe(0);
  });

  // ── The second, unconstrained model call ─────────────────────────────────
  // Part proposals cannot ride the main call: the compiled grammar has hard
  // parameter ceilings the part arms blow through (see
  // lib/chat/schema-budget.test.ts). They come from `messages.create` instead
  // and merge into the same turn.

  it('merges part proposals from the second call into the turn', async () => {
    state.parseResponse = simpleReplyFixture;
    state.partsResponse = JSON.stringify({
      proposals: [
        {
          kind: 'CREATE_PART',
          name: { value: 'S14 string light bulbs', source: 'user' },
          partKind: { value: 'BULB', source: 'inferred' },
          spec: {
            value: { base: 'E26', shape: 'S14', watts: 11, colorTempK: 2700 },
            source: 'user',
          },
          itemId: 'item-1',
        },
      ],
    });

    const result = await chatTurn(
      turnInput('the backyard string lights take 24 S14 bulbs, E26 base, 2700K, 11 watts each'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const part = result.data.proposals.find((p) => p.kind === 'CREATE_PART');
    expect(part).toBeDefined();
    expect(part?.targetType).toBe('PART');
    expect(part?.payload).toMatchObject({
      spec: { value: { base: 'E26', shape: 'S14', watts: 11, colorTempK: 2700 } },
    });

    const rows = await ctx.prisma.chatProposal.findMany({ where: { kind: 'CREATE_PART' } });
    expect(rows).toHaveLength(1);
  });

  it('sends the parts call unconstrained, and with no assistant prefill', async () => {
    state.parseResponse = simpleReplyFixture;
    await chatTurn(turnInput('the porch takes BR30 bulbs'));

    const args = state.lastCreateArgs as {
      output_config?: unknown;
      messages: Array<{ role: string; content: string }>;
    };
    // No output_config is the entire point — that is what puts this call
    // outside the three grammar ceilings.
    expect(args.output_config).toBeUndefined();
    // And no trailing assistant turn. A last-assistant-turn prefill 400s on
    // every model after Haiku 4.5, and this call's failure mode is silent
    // (zero part proposals), so a model bump would have switched parts capture
    // off without an error anywhere. Output shape is steered by the prompt and
    // recovered by `extractJsonObject` instead.
    expect(args.messages[args.messages.length - 1].role).toBe('user');
    expect(args.messages.some((m) => m.role === 'assistant' && m.content === '{')).toBe(false);
  });

  it('a failed parts call costs only the part proposals, not the turn', async () => {
    state.parseResponse = updateNoteAndCreateItemFixture;
    state.partsResponse = new Error('anthropic 500');

    const result = await chatTurn(turnInput('update the lightbulbs note and add a toaster'));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.proposals).toHaveLength(2);
    expect(result.data.proposals.some((p) => p.kind.endsWith('_PART'))).toBe(false);
  });

  it('unparseable parts JSON costs only the part proposals, not the turn', async () => {
    state.parseResponse = updateNoteAndCreateItemFixture;
    state.partsResponse = 'sure, here are the bulbs I found!';

    const result = await chatTurn(turnInput('update the lightbulbs note and add a toaster'));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.proposals).toHaveLength(2);
  });

  it('logs the parts call under its own kind so it does not eat the chat budget', async () => {
    state.parseResponse = simpleReplyFixture;
    await chatTurn(turnInput('the porch takes BR30 bulbs'));

    expect(await ctx.prisma.aISuggestionLog.count({ where: { kind: 'chat' } })).toBe(1);
    expect(await ctx.prisma.aISuggestionLog.count({ where: { kind: 'chat-parts' } })).toBe(1);
  });

  it('rewrites a duplicate CREATE_NOTE into UPDATE_NOTE against the existing note', async () => {
    state.parseResponse = dedupFixture;

    const result = await chatTurn(turnInput('here are the bulbs in each room'));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.proposals).toHaveLength(1);
    const proposal = result.data.proposals[0];
    expect(proposal.kind).toBe('UPDATE_NOTE');
    expect(proposal.targetId).toBe('note-1');

    const rows = await ctx.prisma.chatProposal.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('UPDATE_NOTE');
    expect(rows[0].targetId).toBe('note-1');
  });

  it('drops an over-length note body, keeps the other proposal, appends an explanation', async () => {
    state.parseResponse = noteTooLongFixture;

    const result = await chatTurn(turnInput('add a toaster and note this long thing'));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.proposals).toHaveLength(1);
    expect(result.data.proposals[0].kind).toBe('CREATE_ITEM');
    expect(result.data.reply).toContain(noteTooLongFixture.parsed_output.reply);
    expect(result.data.reply).toContain('too long to store well');
  });

  it('records baseUpdatedAt + beforeSnapshot for update kinds, null for create kinds', async () => {
    state.parseResponse = updateNoteAndCreateItemFixture;

    const result = await chatTurn(turnInput('update the lightbulbs note and add a toaster'));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.proposals).toHaveLength(2);

    const updateNote = result.data.proposals.find((p) => p.kind === 'UPDATE_NOTE');
    const createItem = result.data.proposals.find((p) => p.kind === 'CREATE_ITEM');
    expect(updateNote?.baseUpdatedAt).not.toBeNull();
    expect(updateNote?.beforeSnapshot).not.toBeNull();
    expect(createItem?.baseUpdatedAt).toBeNull();
    expect(createItem?.beforeSnapshot).toBeNull();
  });

  it('rejects a CREATE_SERVICE_RECORD target with both itemId+systemId, and one with neither', async () => {
    state.parseResponse = serviceRecordXorFixture;

    const result = await chatTurn(turnInput('log two service visits'));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.proposals).toHaveLength(0);
    expect(await ctx.prisma.chatProposal.count()).toBe(0);
  });

  it('stores performedOn as the correct UTC day', async () => {
    state.parseResponse = performedOnFixture;

    const result = await chatTurn(turnInput('I reset the water heater on the 3rd'));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.proposals).toHaveLength(1);
    const payload = result.data.proposals[0].payload as { performedOn: { value: string } };
    const parsed = parseCalendarDate(payload.performedOn.value);
    expect(parsed?.toISOString()).toBe('2026-07-03T00:00:00.000Z');
  });

  it('LLM error: ok=false, writes an ASSISTANT ChatMessage linked to an error log', async () => {
    state.parseResponse = new Error('upstream exploded');

    const result = await chatTurn(turnInput('this will fail'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.formError).toBeTruthy();

    const assistantMessage = await ctx.prisma.chatMessage.findFirstOrThrow({
      where: { role: 'ASSISTANT' },
    });
    expect(assistantMessage.aiSuggestionLogId).not.toBeNull();

    const log = await ctx.prisma.aISuggestionLog.findUniqueOrThrow({
      where: { id: assistantMessage.aiSuggestionLogId ?? '' },
    });
    expect(log.errorReason).toBeTruthy();
  });

  it('embed failure: ok=false, still persists the session + both messages, zero proposals', async () => {
    state.parseResponse = simpleReplyFixture; // must not be reached
    embedTextsMock.mockRejectedValueOnce(new Error('voyage unavailable'));

    const result = await chatTurn(turnInput('this will fail to embed'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.formError).toBeTruthy();
    // The Anthropic mock must never be reached — embedding failed first.
    expect(parseMock).not.toHaveBeenCalled();

    const session = await ctx.prisma.chatSession.findFirstOrThrow({ where: { userId } });
    const messages = await ctx.prisma.chatMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(messages.map((m) => m.role)).toEqual(['USER', 'ASSISTANT']);
    expect(messages[0].content).toBe('this will fail to embed');

    const assistantMessage = messages[1];
    expect(assistantMessage.aiSuggestionLogId).not.toBeNull();
    const log = await ctx.prisma.aISuggestionLog.findUniqueOrThrow({
      where: { id: assistantMessage.aiSuggestionLogId ?? '' },
    });
    expect(log.errorReason).toBe('embed_failed');

    expect(await ctx.prisma.chatProposal.count()).toBe(0);
  });

  it('ASK_ENABLED=false: short-circuits before embedding, writes nothing', async () => {
    state.askEnabled = false;
    state.parseResponse = simpleReplyFixture;

    const result = await chatTurn(turnInput('this should never reach the model'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.formError).toMatch(/not enabled/i);
    expect(embedTextsMock).not.toHaveBeenCalled();
    expect(parseMock).not.toHaveBeenCalled();

    expect(await ctx.prisma.chatSession.count()).toBe(0);
    expect(await ctx.prisma.chatMessage.count()).toBe(0);
    expect(await ctx.prisma.aISuggestionLog.count()).toBe(0);
  });

  it('rejects a message over 8000 chars with fieldErrors, persists nothing', async () => {
    const tooLong = 'x'.repeat(8001);

    const result = await chatTurn(turnInput(tooLong));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.fieldErrors).toBeTruthy();
    expect(embedTextsMock).not.toHaveBeenCalled();
    expect(parseMock).not.toHaveBeenCalled();
    expect(await ctx.prisma.chatSession.count()).toBe(0);
    expect(await ctx.prisma.chatMessage.count()).toBe(0);
  });

  it('rate limit: blocks the 41st chat turn in an hour; ask usage does not count', async () => {
    // Ask usage must not count against the chat budget.
    await ctx.prisma.aISuggestionLog.createMany({
      data: Array.from({ length: 5 }, () => ({
        userId,
        kind: 'ask',
        systemPromptVersion: 'v1',
        userPrompt: 'q',
        inventorySnapshotIds: [],
        model: 'claude-haiku-4-5',
      })),
    });

    state.parseResponse = simpleReplyFixture;
    for (let i = 0; i < 40; i++) {
      const result = await chatTurn(turnInput(`turn number ${i}`));
      expect(result.ok).toBe(true);
    }

    const blocked = await chatTurn(turnInput('turn number 41'));
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error('expected failure');
    expect(blocked.formError).toMatch(/limit/i);
  }, 60_000);

  it('ChatSession.title is the first non-empty line of the first user turn', async () => {
    state.parseResponse = simpleReplyFixture;

    const result = await chatTurn(turnInput('\n\nI reset the water heater on the 3rd'));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const created = await ctx.prisma.chatSession.findUniqueOrThrow({
      where: { id: result.data.sessionId },
    });
    expect(created.title).toBe('I reset the water heater on the 3rd');
  });

  it('ChatSession.title falls back to a hard cut for an 8000-char single blob', async () => {
    state.parseResponse = simpleReplyFixture;
    const blob = 'x'.repeat(8000);

    const result = await chatTurn(turnInput(blob));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const created = await ctx.prisma.chatSession.findUniqueOrThrow({
      where: { id: result.data.sessionId },
    });
    expect(created.title.endsWith('…')).toBe(true);
    expect(created.title.length).toBeLessThanOrEqual(81);
  });
});
