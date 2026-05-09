import { readFile } from 'node:fs/promises';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/node';
import { ANTHROPIC_MAX_TOKENS, ANTHROPIC_MODEL, getAnthropic } from '@/lib/ai/client';
import { createSuggestionLog } from '@/lib/ai/log';
import { type IncomingEmailExtraction, incomingEmailExtractionSchema } from '@/lib/ai/schemas';
import { classifyAnthropicError } from '@/lib/ai/suggest/_shared';
import { resolveStoragePath } from '@/lib/attachments/storage';
import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';

export type ExtractIncomingEmailJob = { id: string };

const log = getLogger('extract-incoming-email');

// Cap body input sent to the model. Vendor mail bodies can run long with
// tracking footers / unsubscribe boilerplate; the relevant invoice data is
// almost always in the first 4k characters.
const MAX_BODY_CHARS = 4000;

// Keep PDF attachment input bounded so a single email with a huge invoice
// can't drive token usage off a cliff. Anthropic charges per-page on
// documents (~1500-3000 tokens / page); these caps assume ~5-page PDFs.
// Any PDF over MAX_PDF_BYTES is skipped (the model would still accept it,
// but the input cost is hard to justify for the marginal extraction gain).
const MAX_PDF_ATTACHMENTS = 5;
const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB per PDF
const MAX_TOTAL_PDF_BYTES = 25 * 1024 * 1024; // 25 MB across all attachments

const SYSTEM_PROMPT =
  `You extract structured data from vendor service emails (invoices, work tickets, estimates) for a household maintenance app.

Goal: extract three fields from the email — cost, date of service, and scope of work — to seed a service record. The user will edit the result before saving, so:
- prefer NULL over a guessed value when a field isn't clearly stated
- pull from explicit phrasing (e.g., "Total Due", "Service Date", "Work Performed"), not inference
- the email's send date is NOT the date of service unless explicitly stated

The email body is provided as text below. PDF attachments (when present) are provided as document content blocks ABOVE the email metadata; their content is authoritative when the body is sparse — many vendors send a generic body like "see attached invoice" with all structured data only in the PDF.

For "cost": the customer's grand total, including tax/fees. Subtotals, "amount due before discount", deposits, and per-line-item prices are NOT the answer.

For "performedOn": ISO date YYYY-MM-DD. The day work was done. NOT the invoice/email date if those differ.

For "scope": a brief, factual paragraph of work performed and findings. Strip pleasantries, signatures, payment links, marketing.

If the email body has no narrative text but DOES have a list of line items (in body OR PDF) like "Replace air filter — $25 / Clean coils — $50 / Service call — $89", synthesize a one-paragraph scope from those line items: combine the action descriptions into a coherent sentence or two, omitting prices and quantities. Drop generic line items like "service call", "trip charge", "tax", "convenience fee" that don't describe work performed.`.trim();

function buildUserText(input: {
  fromAddress: string;
  fromName: string | null;
  subject: string;
  bodyText: string;
  emailDate: Date;
}): string {
  const sender = input.fromName ? `${input.fromName} <${input.fromAddress}>` : input.fromAddress;
  return `Email metadata
From: ${sender}
Subject: ${input.subject || '(no subject)'}
Email date: ${input.emailDate.toISOString().slice(0, 10)}

Body (truncated):
"""
${input.bodyText.slice(0, MAX_BODY_CHARS)}
"""

Extract cost / performedOn / scope.`;
}

type LoadedPdf = { filename: string; base64: string; bytes: number };

/**
 * Read up to MAX_PDF_ATTACHMENTS PDFs off disk, base64-encode each, and
 * return them ready for the messages.parse `document` content blocks. Caps
 * per-file size and aggregate size to keep token usage bounded.
 *
 * Non-PDF attachments are skipped — Anthropic supports image attachments
 * via a different content-block type, but vendor invoices in PDF form
 * cover the immediate use case. Adding image support would be a follow-up.
 */
async function loadPdfAttachments(emailId: string): Promise<LoadedPdf[]> {
  const env = getEnv();
  const rows = await prisma.attachment.findMany({
    where: { incomingEmailId: emailId, mimeType: 'application/pdf' },
    select: { filename: true, sizeBytes: true, storagePath: true },
    orderBy: { createdAt: 'asc' },
  });

  const out: LoadedPdf[] = [];
  let runningBytes = 0;
  for (const a of rows) {
    if (out.length >= MAX_PDF_ATTACHMENTS) break;
    if (!a.storagePath) continue;
    const size = a.sizeBytes ?? 0;
    if (size > MAX_PDF_BYTES) {
      log.warn(
        { emailId, filename: a.filename, sizeBytes: size, cap: MAX_PDF_BYTES },
        'extract: skipping PDF over per-file cap',
      );
      continue;
    }
    if (runningBytes + size > MAX_TOTAL_PDF_BYTES) {
      log.warn(
        { emailId, filename: a.filename, runningBytes, cap: MAX_TOTAL_PDF_BYTES },
        'extract: skipping PDF; aggregate cap reached',
      );
      continue;
    }
    try {
      const abs = resolveStoragePath(env.FILES_DIR, a.storagePath);
      const buf = await readFile(abs);
      out.push({
        filename: a.filename ?? 'attachment.pdf',
        base64: buf.toString('base64'),
        bytes: buf.byteLength,
      });
      runningBytes += buf.byteLength;
    } catch (err) {
      log.warn(
        { err, emailId, filename: a.filename, storagePath: a.storagePath },
        'extract: failed to read PDF attachment',
      );
    }
  }
  return out;
}

export async function handleExtractIncomingEmail(
  jobs: { data: ExtractIncomingEmailJob }[],
): Promise<void> {
  for (const { data } of jobs) {
    await extractOne(data.id);
  }
}

async function extractOne(id: string): Promise<void> {
  const row = await prisma.incomingEmail.findUnique({
    where: { id },
    select: {
      id: true,
      fromAddress: true,
      fromName: true,
      subject: true,
      bodyText: true,
      receivedAt: true,
      kind: true,
    },
  });
  if (!row) {
    log.warn({ id }, 'extract: row not found');
    return;
  }

  // Load PDF attachments before deciding to skip on body length: a PDF-only
  // invoice (body = "see attached") is exactly the case extraction needs to
  // handle. Skip when the row has neither useful body text NOR PDFs.
  const pdfs = await loadPdfAttachments(row.id);
  const bodyHasText = !!row.bodyText && row.bodyText.trim().length >= 20;
  if (!bodyHasText && pdfs.length === 0) {
    log.info({ id: row.id }, 'extract: skipping (no useful body and no PDFs)');
    return;
  }

  // Identify the system user for the AI log; matches the inbox-ingest pattern.
  const systemUser = await prisma.user.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!systemUser) {
    log.warn({ id: row.id }, 'extract: no user to attribute log to; skipping');
    return;
  }

  const userText = buildUserText({
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    subject: row.subject,
    bodyText: row.bodyText ?? '(no body)',
    emailDate: row.receivedAt,
  });

  // Build content blocks: documents first (Anthropic recommends putting
  // documents BEFORE the user's instruction text for best results), then
  // the metadata + body text.
  const content: Array<
    | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }
    | { type: 'text'; text: string }
  > = [];
  for (const pdf of pdfs) {
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: pdf.base64 },
    });
  }
  content.push({ type: 'text', text: userText });

  const start = Date.now();
  let extraction: IncomingEmailExtraction;
  let usage: Record<string, number> = {};
  try {
    const result = await getAnthropic().messages.parse({
      model: ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: [{ type: 'text', text: SYSTEM_PROMPT }],
      messages: [{ role: 'user', content }],
      output_config: { format: zodOutputFormat(incomingEmailExtractionSchema) },
    } as never);
    extraction = (result as { parsed_output: IncomingEmailExtraction }).parsed_output;
    usage = (result as unknown as { usage?: Record<string, number> }).usage ?? {};
  } catch (e) {
    const errorReason = classifyAnthropicError(e);
    Sentry.captureException(e);
    await createSuggestionLog({
      userId: systemUser.id,
      kind: 'incoming-email-extract',
      userPrompt: row.id,
      inventorySnapshotIds: [],
      response: null,
      errorReason,
      model: ANTHROPIC_MODEL,
      latencyMs: Date.now() - start,
    });
    log.error({ err: e, id: row.id, errorReason }, 'extract: anthropic call failed');
    return; // Non-fatal: row stays without extraction; user can re-extract.
  }

  // Validate performedOn parses to a sensible date. The schema typed it as
  // string but the model occasionally returns malformed dates; we prefer null
  // over a wrong Date in the DB.
  let performedOn: Date | null = null;
  if (extraction.performedOn) {
    const parsed = new Date(`${extraction.performedOn}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) performedOn = parsed;
  }

  const aiLog = await createSuggestionLog({
    userId: systemUser.id,
    kind: 'incoming-email-extract',
    userPrompt: row.id,
    inventorySnapshotIds: [],
    response: extraction as unknown as Prisma.InputJsonValue,
    model: ANTHROPIC_MODEL,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
    latencyMs: Date.now() - start,
  });

  await prisma.incomingEmail.update({
    where: { id: row.id },
    data: {
      aiExtractedSummary: extraction.summary,
      aiExtractedCost: extraction.cost,
      aiExtractedPerformedOn: performedOn,
      aiExtractedScope: extraction.scope,
      aiExtractedAt: new Date(),
    },
  });

  log.info(
    {
      id: row.id,
      kind: row.kind,
      pdfCount: pdfs.length,
      pdfBytes: pdfs.reduce((sum, p) => sum + p.bytes, 0),
      hasSummary: extraction.summary !== null,
      hasCost: extraction.cost !== null,
      hasPerformedOn: performedOn !== null,
      hasScope: extraction.scope !== null,
      latencyMs: Date.now() - start,
      aiLogId: aiLog.id,
    },
    'extract: ok',
  );
}
