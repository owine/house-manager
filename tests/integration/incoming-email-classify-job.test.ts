import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let filesDir = '';
vi.mock('@/lib/env', () => ({
  getEnv: vi.fn(() => ({ FILES_DIR: filesDir })),
}));

// Mock the Anthropic client at the boundary so the tests run offline. The
// mock response is swappable per-test (a parsed_output object, or a function
// that throws to exercise the heuristic fallback).
const sentMessages: Array<{ system: unknown; messages: unknown }> = [];
type MockResp = { parsed_output: unknown; usage?: Record<string, number> } | (() => never);
let mockResponse: MockResp;

function happyPath(): MockResp {
  return {
    parsed_output: {
      kind: 'INVOICE',
      vendorId: null,
      targetItemId: null,
      targetSystemId: null,
      confidence: 'high',
      summary: 'Spring HVAC tune-up',
      cost: 185.0,
      performedOn: '2026-04-15',
      scope: 'Replaced air filter on heat pump. Cleaned condenser coils.',
      rationale: 'Subject + body clearly identify vendor and kind.',
    },
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

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

const sentryCaptured: unknown[] = [];
vi.mock('@sentry/node', () => ({
  captureException: vi.fn((e: unknown) => {
    sentryCaptured.push(e);
  }),
}));

let ctx: IntegrationContext;
let handle: typeof import('@/worker/jobs/classify-incoming-email').handleClassifyIncomingEmail;
let categoryId: string;

async function makeEmail(args: {
  messageId: string;
  fromAddress?: string;
  fromName?: string;
  subject: string;
  bodyText?: string;
}) {
  return ctx.prisma.incomingEmail.create({
    data: {
      messageId: args.messageId,
      fromAddress: args.fromAddress ?? 'billing@acme.example',
      fromName: args.fromName ?? 'Acme HVAC',
      subject: args.subject,
      bodyText: args.bodyText ?? null,
      receivedAt: new Date('2026-05-08T12:00:00Z'),
      headersJson: {},
    },
  });
}

beforeAll(async () => {
  ctx = await setupIntegration();
  filesDir = mkdtempSync(join(tmpdir(), 'classify-test-'));
  const mod = await import('@/worker/jobs/classify-incoming-email');
  handle = mod.handleClassifyIncomingEmail;
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'hvac' },
    create: { slug: 'hvac', name: 'HVAC', sortOrder: 1 },
    update: {},
  });
  categoryId = cat.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  sentMessages.length = 0;
  sentryCaptured.length = 0;
  await ctx.prisma.serviceRecordTarget.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.incomingEmailTarget.deleteMany();
  await ctx.prisma.attachment.deleteMany();
  await ctx.prisma.incomingEmail.deleteMany();
  await ctx.prisma.aISuggestionLog.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.system.deleteMany();
  await ctx.prisma.vendor.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@example.com', name: 'U1' } });
  mockResponse = happyPath();
});

describe('handleClassifyIncomingEmail (AI-driven)', () => {
  it('high-confidence INVOICE w/ vendor+item match → classify, log, auto-stub', async () => {
    const v = await ctx.prisma.vendor.create({
      data: { name: 'Acme HVAC', email: 'billing@acme.example' },
    });
    const item = await ctx.prisma.item.create({ data: { name: 'Heat Pump', categoryId } });
    mockResponse = {
      parsed_output: {
        kind: 'INVOICE',
        vendorId: v.id,
        targetItemId: item.id,
        targetSystemId: null,
        confidence: 'high',
        summary: 'Heat pump spring tune-up',
        cost: 185.0,
        performedOn: '2026-04-15',
        scope: 'Replaced air filter; cleaned coils.',
        rationale: 'Clear invoice from known vendor.',
      },
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    const e = await makeEmail({
      messageId: '<inv1@a>',
      subject: 'Invoice #5512 for Heat Pump service',
      bodyText: 'Amount due $185.',
    });

    await handle([{ data: { id: e.id } }]);

    const after = await ctx.prisma.incomingEmail.findUnique({
      where: { id: e.id },
      include: { targets: true, createdServiceRecord: { include: { targets: true } } },
    });
    expect(after?.kind).toBe('INVOICE');
    expect(after?.vendorId).toBe(v.id);
    expect(after?.targets).toHaveLength(1);
    expect(after?.targets[0].itemId).toBe(item.id);
    expect(after?.state).toBe('AUTO_LINKED');
    expect(after?.aiExtractedSummary).toBe('Heat pump spring tune-up');
    expect(after?.aiExtractedCost?.toString()).toBe('185');
    expect(after?.aiExtractedPerformedOn?.toISOString()).toBe('2026-04-15T00:00:00.000Z');
    expect(after?.aiExtractedScope).toContain('air filter');
    expect(after?.aiExtractedAt).not.toBeNull();

    expect(after?.createdServiceRecord).not.toBeNull();
    expect(after?.createdServiceRecord?.summary).toBe('Heat pump spring tune-up');
    expect(after?.createdServiceRecord?.notes).toBe('Replaced air filter; cleaned coils.');
    expect(after?.createdServiceRecord?.vendorId).toBe(v.id);
    expect(after?.createdServiceRecord?.performedOn.toISOString()).toBe('2026-04-15T00:00:00.000Z');
    expect(after?.createdServiceRecord?.targets).toHaveLength(1);
    expect(after?.createdServiceRecord?.targets[0].itemId).toBe(item.id);

    const logs = await ctx.prisma.aISuggestionLog.findMany({
      where: { kind: 'incoming-email-classify' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].errorReason).toBeNull();
    expect(logs[0].inputTokens).toBe(100);
  });

  it('medium confidence → classify + aiExtracted set, but NO auto-stub', async () => {
    const v = await ctx.prisma.vendor.create({
      data: { name: 'Acme HVAC', email: 'billing@acme.example' },
    });
    const item = await ctx.prisma.item.create({ data: { name: 'Heat Pump', categoryId } });
    mockResponse = {
      parsed_output: {
        kind: 'INVOICE',
        vendorId: v.id,
        targetItemId: item.id,
        targetSystemId: null,
        confidence: 'medium',
        summary: 'Heat pump service',
        cost: 185.0,
        performedOn: '2026-04-15',
        scope: 'Some work.',
        rationale: 'Vendor inferred.',
      },
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const e = await makeEmail({ messageId: '<med@a>', subject: 'Invoice for Heat Pump' });

    await handle([{ data: { id: e.id } }]);

    const after = await ctx.prisma.incomingEmail.findUnique({
      where: { id: e.id },
      include: { targets: true },
    });
    expect(after?.kind).toBe('INVOICE');
    expect(after?.vendorId).toBe(v.id);
    expect(after?.targets[0].itemId).toBe(item.id);
    expect(after?.aiExtractedSummary).toBe('Heat pump service');
    expect(after?.aiExtractedAt).not.toBeNull();
    expect(after?.createdServiceRecordId).toBeNull();
    const srCount = await ctx.prisma.serviceRecord.count();
    expect(srCount).toBe(0);
  });

  it('hallucinated vendorId → persisted null, no auto-stub', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'Heat Pump', categoryId } });
    mockResponse = {
      parsed_output: {
        kind: 'TICKET',
        vendorId: 'vendor-that-does-not-exist',
        targetItemId: item.id,
        targetSystemId: null,
        confidence: 'high',
        summary: 'work',
        cost: null,
        performedOn: null,
        scope: 'did work',
        rationale: 'hallucinated vendor',
      },
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const e = await makeEmail({ messageId: '<hall@a>', subject: 'Service report — Heat Pump' });

    await handle([{ data: { id: e.id } }]);

    const after = await ctx.prisma.incomingEmail.findUnique({
      where: { id: e.id },
      include: { targets: true },
    });
    expect(after?.kind).toBe('TICKET');
    expect(after?.vendorId).toBeNull();
    expect(after?.targets[0].itemId).toBe(item.id);
    // No vendor → shouldAutoStub false.
    expect(after?.createdServiceRecordId).toBeNull();
    const srCount = await ctx.prisma.serviceRecord.count();
    expect(srCount).toBe(0);
  });

  it('AI throws → heuristic fallback runs + error log written + no crash', async () => {
    const v = await ctx.prisma.vendor.create({
      data: { name: 'Acme HVAC', email: 'dispatch@acme.example' },
    });
    const item = await ctx.prisma.item.create({ data: { name: 'Heat Pump', categoryId } });
    mockResponse = () => {
      throw Object.assign(new Error('rate limited'), { status: 429 });
    };
    // Seed so the heuristic CAN match: vendor email = sender, subject has
    // "service ticket" + item name in body.
    const e = await makeEmail({
      messageId: '<fallback@a>',
      fromAddress: 'dispatch@acme.example',
      subject: 'Service ticket — visit complete',
      bodyText: 'Performed maintenance on the Heat Pump today.',
    });

    await expect(handle([{ data: { id: e.id } }])).resolves.toBeUndefined();

    const after = await ctx.prisma.incomingEmail.findUnique({
      where: { id: e.id },
      include: { targets: true, createdServiceRecord: { include: { targets: true } } },
    });
    // Heuristic result.
    expect(after?.kind).toBe('TICKET');
    expect(after?.vendorId).toBe(v.id);
    expect(after?.targets[0].itemId).toBe(item.id);
    expect(after?.state).toBe('AUTO_LINKED');
    // No AI extraction on the fallback path.
    expect(after?.aiExtractedAt).toBeNull();
    expect(after?.aiExtractedSummary).toBeNull();
    // Heuristic TICKET + vendor + target → auto-stub.
    expect(after?.createdServiceRecord).not.toBeNull();
    expect(after?.createdServiceRecord?.targets[0].itemId).toBe(item.id);

    // An error AISuggestionLog row with errorReason set.
    const logs = await ctx.prisma.aISuggestionLog.findMany({
      where: { kind: 'incoming-email-classify' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].errorReason).toBe('rate_limited');
    expect(logs[0].response).toBeNull();
    expect(sentryCaptured).toHaveLength(1);
  });

  it('skips a missing row without throwing', async () => {
    await expect(handle([{ data: { id: 'does-not-exist' } }])).resolves.toBeUndefined();
    expect(sentMessages).toHaveLength(0);
  });

  it('preserves user-set LINKED state instead of downgrading on re-run', async () => {
    const v = await ctx.prisma.vendor.create({
      data: { name: 'Acme HVAC', email: 'billing@acme.example' },
    });
    const item = await ctx.prisma.item.create({ data: { name: 'Heat Pump', categoryId } });
    mockResponse = {
      parsed_output: {
        kind: 'TICKET',
        vendorId: v.id,
        targetItemId: item.id,
        targetSystemId: null,
        confidence: 'high',
        summary: 's',
        cost: null,
        performedOn: null,
        scope: 's',
        rationale: 'r',
      },
      usage: {},
    };
    const sr = await ctx.prisma.serviceRecord.create({
      data: { performedOn: new Date(), summary: 'manual draft' },
    });
    const e = await ctx.prisma.incomingEmail.create({
      data: {
        messageId: '<linked@a>',
        fromAddress: 'billing@acme.example',
        subject: 'Service report — Heat Pump',
        receivedAt: new Date(),
        headersJson: {},
        state: 'LINKED',
        vendorId: v.id,
        createdServiceRecordId: sr.id,
        targets: { create: [{ itemId: item.id }] },
      },
    });

    await handle([{ data: { id: e.id } }]);

    const after = await ctx.prisma.incomingEmail.findUnique({
      where: { id: e.id },
      include: { targets: true },
    });
    expect(after?.state).toBe('LINKED');
    // Metadata still refreshes; only state + user-set targets preserved.
    expect(after?.kind).toBe('TICKET');
    expect(after?.targets).toHaveLength(1);
    expect(after?.targets[0].itemId).toBe(item.id);
    // Already linked → no second ServiceRecord.
    const srCount = await ctx.prisma.serviceRecord.count();
    expect(srCount).toBe(1);
  });
});
