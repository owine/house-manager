'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getLogger } from '@/lib/logger';
import type { ActionResult } from '@/lib/result';

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
  itemId: z.string().min(1).nullable().optional(),
  systemId: z.string().min(1).nullable().optional(),
});

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
  const { id, vendorId, itemId, systemId } = parsed.data;
  const updated = await prisma.incomingEmail.update({
    where: { id },
    data: {
      // Pass undefined to leave a field unchanged; null clears it.
      vendorId: vendorId === undefined ? undefined : vendorId,
      itemId: itemId === undefined ? undefined : itemId,
      systemId: systemId === undefined ? undefined : systemId,
      // Any successful manual link counts as user confirmation.
      state: 'LINKED',
    },
    select: { id: true, vendorId: true, itemId: true, systemId: true },
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
  // Restore to UNTRIAGED if no FKs are set, else LINKED — matches the natural
  // post-restore state the user would expect.
  const row = await prisma.incomingEmail.findUnique({
    where: { id: parsed.data.id },
    select: { vendorId: true, itemId: true, systemId: true },
  });
  if (!row) return { ok: false, formError: 'Not found' };
  const hasAnyLink = row.vendorId || row.itemId || row.systemId;
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
 * The ServiceRecord targets table is shaped (item XOR system); we pick item
 * if both are set on the email, since per-item is the more specific link.
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
      itemId: true,
      systemId: true,
      createdServiceRecordId: true,
    },
  });
  if (!email) return { ok: false, formError: 'Not found' };
  if (email.createdServiceRecordId) {
    return { ok: false, formError: 'A service record draft already exists for this email' };
  }

  const targetItemId = email.itemId ?? null;
  const targetSystemId = targetItemId ? null : (email.systemId ?? null);
  if (!targetItemId && !targetSystemId) {
    return {
      ok: false,
      formError: 'Link this email to an item or system first',
    };
  }

  const created = await prisma.$transaction(async (tx) => {
    const sr = await tx.serviceRecord.create({
      data: {
        vendorId: email.vendorId,
        performedOn: email.receivedAt,
        summary: email.subject.slice(0, 200) || '(no subject)',
        notes: '[Promoted from inbound email — review and edit.]',
        targets: {
          create: [
            targetItemId ? { itemId: targetItemId } : { systemId: targetSystemId as string },
          ],
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
    { incomingEmailId: email.id, serviceRecordId: created.id, by: u.id },
    'incoming-email: promoted to service record',
  );
  revalidateInbox(email.id);
  revalidatePath('/service');
  return { ok: true, data: { serviceRecordId: created.id } };
}
