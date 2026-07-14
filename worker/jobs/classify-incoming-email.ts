import type { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/node';
import { ANTHROPIC_MODEL } from '@/lib/ai/client';
import { createSuggestionLog } from '@/lib/ai/log';
import { classifyAnthropicError } from '@/lib/ai/suggest/_shared';
import { prisma } from '@/lib/db';
import { enqueueEmbed } from '@/lib/embedding/enqueue';
import { getHouseTimezone } from '@/lib/house-profile/queries';
import {
  aiClassifyExtract,
  shouldAutoStub,
  validateCandidateIds,
} from '@/lib/incoming-email/ai-classify';
import { classifyEmail } from '@/lib/incoming-email/classify';
import { loadPdfAttachments } from '@/lib/incoming-email/pdf-attachments';
import { loadPdfTextForEmail } from '@/lib/incoming-email/pdf-text';
import { getLogger } from '@/lib/logger';
import { enqueueSearchIndex } from '@/lib/search/client';
import { startOfDayUtc } from '@/lib/time/tz';

export type ClassifyIncomingEmailJob = { id: string };

const log = getLogger('classify-incoming-email');

type ClassifyTarget = { itemId: string | null; systemId: string | null };

/**
 * Single AI-driven classify+extract job for inbound emails.
 *
 * One Anthropic call both classifies the email (kind / vendor / target) and
 * extracts the service details (cost / date / scope). The validated result is
 * persisted as classification metadata + aiExtracted* fields, and — when the
 * confidence threshold passes — a draft ServiceRecord is auto-stubbed and
 * linked back via `IncomingEmail.createdServiceRecordId`.
 *
 * If the model call fails, the heuristic classifier (`classifyEmail`) runs as
 * a fallback: it persists kind / vendor / targets (no aiExtracted*) and honors
 * its own auto-stub rule. Failures are non-fatal — an error AISuggestionLog
 * row is written, Sentry is notified, and the batch continues.
 */
export async function handleClassifyIncomingEmail(
  jobs: { data: ClassifyIncomingEmailJob }[],
): Promise<void> {
  for (const { data } of jobs) {
    await classifyOne(data.id);
  }
}

async function classifyOne(id: string): Promise<void> {
  const row = await prisma.incomingEmail.findUnique({
    where: { id },
    select: {
      id: true,
      fromAddress: true,
      fromName: true,
      subject: true,
      bodyText: true,
      receivedAt: true,
      state: true,
      createdServiceRecordId: true,
    },
  });
  if (!row) {
    log.warn({ id }, 'classify-incoming-email: row not found');
    return;
  }

  const [vendors, items, systems, pdfText, pdfs] = await Promise.all([
    prisma.vendor.findMany({ select: { id: true, name: true, email: true, notes: true } }),
    prisma.item.findMany({ where: { archivedAt: null }, select: { id: true, name: true } }),
    prisma.system.findMany({ where: { archivedAt: null }, select: { id: true, name: true } }),
    loadPdfTextForEmail(id),
    loadPdfAttachments(id),
  ]);

  // Augment the body the classifier sees with text extracted from any PDF
  // attachments. Many vendor reports / invoices use a boilerplate email body
  // ("Attached is your invoice") with the substantive content locked inside a
  // PDF — without this, the classifier never sees the keywords that drive
  // kind / vendor / entity matching. (The AI path additionally receives the
  // raw PDFs as document blocks; this augmented text is what the heuristic
  // fallback — and the AI prompt's text body — see.)
  const augmentedBody = pdfText
    ? `${row.bodyText ?? ''}\n\n--- attached PDF text ---\n${pdfText}`
    : (row.bodyText ?? '');

  // Identify the system user for the AI log; matches the inbox-ingest pattern.
  // Skip when there is no user to attribute the log to.
  const systemUser = await prisma.user.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!systemUser) {
    log.warn({ id: row.id }, 'classify-incoming-email: no user to attribute log to; skipping');
    return;
  }

  // `state` is user-meaningful: if the user has already triaged (LINKED) or
  // dismissed (ARCHIVED) this email, don't reset to AUTO_LINKED/UNTRIAGED and
  // don't touch their targets either. Only transition when state is still
  // UNTRIAGED or a prior AUTO_LINKED (which a re-run is allowed to refresh).
  const ownsRow = row.state === 'UNTRIAGED' || row.state === 'AUTO_LINKED';

  const start = Date.now();
  try {
    const { result, usage } = await aiClassifyExtract({
      fromAddress: row.fromAddress,
      fromName: row.fromName,
      subject: row.subject,
      bodyText: augmentedBody,
      // `receivedAt` is an INSTANT; the prompt renders it as a UTC day. An email
      // received at 8pm Chicago would tell the model "Email date: <tomorrow>",
      // and the model's answer feeds aiExtractedPerformedOn -> ServiceRecord.
      // Reduce it to the house day first.
      emailDate: startOfDayUtc(row.receivedAt, await getHouseTimezone()),
      vendors,
      items,
      systems,
      pdfs,
    });

    const { vendorId, targetItemId, targetSystemId } = validateCandidateIds(
      {
        vendorId: result.vendorId,
        targetItemId: result.targetItemId,
        targetSystemId: result.targetSystemId,
      },
      { vendors, items, systems },
    );

    // Map validated ids → one target (item XOR system); empty if neither.
    const targets: ClassifyTarget[] = [];
    if (targetItemId) targets.push({ itemId: targetItemId, systemId: null });
    else if (targetSystemId) targets.push({ itemId: null, systemId: targetSystemId });

    await createSuggestionLog({
      userId: systemUser.id,
      kind: 'incoming-email-classify',
      userPrompt: row.id,
      inventorySnapshotIds: [],
      response: result as unknown as Prisma.InputJsonValue,
      model: ANTHROPIC_MODEL,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens,
      latencyMs: Date.now() - start,
    });

    // Validate performedOn parses to a sensible date. Schema typed it as a
    // string but the model occasionally returns malformed dates; prefer null
    // over a wrong Date in the DB.
    let aiPerformedOn: Date | null = null;
    if (result.performedOn) {
      const parsed = new Date(`${result.performedOn}T00:00:00Z`);
      if (!Number.isNaN(parsed.getTime())) aiPerformedOn = parsed;
    }

    await prisma.$transaction(async (tx) => {
      if (ownsRow) {
        await tx.incomingEmailTarget.deleteMany({ where: { incomingEmailId: id } });
        if (targets.length > 0) {
          await tx.incomingEmailTarget.createMany({
            data: targets.map((t) => ({
              incomingEmailId: id,
              itemId: t.itemId,
              systemId: t.systemId,
            })),
          });
        }
      }

      await tx.incomingEmail.update({
        where: { id },
        data: {
          kind: result.kind,
          vendorId,
          aiExtractedSummary: result.summary,
          aiExtractedCost: result.cost,
          aiExtractedPerformedOn: aiPerformedOn,
          aiExtractedScope: result.scope,
          aiExtractedAt: new Date(),
          ...(ownsRow
            ? {
                state:
                  vendorId || targets.length > 0
                    ? ('AUTO_LINKED' as const)
                    : ('UNTRIAGED' as const),
              }
            : {}),
        },
      });
    });

    if (
      shouldAutoStub({
        kind: result.kind,
        vendorId,
        targetItemId,
        targetSystemId,
        confidence: result.confidence,
      }) &&
      !row.createdServiceRecordId
    ) {
      await autoStub({
        rowId: row.id,
        vendorId,
        targets,
        // `receivedAt` is an instant. Reduce it to the house day, or an email
        // received at 8pm Chicago files the service record under TOMORROW.
        performedOn: aiPerformedOn ?? startOfDayUtc(row.receivedAt, await getHouseTimezone()),
        summary: result.summary ?? fallbackSummary(row.subject),
        notes: result.scope ?? AUTO_NOTE,
      });
    } else {
      log.info(
        {
          id: row.id,
          kind: result.kind,
          confidence: result.confidence,
          vendorMatched: vendorId !== null,
        },
        'classify-incoming-email: AI classified (no auto-stub)',
      );
    }
  } catch (aiErr) {
    const errorReason = classifyAnthropicError(aiErr);
    Sentry.captureException(aiErr);
    await createSuggestionLog({
      userId: systemUser.id,
      kind: 'incoming-email-classify',
      userPrompt: row.id,
      inventorySnapshotIds: [],
      response: null,
      errorReason,
      model: ANTHROPIC_MODEL,
      latencyMs: Date.now() - start,
    });
    log.warn(
      { err: aiErr, id: row.id, errorReason },
      'classify-incoming-email: AI call failed; falling back to heuristic',
    );
    await heuristicFallback(row, { vendors, items, systems }, augmentedBody, ownsRow);
  }
}

const AUTO_NOTE = '[Auto-created from inbound email — review and edit.]';

function fallbackSummary(subject: string): string {
  const trimmed = subject.trim();
  return (trimmed.length > 0 ? trimmed : '(no subject)').slice(0, 200);
}

/**
 * Create a draft ServiceRecord from the classified email and link it back via
 * `createdServiceRecordId`. Failure is non-fatal: classification metadata is
 * already persisted, so we log + report to Sentry and do not rethrow.
 */
async function autoStub(input: {
  rowId: string;
  vendorId: string | null;
  targets: ClassifyTarget[];
  performedOn: Date;
  summary: string;
  notes: string;
}): Promise<void> {
  try {
    const created = await prisma.$transaction(async (tx) => {
      const sr = await tx.serviceRecord.create({
        data: {
          vendorId: input.vendorId,
          performedOn: input.performedOn,
          summary: input.summary.slice(0, 200),
          notes: input.notes,
          targets: {
            create: input.targets.map((t) => ({ itemId: t.itemId, systemId: t.systemId })),
          },
        },
        select: { id: true },
      });
      await tx.incomingEmail.update({
        where: { id: input.rowId },
        data: { createdServiceRecordId: sr.id },
      });
      return sr;
    });
    await enqueueSearchIndex('service', created.id, 'upsert');
    await enqueueEmbed('SERVICE_RECORD', created.id);
    log.info(
      { id: input.rowId, serviceRecordId: created.id },
      'classify-incoming-email: auto-stubbed service record',
    );
  } catch (err) {
    Sentry.captureException(err);
    log.error(
      { err, id: input.rowId },
      'classify-incoming-email: auto-stub failed; classification still persisted',
    );
    // Intentionally do not rethrow.
  }
}

/**
 * Heuristic fallback used when the AI call fails. Persists kind / vendor /
 * targets through the same ownsRow transaction (no aiExtracted*), and honors
 * the heuristic's own auto-stub rule.
 */
async function heuristicFallback(
  row: {
    id: string;
    fromAddress: string;
    fromName: string | null;
    subject: string;
    receivedAt: Date;
    createdServiceRecordId: string | null;
  },
  candidates: {
    vendors: Array<{ id: string; name: string; email: string | null; notes: string | null }>;
    items: Array<{ id: string; name: string }>;
    systems: Array<{ id: string; name: string }>;
  },
  augmentedBody: string,
  ownsRow: boolean,
): Promise<void> {
  const result = classifyEmail({
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    subject: row.subject,
    bodyText: augmentedBody,
    vendors: candidates.vendors,
    items: candidates.items,
    systems: candidates.systems,
  });

  await prisma.$transaction(async (tx) => {
    if (ownsRow) {
      await tx.incomingEmailTarget.deleteMany({ where: { incomingEmailId: row.id } });
      if (result.targets.length > 0) {
        await tx.incomingEmailTarget.createMany({
          data: result.targets.map((t) => ({
            incomingEmailId: row.id,
            itemId: t.itemId,
            systemId: t.systemId,
          })),
        });
      }
    }
    await tx.incomingEmail.update({
      where: { id: row.id },
      data: {
        kind: result.kind,
        vendorId: result.vendorId,
        ...(ownsRow
          ? {
              state:
                result.vendorId || result.targets.length > 0
                  ? ('AUTO_LINKED' as const)
                  : ('UNTRIAGED' as const),
            }
          : {}),
      },
    });
  });

  if (result.shouldAutoStubServiceRecord && !row.createdServiceRecordId) {
    await autoStub({
      rowId: row.id,
      vendorId: result.vendorId,
      targets: result.targets,
      performedOn: startOfDayUtc(row.receivedAt, await getHouseTimezone()),
      summary: fallbackSummary(row.subject),
      notes: AUTO_NOTE,
    });
  } else {
    log.info(
      { id: row.id, kind: result.kind, vendorMatched: result.vendorId !== null },
      'classify-incoming-email: heuristic classified (no auto-stub)',
    );
  }
}
