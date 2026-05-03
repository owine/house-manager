import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '@/tests/fixtures/suggest/checklist-spring.json';
import { type IntegrationContext, setupIntegration, teardownIntegration } from '../helpers';

// Auth gate (mirror propose-reminders.test.ts)
let _currentUserId: string | null = null;
function signInAs(id: string | null) {
  _currentUserId = id;
}

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => (_currentUserId ? { user: { id: _currentUserId } } : null)),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Mock @/lib/ai/client directly so we own the parse fn and its state.
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

describe('proposeChecklist', () => {
  let ctx: IntegrationContext;
  let proposeChecklist: typeof import('@/lib/ai/suggest/checklist').proposeChecklist;

  beforeAll(async () => {
    ctx = await setupIntegration();
    ({ proposeChecklist } = await import('@/lib/ai/suggest/checklist'));
  }, 60_000);

  afterAll(async () => {
    await teardownIntegration(ctx);
  });

  beforeEach(async () => {
    resetMock();
    await ctx.prisma.aISuggestionLog.deleteMany();
    await ctx.prisma.checklistItem.deleteMany();
    await ctx.prisma.checklist.deleteMany();
    await ctx.prisma.session.deleteMany();
    await ctx.prisma.account.deleteMany();
    await ctx.prisma.user.deleteMany();
    signInAs(null);
  });

  it('seasonal mode produces a checklist', async () => {
    const u = await ctx.prisma.user.create({ data: { email: 'cs@x', name: 'C' } });
    signInAs(u.id);
    mockParse(fixture);
    const r = await proposeChecklist({ mode: 'seasonal', season: 'spring' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.data.name).toBe('Spring 2026 Maintenance');
    expect(r.data.items.length).toBeGreaterThan(0);
    const args = getLastCall() as { messages: { content: string }[] };
    expect(args.messages[0].content).toContain('spring');
  });

  it('freeform mode passes the user prompt through', async () => {
    const u = await ctx.prisma.user.create({ data: { email: 'cf@x', name: 'C' } });
    signInAs(u.id);
    mockParse(fixture);
    await proposeChecklist({ mode: 'freeform', freeFormPrompt: 'Pre-vacation checklist' });
    const args = getLastCall() as { messages: { content: string }[] };
    expect(args.messages[0].content).toContain('Pre-vacation checklist');
  });

  it('append mode references the existing checklist by name', async () => {
    const u = await ctx.prisma.user.create({ data: { email: 'ca@x', name: 'C' } });
    signInAs(u.id);
    const existing = await ctx.prisma.checklist.create({ data: { name: 'Quarterly HVAC' } });
    mockParse(fixture);
    await proposeChecklist({ mode: 'append', forChecklistId: existing.id });
    const args = getLastCall() as { messages: { content: string }[] };
    expect(args.messages[0].content).toContain('Quarterly HVAC');
  });

  it('append mode rejects unknown checklist id', async () => {
    const u = await ctx.prisma.user.create({ data: { email: 'cau@x', name: 'C' } });
    signInAs(u.id);
    const r = await proposeChecklist({ mode: 'append', forChecklistId: 'cuid-nope' });
    expect(r.ok).toBe(false);
  });

  it('rejects malformed input via Zod', async () => {
    const u = await ctx.prisma.user.create({ data: { email: 'ci@x', name: 'C' } });
    signInAs(u.id);
    const r = await proposeChecklist({ mode: 'seasonal' }); // missing `season` — Zod catches at runtime
    expect(r.ok).toBe(false);
  });
});
