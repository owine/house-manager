import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/node';
import { ANTHROPIC_MAX_TOKENS, ANTHROPIC_MODEL, getAnthropic } from '@/lib/ai/client';
import { createSuggestionLog } from '@/lib/ai/log';
import { type IncomingEmailExtraction, incomingEmailExtractionSchema } from '@/lib/ai/schemas';
import { classifyAnthropicError } from '@/lib/ai/suggest/_shared';
import { prisma } from '@/lib/db';
import { getLogger } from '@/lib/logger';

export type ExtractIncomingEmailJob = { id: string };

const log = getLogger('extract-incoming-email');

// Cap body input sent to the model. Vendor mail bodies can run long with
// tracking footers / unsubscribe boilerplate; the relevant invoice data is
// almost always in the first 4k characters.
const MAX_BODY_CHARS = 4000;

const SYSTEM_PROMPT =
  `You extract structured data from vendor service emails (invoices, work tickets, estimates) for a household maintenance app.

Goal: extract three fields from the email body — cost, date of service, and scope of work — to seed a service record. The user will edit the result before saving, so:
- prefer NULL over a guessed value when a field isn't clearly stated
- pull from explicit phrasing (e.g., "Total Due", "Service Date", "Work Performed"), not inference
- the email's send date is NOT the date of service unless explicitly stated

For "cost": the customer's grand total, including tax/fees. Subtotals, "amount due before discount", deposits, and per-line-item prices are NOT the answer.

For "performedOn": ISO date YYYY-MM-DD. The day work was done. NOT the invoice/email date if those differ.

For "scope": a brief, factual paragraph of work performed and findings. Strip pleasantries, signatures, payment links, marketing.

If the email has no narrative text but DOES have a list of line items (e.g. "Replace air filter — $25 / Clean coils — $50 / Service call — $89"), synthesize a one-paragraph scope from those line items: combine the action descriptions into a coherent sentence or two, omitting prices and quantities. Drop generic line items like "service call", "trip charge", "tax", "convenience fee" that don't describe work performed.`.trim();

function buildUserMessage(input: {
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

  // Skip when there's no body to extract from. The classify step always runs,
  // but extraction without text input produces hallucinations more than
  // useful data.
  if (!row.bodyText || row.bodyText.trim().length < 20) {
    log.info({ id: row.id }, 'extract: skipping (no useful body text)');
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

  const start = Date.now();
  let extraction: IncomingEmailExtraction;
  let usage: Record<string, number> = {};
  try {
    const result = await getAnthropic().messages.parse({
      model: ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: [{ type: 'text', text: SYSTEM_PROMPT }],
      messages: [
        {
          role: 'user',
          content: buildUserMessage({
            fromAddress: row.fromAddress,
            fromName: row.fromName,
            subject: row.subject,
            bodyText: row.bodyText,
            emailDate: row.receivedAt,
          }),
        },
      ],
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
