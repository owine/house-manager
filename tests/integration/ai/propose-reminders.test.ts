import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import emptyFixture from '@/tests/fixtures/suggest/reminders-empty.json';
import fixture from '@/tests/fixtures/suggest/reminders-furnace.json';
import { type IntegrationContext, setupIntegration, teardownIntegration } from '../helpers';

// Auth gate
let _currentUserId: string | null = null;
function signInAs(id: string | null) {
  _currentUserId = id;
}

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => (_currentUserId ? { user: { id: _currentUserId } } : null)),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Mock @/lib/ai/client directly so we own the parse fn and its state.
// This sidesteps the vitest setupFiles vs. test-file module-instance ambiguity
// that arises when both try to mock @anthropic-ai/sdk separately.
let _nextResponse: unknown = null;
let _lastParseArgs: unknown = null;
const _mockParseFn = vi.fn(async (...args: unknown[]) => {
  _lastParseArgs = args[0];
  if (_nextResponse === null) throw new Error('No response queued');
  const r = _nextResponse;
  _nextResponse = null;
  if (r instanceof Error) throw r;
  return r;
});

vi.mock('@/lib/ai/client', () => ({
  getAnthropic: vi.fn(() => ({ messages: { parse: _mockParseFn } })),
  ANTHROPIC_MODEL: 'claude-haiku-4-5',
  ANTHROPIC_MAX_TOKENS: 2048,
}));

function mockParse(response: unknown) {
  _nextResponse = response;
}
function getLastCall() {
  return _lastParseArgs as Record<string, unknown> | null;
}
function resetMock() {
  _nextResponse = null;
  _lastParseArgs = null;
  _mockParseFn.mockClear();
}

describe('proposeReminders', () => {
  let ctx: IntegrationContext;
  let categoryId: string;
  let proposeReminders: typeof import('@/lib/ai/suggest/reminders').proposeReminders;

  beforeAll(async () => {
    ctx = await setupIntegration();
    const cat = await ctx.prisma.category.upsert({
      where: { slug: 'hvac' },
      create: { slug: 'hvac', name: 'HVAC', sortOrder: 20 },
      update: {},
    });
    categoryId = cat.id;
    ({ proposeReminders } = await import('@/lib/ai/suggest/reminders'));
  }, 60_000);

  afterAll(async () => {
    await teardownIntegration(ctx);
  });

  beforeEach(async () => {
    resetMock();
    await ctx.prisma.aISuggestionLog.deleteMany();
    await ctx.prisma.item.deleteMany();
    await ctx.prisma.session.deleteMany();
    await ctx.prisma.account.deleteMany();
    await ctx.prisma.user.deleteMany();
    signInAs(null);
  });

  it('returns proposals + logId on success', async () => {
    const user = await ctx.prisma.user.create({ data: { email: 'p@x', name: 'P' } });
    signInAs(user.id);
    mockParse(fixture);

    const result = await proposeReminders({});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.proposals).toHaveLength(2);
    expect(result.data.logId).toBeTruthy();

    const log = await ctx.prisma.aISuggestionLog.findUniqueOrThrow({
      where: { id: result.data.logId },
    });
    expect(log.userId).toBe(user.id);
    expect(log.kind).toBe('reminders');
    expect(log.cacheCreationTokens).toBe(5200);
  });

  it('passes a cache_control marker on the inventory block', async () => {
    const user = await ctx.prisma.user.create({ data: { email: 'p2@x', name: 'P' } });
    signInAs(user.id);
    mockParse(fixture);
    await proposeReminders({});
    const args = getLastCall() as { system: { cache_control?: object }[] } | null;
    expect(args).not.toBeNull();
    const system = args?.system ?? [];
    const last = system[system.length - 1];
    expect(last.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('attaches focused item details when itemId is provided', async () => {
    const user = await ctx.prisma.user.create({ data: { email: 'p3@x', name: 'P' } });
    const item = await ctx.prisma.item.create({
      data: { name: 'Carrier Furnace', categoryId, manufacturer: 'Carrier', model: '58STA' },
    });
    signInAs(user.id);
    mockParse(fixture);

    await proposeReminders({ itemId: item.id });
    const args = getLastCall() as { messages: { content: string }[] } | null;
    expect(args).not.toBeNull();
    const userMsg = args?.messages[0].content ?? '';
    expect(userMsg).toContain('Carrier Furnace');
    expect(userMsg).toContain(item.id);
  });

  it('returns empty proposals successfully (no error)', async () => {
    const user = await ctx.prisma.user.create({ data: { email: 'p4@x', name: 'P' } });
    signInAs(user.id);
    mockParse(emptyFixture);
    const result = await proposeReminders({});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.data.proposals).toEqual([]);
  });

  it('rejects unauthenticated calls', async () => {
    signInAs(null);
    const result = await proposeReminders({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.formError).toBe('Unauthorized');
  });
});
