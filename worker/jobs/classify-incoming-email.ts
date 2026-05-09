import * as Sentry from '@sentry/node';
import { prisma } from '@/lib/db';
import { classifyEmail } from '@/lib/incoming-email/classify';
import { getLogger } from '@/lib/logger';
import { getBoss, Queue } from '@/lib/queue';

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

  const [vendors, items, systems] = await Promise.all([
    prisma.vendor.findMany({ select: { id: true, name: true, email: true, notes: true } }),
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
    fromName: row.fromName,
    subject: row.subject,
    bodyText: row.bodyText ?? '',
    vendors,
    items,
    systems,
  });

  // Persist classification metadata regardless of whether the auto-stub fires.
  // `kind` and `vendorId` are pure derived guesses and always get refreshed.
  // Targets are replace-set: drop existing AUTO-derived target rows, recreate
  // from the classifier output. We do NOT preserve manually-added targets
  // here — the user-set state (LINKED / ARCHIVED) gates whether the worker
  // owns this row at all.
  //
  // `state` is user-meaningful: if the user has already triaged (LINKED) or
  // dismissed (ARCHIVED) this email, don't reset to AUTO_LINKED/UNTRIAGED and
  // don't touch their targets either. Only transition when state is still
  // UNTRIAGED or a prior AUTO_LINKED (which a re-run is allowed to refresh).
  const ownsRow = row.state === 'UNTRIAGED' || row.state === 'AUTO_LINKED';

  await prisma.$transaction(async (tx) => {
    if (ownsRow) {
      await tx.incomingEmailTarget.deleteMany({ where: { incomingEmailId: id } });
      if (result.targets.length > 0) {
        await tx.incomingEmailTarget.createMany({
          data: result.targets.map((t) => ({
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

  // Chain the AI extractor for kinds that benefit: TICKET / INVOICE / ESTIMATE
  // bodies typically contain cost / date / scope information worth pulling.
  // UNKNOWN kind doesn't — likely not a vendor service email.
  if (result.kind === 'TICKET' || result.kind === 'INVOICE' || result.kind === 'ESTIMATE') {
    try {
      const boss = await getBoss();
      await boss.send(Queue.ExtractIncomingEmail, { id: row.id });
    } catch (err) {
      // Non-fatal: classify already wrote its metadata; user can re-extract
      // manually if they hit this rare case.
      log.warn({ err, id: row.id }, 'classify-incoming-email: extract enqueue failed');
    }
  }

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
          targets: {
            // Each classified target → one ServiceRecordTarget. v1 returns at
            // most one target so this is a single row in practice; the array
            // shape lets a future multi-target classifier just work.
            create: result.targets.map((t) => ({
              itemId: t.itemId,
              systemId: t.systemId,
            })),
          },
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
