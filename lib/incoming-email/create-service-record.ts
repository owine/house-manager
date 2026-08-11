import type { Prisma } from '@prisma/client';
import type { TransactionClient } from '@/lib/db';

/**
 * The single write that turns an inbound email into a draft `ServiceRecord`.
 *
 * Two callers reach here and they must not diverge:
 *   - `createServiceRecordFromEmail` (lib/incoming-email/actions.ts) — the
 *     "Create service record" button.
 *   - `autoStub` (worker/jobs/classify-incoming-email.ts) — the classifier's
 *     high-confidence auto-draft.
 *
 * They were separate implementations for three months, and the worker's copy
 * silently missed both of the steps below: forwarded invoices were drafted
 * with no PDF attached, and the inbox row never left the Untriaged tab.
 *
 * Lives in `lib/` (not in the `'use server'` module) because the worker's
 * runtime image copies `lib/` but not `app/`, and `revalidatePath` is
 * meaningless outside the web process. Revalidation and logging stay with the
 * callers; this function owns the transactional writes only.
 */
export type CreateServiceRecordFromEmailInput = {
  incomingEmailId: string;
  vendorId: string | null;
  /** Calendar date — already reduced to UTC midnight by the caller. */
  performedOn: Date;
  cost?: Prisma.Decimal | null;
  summary: string;
  notes: string;
  targets: Array<{ itemId: string | null; systemId: string | null }>;
};

export type CreateServiceRecordFromEmailResult = {
  serviceRecordId: string;
  attachmentsLinked: number;
};

/**
 * Must be called inside a transaction — the record, the back-link and the
 * attachment hand-off have to land together or not at all.
 */
export async function createServiceRecordForEmail(
  tx: TransactionClient,
  input: CreateServiceRecordFromEmailInput,
): Promise<CreateServiceRecordFromEmailResult> {
  const sr = await tx.serviceRecord.create({
    data: {
      vendorId: input.vendorId,
      performedOn: input.performedOn,
      cost: input.cost ?? null,
      summary: input.summary.slice(0, 200),
      notes: input.notes,
      targets: {
        create: input.targets.map((t) => ({ itemId: t.itemId, systemId: t.systemId })),
      },
    },
    select: { id: true },
  });

  // `LINKED` is what drops the row out of the Untriaged tab and the sidebar
  // badge (see `listInboxEmails` / `countUntriagedInbox`). A drafted record is
  // the completion of triage, however it was drafted.
  await tx.incomingEmail.update({
    where: { id: input.incomingEmailId },
    data: { createdServiceRecordId: sr.id, state: 'LINKED' },
  });

  // Multi-parent attachments: the same PDF/photo now shows on both the inbox
  // detail (via incomingEmailId) and the service record. Single copy on disk.
  // `serviceRecordId: null` guards against stealing a file the user already
  // attached somewhere else.
  const linked = await tx.attachment.updateMany({
    where: { incomingEmailId: input.incomingEmailId, serviceRecordId: null },
    data: { serviceRecordId: sr.id },
  });

  return { serviceRecordId: sr.id, attachmentsLinked: linked.count };
}
