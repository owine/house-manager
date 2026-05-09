import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

// Mock the Anthropic client at the boundary so the tests run offline.
const sentMessages: Array<{ system: unknown; messages: unknown }> = [];
let mockResponse: { parsed_output: unknown; usage?: Record<string, number> } | (() => never) = {
  parsed_output: {
    summary: 'Spring HVAC tune-up',
    cost: 185.0,
    performedOn: '2026-04-15',
    scope:
      '- Replaced **air filter** on heat pump\n- Cleaned condenser coils\n- All readings normal.',
    rationale: 'Subject + body clearly state service date and total.',
  },
  usage: { input_tokens: 100, output_tokens: 50 },
};

vi.mock('@/lib/ai/client', () => ({
  ANTHROPIC_MODEL: 'claude-haiku-4-5',
  ANTHROPIC_MAX_TOKENS: 2048,
  getAnthropic: () => ({
    messages: {
      parse: vi.fn(async (input: { system: unknown; messages: unknown }) => {
        sentMessages.push(input);
        if (typeof mockResponse === 'function') return (mockResponse as () => never)();
        return mockResponse;
      }),
    },
  }),
}));

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

let ctx: IntegrationContext;
let handle: typeof import('@/worker/jobs/extract-incoming-email').handleExtractIncomingEmail;

async function makeEmail(args: {
  messageId: string;
  subject?: string;
  bodyText?: string;
  kind?: 'TICKET' | 'INVOICE' | 'ESTIMATE' | 'UNKNOWN';
}) {
  return ctx.prisma.incomingEmail.create({
    data: {
      messageId: args.messageId,
      fromAddress: 'billing@acme.example',
      fromName: 'Acme HVAC',
      subject: args.subject ?? 'Service Invoice #4827',
      bodyText:
        args.bodyText ??
        'Service date: 4/15/2026\n\nReplaced air filter on heat pump.\nCleaned condenser coils.\n\nTotal Due: $185.00',
      receivedAt: new Date('2026-05-01T12:00:00Z'),
      headersJson: {},
      kind: args.kind ?? 'INVOICE',
    },
  });
}

beforeAll(async () => {
  ctx = await setupIntegration();
  const mod = await import('@/worker/jobs/extract-incoming-email');
  handle = mod.handleExtractIncomingEmail;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  sentMessages.length = 0;
  await ctx.prisma.incomingEmailTarget.deleteMany();
  await ctx.prisma.incomingEmail.deleteMany();
  await ctx.prisma.aISuggestionLog.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@a', name: 'U1' } });
  // Reset mock to the happy-path response between tests.
  mockResponse = {
    parsed_output: {
      summary: 'Spring HVAC tune-up',
      cost: 185.0,
      performedOn: '2026-04-15',
      scope:
        '- Replaced **air filter** on heat pump\n- Cleaned condenser coils\n- All readings normal.',
      rationale: 'Subject + body clearly state service date and total.',
    },
    usage: { input_tokens: 100, output_tokens: 50 },
  };
});

describe('handleExtractIncomingEmail', () => {
  it('extracts and persists summary / cost / performedOn / scope', async () => {
    const e = await makeEmail({ messageId: '<x1@a>' });
    await handle([{ data: { id: e.id } }]);
    const after = await ctx.prisma.incomingEmail.findUnique({ where: { id: e.id } });
    expect(after?.aiExtractedSummary).toBe('Spring HVAC tune-up');
    expect(after?.aiExtractedCost?.toString()).toBe('185');
    expect(after?.aiExtractedPerformedOn?.toISOString()).toBe('2026-04-15T00:00:00.000Z');
    expect(after?.aiExtractedScope).toContain('air filter');
    expect(after?.aiExtractedAt).not.toBeNull();
  });

  it('accepts null fields from the model (skipped extraction)', async () => {
    mockResponse = {
      parsed_output: {
        summary: null,
        cost: null,
        performedOn: null,
        scope: null,
        rationale: 'Body had no extractable info.',
      },
    };
    const e = await makeEmail({ messageId: '<x2@a>' });
    await handle([{ data: { id: e.id } }]);
    const after = await ctx.prisma.incomingEmail.findUnique({ where: { id: e.id } });
    expect(after?.aiExtractedSummary).toBeNull();
    expect(after?.aiExtractedCost).toBeNull();
    expect(after?.aiExtractedPerformedOn).toBeNull();
    expect(after?.aiExtractedScope).toBeNull();
    expect(after?.aiExtractedAt).not.toBeNull(); // still stamps the attempt
  });

  it('rejects malformed performedOn dates without crashing', async () => {
    mockResponse = {
      parsed_output: {
        summary: 'X',
        cost: 1,
        performedOn: 'not-a-date',
        scope: 'x',
        rationale: 'r',
      },
    };
    const e = await makeEmail({ messageId: '<x3@a>' });
    await handle([{ data: { id: e.id } }]);
    const after = await ctx.prisma.incomingEmail.findUnique({ where: { id: e.id } });
    expect(after?.aiExtractedPerformedOn).toBeNull();
    expect(after?.aiExtractedSummary).toBe('X');
  });

  it('skips emails with empty/very short body (avoids hallucination input)', async () => {
    const e = await makeEmail({ messageId: '<x4@a>', bodyText: 'hi' });
    await handle([{ data: { id: e.id } }]);
    expect(sentMessages).toHaveLength(0);
    const after = await ctx.prisma.incomingEmail.findUnique({ where: { id: e.id } });
    expect(after?.aiExtractedAt).toBeNull();
  });

  it('skips a missing row without throwing', async () => {
    await expect(handle([{ data: { id: 'nope' } }])).resolves.toBeUndefined();
    expect(sentMessages).toHaveLength(0);
  });

  it('logs error and returns when the model call throws', async () => {
    mockResponse = () => {
      throw Object.assign(new Error('rate limited'), { status: 429 });
    };
    const e = await makeEmail({ messageId: '<x5@a>' });
    await handle([{ data: { id: e.id } }]);
    const after = await ctx.prisma.incomingEmail.findUnique({ where: { id: e.id } });
    // Extraction failed → fields stay null, aiExtractedAt stays null.
    expect(after?.aiExtractedSummary).toBeNull();
    expect(after?.aiExtractedAt).toBeNull();
    // AISuggestionLog row written with errorReason set.
    const logs = await ctx.prisma.aISuggestionLog.findMany({
      where: { kind: 'incoming-email-extract' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].errorReason).toBe('rate_limited');
  });
});
