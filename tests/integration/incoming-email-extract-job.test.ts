import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let filesDir = '';
vi.mock('@/lib/env', () => ({
  getEnv: vi.fn(() => ({ FILES_DIR: filesDir })),
}));

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
  filesDir = mkdtempSync(join(tmpdir(), 'extract-test-'));
  const mod = await import('@/worker/jobs/extract-incoming-email');
  handle = mod.handleExtractIncomingEmail;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  sentMessages.length = 0;
  await ctx.prisma.attachment.deleteMany();
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

  it('attaches PDF documents as content blocks when present', async () => {
    const e = await makeEmail({ messageId: '<pdf1@a>' });
    // Write a fake PDF byte to the FILES_DIR and link it as an attachment.
    const pdfDir = join(filesDir, 'pdfs', e.id);
    mkdirSync(pdfDir, { recursive: true });
    const pdfPath = join('pdfs', e.id, 'invoice.pdf');
    writeFileSync(join(filesDir, pdfPath), Buffer.from('%PDF-1.4 fake'));
    await ctx.prisma.attachment.create({
      data: {
        incomingEmailId: e.id,
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 13,
        storagePath: pdfPath,
        uploadedById: 'u1',
      },
    });
    await handle([{ data: { id: e.id } }]);

    expect(sentMessages).toHaveLength(1);
    const sent = sentMessages[0] as { messages: Array<{ content: unknown }> };
    const content = sent.messages[0].content as Array<{
      type: string;
      source?: { media_type: string };
    }>;
    // First block is the document, second is the user-text block.
    expect(content[0].type).toBe('document');
    expect(content[0].source?.media_type).toBe('application/pdf');
    expect(content[1].type).toBe('text');
  });

  it('extracts from a PDF-only email (body says "see attached")', async () => {
    const e = await makeEmail({
      messageId: '<pdfonly@a>',
      bodyText: 'See attached invoice.', // intentionally short
    });
    const pdfDir = join(filesDir, 'pdfs', e.id);
    mkdirSync(pdfDir, { recursive: true });
    const pdfPath = join('pdfs', e.id, 'inv.pdf');
    writeFileSync(join(filesDir, pdfPath), Buffer.from('%PDF-1.4 fake'));
    await ctx.prisma.attachment.create({
      data: {
        incomingEmailId: e.id,
        filename: 'inv.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 13,
        storagePath: pdfPath,
        uploadedById: 'u1',
      },
    });
    await handle([{ data: { id: e.id } }]);
    // Even though body is "see attached", the PDF triggers the model call
    // and we persist whatever the (mocked) model returns.
    const after = await ctx.prisma.incomingEmail.findUnique({ where: { id: e.id } });
    expect(after?.aiExtractedAt).not.toBeNull();
    expect(sentMessages).toHaveLength(1);
  });

  it('skips non-PDF attachments (images etc.)', async () => {
    const e = await makeEmail({ messageId: '<img@a>' });
    const dir = join(filesDir, 'imgs', e.id);
    mkdirSync(dir, { recursive: true });
    const path = join('imgs', e.id, 'photo.jpg');
    writeFileSync(join(filesDir, path), Buffer.from([0xff, 0xd8, 0xff]));
    await ctx.prisma.attachment.create({
      data: {
        incomingEmailId: e.id,
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 3,
        storagePath: path,
        uploadedById: 'u1',
      },
    });
    await handle([{ data: { id: e.id } }]);
    const sent = sentMessages[0] as { messages: Array<{ content: unknown }> };
    const content = sent.messages[0].content as Array<{ type: string }>;
    // No document blocks — only the text block.
    expect(content.filter((c) => c.type === 'document')).toHaveLength(0);
    expect(content.some((c) => c.type === 'text')).toBe(true);
  });

  it('skips PDFs over the 10MB per-file cap', async () => {
    const e = await makeEmail({ messageId: '<huge@a>' });
    const dir = join(filesDir, 'pdfs', e.id);
    mkdirSync(dir, { recursive: true });
    const path = join('pdfs', e.id, 'huge.pdf');
    writeFileSync(join(filesDir, path), Buffer.from('%PDF-1.4'));
    await ctx.prisma.attachment.create({
      data: {
        incomingEmailId: e.id,
        filename: 'huge.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 11 * 1024 * 1024, // > MAX_PDF_BYTES; sizeBytes drives the gate
        storagePath: path,
        uploadedById: 'u1',
      },
    });
    await handle([{ data: { id: e.id } }]);
    const sent = sentMessages[0] as { messages: Array<{ content: unknown }> };
    const content = sent.messages[0].content as Array<{ type: string }>;
    expect(content.filter((c) => c.type === 'document')).toHaveLength(0);
  });

  it('extracts from a PDF-only email even with no body text at all', async () => {
    const e = await ctx.prisma.incomingEmail.create({
      data: {
        messageId: '<bodylessPdf@a>',
        fromAddress: 'a@a',
        subject: 'Invoice',
        bodyText: null,
        receivedAt: new Date(),
        headersJson: {},
        kind: 'INVOICE',
      },
    });
    const dir = join(filesDir, 'pdfs', e.id);
    mkdirSync(dir, { recursive: true });
    const path = join('pdfs', e.id, 'inv.pdf');
    writeFileSync(join(filesDir, path), Buffer.from('%PDF-1.4 fake'));
    await ctx.prisma.attachment.create({
      data: {
        incomingEmailId: e.id,
        filename: 'inv.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 13,
        storagePath: path,
        uploadedById: 'u1',
      },
    });
    await handle([{ data: { id: e.id } }]);
    expect(sentMessages).toHaveLength(1);
    const after = await ctx.prisma.incomingEmail.findUnique({ where: { id: e.id } });
    expect(after?.aiExtractedAt).not.toBeNull();
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
