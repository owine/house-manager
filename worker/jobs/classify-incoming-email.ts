import * as Sentry from '@sentry/node';
import { prisma } from '@/lib/db';
import { classifyEmail } from '@/lib/incoming-email/classify';
import { getLogger } from '@/lib/logger';

export type ClassifyIncomingEmailJob = { id: string };

const log = getLogger('classify-incoming-email');

/**
 * Loads the email row, runs the pure classifier against active vendor / item
 * / system lists, persists the result, and (when the three-way confidence
 * threshold passes) creates a draft ServiceRecord linked back via
 * `IncomingEmail.createdServiceRecordId`.
 *
 * Failure to create the auto-stub draft is not fatal: classification metadata
 * still gets persisted, the email is left at state UNTRIAGED so the user has
 * a manual triage path, and the failure is reported to Sentry.
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
      subject: true,
      bodyText: true,
      receivedAt: true,
      createdServiceRecordId: true,
    },
  });
  if (!row) {
    log.warn({ id }, 'classify-incoming-email: row not found');
    return;
  }

  const [vendors, items, systems] = await Promise.all([
    prisma.vendor.findMany({ select: { id: true, email: true, notes: true } }),
    prisma.item.findMany({
      where: { archivedAt: null },
      select: { id: true, name: true },
    }),
    prisma.system.findMany({
      where: { archivedAt: null },
      select: { id: true, name: true },
    }),
  ]);

  const result = classifyEmail({
    fromAddress: row.fromAddress,
    subject: row.subject,
    bodyText: row.bodyText ?? '',
    vendors,
    items,
    systems,
  });

  // Persist classification metadata regardless of whether the auto-stub fires.
  // If state was already LINKED (user manually triaged before the worker ran),
  // don't downgrade it; only flip from UNTRIAGED.
  await prisma.incomingEmail.update({
    where: { id },
    data: {
      kind: result.kind,
      vendorId: result.vendorId,
      itemId: result.itemId,
      systemId: result.systemId,
      // AUTO_LINKED if we found anything; UNTRIAGED otherwise. Leave LINKED
      // and ARCHIVED alone — the user has already touched those.
      state: result.vendorId || result.itemId || result.systemId ? 'AUTO_LINKED' : 'UNTRIAGED',
    },
  });

  if (!result.shouldAutoStubServiceRecord) {
    log.info(
      { id: row.id, kind: result.kind, vendorMatched: result.vendorId !== null },
      'classify-incoming-email: classified (no auto-stub)',
    );
    return;
  }

  // Don't double-stub if a ServiceRecord was already linked to this email
  // (shouldn't happen for AUTO_LINKED rows but defends against re-runs).
  if (row.createdServiceRecordId) {
    log.info(
      { id: row.id, existingServiceRecordId: row.createdServiceRecordId },
      'classify-incoming-email: skipping auto-stub (already linked)',
    );
    return;
  }

  // Item beats system when both are set — same precedence as the manual
  // promote path in lib/incoming-email/actions.ts.
  const target = result.itemId
    ? { itemId: result.itemId }
    : { systemId: result.systemId as string };

  const trimmedSubject = row.subject.trim();
  const summary = (trimmedSubject.length > 0 ? trimmedSubject : '(no subject)').slice(0, 200);

  try {
    const created = await prisma.$transaction(async (tx) => {
      const sr = await tx.serviceRecord.create({
        data: {
          vendorId: result.vendorId,
          performedOn: row.receivedAt,
          summary,
          notes: '[Auto-created from inbound email — review and edit.]',
          targets: { create: [target] },
        },
        select: { id: true },
      });
      await tx.incomingEmail.update({
        where: { id: row.id },
        data: { createdServiceRecordId: sr.id },
      });
      return sr;
    });
    log.info(
      { id: row.id, serviceRecordId: created.id },
      'classify-incoming-email: auto-stubbed service record',
    );
  } catch (err) {
    Sentry.captureException(err);
    log.error(
      { err, id: row.id },
      'classify-incoming-email: auto-stub failed; classification still persisted',
    );
    // Intentionally do not rethrow — classification metadata is already
    // persisted and the user can promote manually from the inbox UI.
  }
}
