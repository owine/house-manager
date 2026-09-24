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
  /**
   * Attachments this call re-parented onto the new record. Their embedded text
   * names the parent, so callers must enqueue an ATTACHMENT re-embed for each
   * after the transaction commits (not inside it, where the job could read the
   * pre-commit row).
   */
  linkedAttachmentIds: string[];
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
  // The EMAIL owns the row; serviceRecordId is only a link — see
  // detachEmailOwnedAttachments below, which every service-record delete runs
  // first. `serviceRecordId: null` guards against stealing a file the user
  // already attached somewhere else, and is also what lets a re-draft (after
  // the first draft was deleted) pick the same files back up.
  const linked = await tx.attachment.updateManyAndReturn({
    where: { incomingEmailId: input.incomingEmailId, serviceRecordId: null },
    data: { serviceRecordId: sr.id },
    select: { id: true },
  });

  return {
    serviceRecordId: sr.id,
    attachmentsLinked: linked.length,
    linkedAttachmentIds: linked.map((a) => a.id),
  };
}

/**
 * The inverse of the hand-off in `createServiceRecordForEmail`, run before a
 * service record is deleted.
 *
 * Ownership rule: an attachment with `incomingEmailId` set belongs to the
 * email, and its `serviceRecordId` is only a link. Both FKs are
 * `onDelete: Cascade` (prisma/schema.prisma, model Attachment), so without
 * this, deleting a drafted record cascade-deleted the email's original
 * invoice — auto-stub drafts, the user bins the draft, the source PDF is gone.
 *
 * Must run in the same transaction as the delete. Returns the detached rows so
 * the caller can re-index them after commit: their search parent moves from
 * the record back to the email.
 */
export async function detachEmailOwnedAttachments(
  tx: TransactionClient,
  serviceRecordId: string,
): Promise<Array<{ id: string; incomingEmailId: string }>> {
  const owned = await tx.attachment.findMany({
    where: { serviceRecordId, incomingEmailId: { not: null } },
    select: { id: true, incomingEmailId: true },
  });
  if (owned.length === 0) return [];
  await tx.attachment.updateMany({
    where: { id: { in: owned.map((a) => a.id) } },
    data: { serviceRecordId: null },
  });
  return owned.map((a) => ({ id: a.id, incomingEmailId: a.incomingEmailId as string }));
}
