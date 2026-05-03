import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '@/tests/fixtures/suggest/checklist-spring.json';
import { type IntegrationContext, setupIntegration, teardownIntegration } from '../helpers';
import { getLastCall, mockParse, resetMock } from './_mock-ai-client';
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
