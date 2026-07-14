'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { enqueueEmbed } from '@/lib/embedding/enqueue';
import { getHouseTimezone } from '@/lib/house-profile/queries';
import { getLogger } from '@/lib/logger';
import { getBoss, Queue } from '@/lib/queue';
import type { ActionResult } from '@/lib/result';
import { enqueueSearchIndex } from '@/lib/search/client';
import { targetSchema } from '@/lib/targets/schema';
import { startOfDayUtc } from '@/lib/time/tz';

const log = getLogger('incoming-email.actions');

async function requireUser() {
  const s = await auth();
  if (!s?.user?.id) return null;
  return s.user;
}

function revalidateInbox(id: string) {
  revalidatePath('/inbox');
  revalidatePath(`/inbox/${id}`);
  revalidatePath('/dashboard');
}

const attachSchema = z.object({
  id: z.string().min(1),
  vendorId: z.string().min(1).nullable().optional(),
  // `targets` may be omitted (leaves the existing target set unchanged) or be
  // an empty array (clears all links). Each target row is item XOR system,
  // enforced by `targetSchema` and re-enforced by the DB CHECK constraint.
  targets: z.array(targetSchema).optional(),
});

/**
 * Replaces the email's vendor link and/or full target set in a single
 * transaction. Pass `targets: []` to clear all links; omit `targets` to
 * leave them alone.
 *
 * State semantics:
 *   - any link present after the update → LINKED
 *   - all links cleared              → UNTRIAGED (so the row resurfaces in the
 *                                      Untriaged tab and the badge counter
 *                                      catches it)
 */
export async function attachIncomingEmail(input: unknown): Promise<ActionResult<void>> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  const parsed = attachSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { id, vendorId, targets } = parsed.data;

  const updated = await prisma.$transaction(async (tx) => {
    if (targets !== undefined) {
      // Replace-set semantics: nuke existing rows and recreate. Cheaper than
      // a per-row diff at the volumes we're dealing with (single digits).
      await tx.incomingEmailTarget.deleteMany({ where: { incomingEmailId: id } });
      if (targets.length > 0) {
        await tx.incomingEmailTarget.createMany({
          data: targets.map((t) => ({
            incomingEmailId: id,
            itemId: t.itemId ?? null,
            systemId: t.systemId ?? null,
          })),
        });
      }
    }

    // Compute post-update link state by counting target rows + vendor.
    const finalRow = await tx.incomingEmail.findUniqueOrThrow({
      where: { id },
      select: {
        vendorId: true,
        _count: { select: { targets: true } },
      },
    });
    const nextVendorId = vendorId === undefined ? finalRow.vendorId : vendorId;
    const hasAnyLink = nextVendorId !== null || finalRow._count.targets > 0;

    return tx.incomingEmail.update({
      where: { id },
      data: {
        vendorId: vendorId === undefined ? undefined : vendorId,
        state: hasAnyLink ? 'LINKED' : 'UNTRIAGED',
      },
      select: { id: true },
    });
  });

  log.info({ id: updated.id, by: u.id }, 'incoming-email: linked');
  revalidateInbox(id);
  return { ok: true, data: undefined };
}

const setKindSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['ESTIMATE', 'INVOICE', 'TICKET', 'UNKNOWN']),
});

export async function setIncomingEmailKind(input: unknown): Promise<ActionResult<void>> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  const parsed = setKindSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  await prisma.incomingEmail.update({
    where: { id: parsed.data.id },
    data: { kind: parsed.data.kind },
  });
  revalidateInbox(parsed.data.id);
  return { ok: true, data: undefined };
}

const idOnlySchema = z.object({ id: z.string().min(1) });

export async function archiveIncomingEmail(input: unknown): Promise<ActionResult<void>> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  const parsed = idOnlySchema.safeParse(input);
  if (!parsed.success) return { ok: false, formError: 'Invalid input' };
  await prisma.incomingEmail.update({
    where: { id: parsed.data.id },
    data: { archivedAt: new Date(), state: 'ARCHIVED' },
  });
  revalidateInbox(parsed.data.id);
  return { ok: true, data: undefined };
}

export async function unarchiveIncomingEmail(input: unknown): Promise<ActionResult<void>> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  const parsed = idOnlySchema.safeParse(input);
  if (!parsed.success) return { ok: false, formError: 'Invalid input' };
  // Restore to UNTRIAGED if no links are set, else LINKED — matches the
  // natural post-restore state the user would expect.
  const row = await prisma.incomingEmail.findUnique({
    where: { id: parsed.data.id },
    select: { vendorId: true, _count: { select: { targets: true } } },
  });
  if (!row) return { ok: false, formError: 'Not found' };
  const hasAnyLink = row.vendorId !== null || row._count.targets > 0;
  await prisma.incomingEmail.update({
    where: { id: parsed.data.id },
    data: { archivedAt: null, state: hasAnyLink ? 'LINKED' : 'UNTRIAGED' },
  });
  revalidateInbox(parsed.data.id);
  return { ok: true, data: undefined };
}

/**
 * Re-enqueues the classify job for one email. The worker's existing state
 * guard means it only refreshes UNTRIAGED / AUTO_LINKED rows; LINKED and
 * ARCHIVED rows are user-owned and only get a kind+vendor metadata refresh.
 *
 * UI gates the button on UNTRIAGED + AUTO_LINKED + !archived, but the action
 * accepts any state — the worker is the source of truth for what a re-run
 * is allowed to mutate.
 */
const reclassifySchema = z.object({ id: z.string().min(1) });

export async function reclassifyIncomingEmail(input: unknown): Promise<ActionResult<void>> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  const parsed = reclassifySchema.safeParse(input);
  if (!parsed.success) return { ok: false, formError: 'Invalid input' };

  const exists = await prisma.incomingEmail.findUnique({
    where: { id: parsed.data.id },
    select: { id: true },
  });
  if (!exists) return { ok: false, formError: 'Not found' };

  const boss = await getBoss();
  await boss.send(Queue.ClassifyIncomingEmail, { id: parsed.data.id });
  log.info({ id: parsed.data.id, by: u.id }, 'incoming-email: reclassify enqueued');
  // No revalidate yet — the worker writes async. The UI will pick up changes
  // on the user's next navigation, same pattern as the initial classify pass.
  return { ok: true, data: undefined };
}

/**
 * Creates a draft `ServiceRecord` from an incoming email and links it back via
 * `IncomingEmail.createdServiceRecordId`. Only fires when no draft already
 * exists for this email; the caller (UI) gates the button on the same.
 *
 * Each `IncomingEmailTarget` becomes one `ServiceRecordTarget` on the new
 * record — multi-target emails fan out cleanly. Attachments on the email
 * are also linked to the new record (multi-parent attachments mean both
 * the inbox row and the service record show the same files).
 */
const createServiceRecordSchema = z.object({ id: z.string().min(1) });

export async function createServiceRecordFromEmail(
  input: unknown,
): Promise<ActionResult<{ serviceRecordId: string }>> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  const parsed = createServiceRecordSchema.safeParse(input);
  if (!parsed.success) return { ok: false, formError: 'Invalid input' };

  const email = await prisma.incomingEmail.findUnique({
    where: { id: parsed.data.id },
    select: {
      id: true,
      subject: true,
      receivedAt: true,
      vendorId: true,
      createdServiceRecordId: true,
      aiExtractedSummary: true,
      aiExtractedCost: true,
      aiExtractedPerformedOn: true,
      aiExtractedScope: true,
      targets: { select: { itemId: true, systemId: true } },
    },
  });
  if (!email) return { ok: false, formError: 'Not found' };
  if (email.createdServiceRecordId) {
    return { ok: false, formError: 'A service record draft already exists for this email' };
  }

  // Service records can exist with vendor only (no item/system) for things
  // like landscaping or window washing. Require either a vendor link OR at
  // least one target — same rule the schema enforces server-side.
  if (!email.vendorId && email.targets.length === 0) {
    return {
      ok: false,
      formError: 'Link this email to a vendor or at least one item/system first',
    };
  }

  // AI-extracted values seed the new record when present. The user can edit
  // any of these on the ServiceRecord after creation.
  //   - summary:    extractedSummary or fall back to email subject (trimmed)
  //   - cost:       extractedCost or null
  //   - performedOn: extractedPerformedOn or fall back to email receivedAt
  //   - notes:      extractedScope, or the legacy placeholder when nothing
  //                 was extracted (still useful for the "review and edit" cue)
  const trimmedSubject = email.subject.trim();
  const summary = (
    email.aiExtractedSummary?.trim() ||
    (trimmedSubject.length > 0 ? trimmedSubject : '(no subject)')
  ).slice(0, 200);
  // `performedOn` is a calendar date. `aiExtractedPerformedOn` already is one
  // (the model returns YYYY-MM-DD), but `receivedAt` is an INSTANT -- falling back
  // to it raw filed an email received at 8pm Chicago under TOMORROW's date, and
  // /service filters `performedOn: { lte: <UTC midnight> }` then silently excluded
  // the record from a range that should contain it.
  const performedOn =
    email.aiExtractedPerformedOn ?? startOfDayUtc(email.receivedAt, await getHouseTimezone());
  const notes = email.aiExtractedScope ?? '[Created from inbound email — review and edit.]';

  const created = await prisma.$transaction(async (tx) => {
    const sr = await tx.serviceRecord.create({
      data: {
        vendorId: email.vendorId,
        performedOn,
        cost: email.aiExtractedCost,
        summary,
        notes,
        targets: {
          create: email.targets.map((t) => ({
            itemId: t.itemId,
            systemId: t.systemId,
          })),
        },
      },
      select: { id: true },
    });
    await tx.incomingEmail.update({
      where: { id: email.id },
      data: { createdServiceRecordId: sr.id, state: 'LINKED' },
    });
    // Link the email's attachments to the new ServiceRecord too. Multi-parent
    // attachments mean the same PDF/photo shows up in both the inbox detail
    // (still tied to the email) and the service record (tied via this update).
    // Single source of truth on disk; no file copy.
    const attachLink = await tx.attachment.updateMany({
      where: { incomingEmailId: email.id, serviceRecordId: null },
      data: { serviceRecordId: sr.id },
    });
    return { sr, attachmentsLinked: attachLink.count };
  });
  await enqueueSearchIndex('service', created.sr.id, 'upsert');
  await enqueueEmbed('SERVICE_RECORD', created.sr.id);
  log.info(
    {
      incomingEmailId: email.id,
      serviceRecordId: created.sr.id,
      targetCount: email.targets.length,
      attachmentsLinked: created.attachmentsLinked,
      by: u.id,
    },
    'incoming-email: service record created',
  );
  revalidateInbox(email.id);
  revalidatePath('/service');
  return { ok: true, data: { serviceRecordId: created.sr.id } };
}
