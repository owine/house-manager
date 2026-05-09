'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getLogger } from '@/lib/logger';
import type { ActionResult } from '@/lib/result';
import { targetSchema } from '@/lib/targets/schema';

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
 * Creates a draft `ServiceRecord` from an incoming email and links it back via
 * `IncomingEmail.createdServiceRecordId`. Only fires when no draft already
 * exists for this email; the caller (UI) gates the button on the same.
 *
 * Each `IncomingEmailTarget` becomes one `ServiceRecordTarget` on the new
 * record — multi-target emails fan out cleanly.
 */
const promoteSchema = z.object({ id: z.string().min(1) });

export async function promoteToServiceRecord(
  input: unknown,
): Promise<ActionResult<{ serviceRecordId: string }>> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  const parsed = promoteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, formError: 'Invalid input' };

  const email = await prisma.incomingEmail.findUnique({
    where: { id: parsed.data.id },
    select: {
      id: true,
      subject: true,
      receivedAt: true,
      vendorId: true,
      createdServiceRecordId: true,
      targets: { select: { itemId: true, systemId: true } },
    },
  });
  if (!email) return { ok: false, formError: 'Not found' };
  if (email.createdServiceRecordId) {
    return { ok: false, formError: 'A service record draft already exists for this email' };
  }

  if (email.targets.length === 0) {
    return {
      ok: false,
      formError: 'Link this email to at least one item or system first',
    };
  }

  // Subject is a non-nullable String column, but mailparser sometimes hands
  // us "" for messages with no Subject header. Trim then fall back so an
  // empty/whitespace-only subject still produces a usable summary.
  const trimmedSubject = email.subject.trim();
  const summary = (trimmedSubject.length > 0 ? trimmedSubject : '(no subject)').slice(0, 200);

  const created = await prisma.$transaction(async (tx) => {
    const sr = await tx.serviceRecord.create({
      data: {
        vendorId: email.vendorId,
        performedOn: email.receivedAt,
        summary,
        notes: '[Promoted from inbound email — review and edit.]',
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
    return sr;
  });
  log.info(
    {
      incomingEmailId: email.id,
      serviceRecordId: created.id,
      targetCount: email.targets.length,
      by: u.id,
    },
    'incoming-email: promoted to service record',
  );
  revalidateInbox(email.id);
  revalidatePath('/service');
  return { ok: true, data: { serviceRecordId: created.id } };
}
