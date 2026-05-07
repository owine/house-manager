'use server';
import { createId } from '@paralleldrive/cuid2';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import type { ActionResult } from '@/lib/result';
import { enqueueSearchIndex } from '@/lib/search/client';
import { computeNextDueOn } from './recurrence';
import {
  completeReminderSchema,
  createReminderSchema,
  type Recurrence,
  updateReminderSchema,
} from './schema';

// Composite where for ownership-gated reminder lookups. A reminder is "owned"
// by every user listed in its notifyUserIds array; only those users may
// update / delete / setActive / complete it. Repeated in four call sites
// below — kept as a helper so the access predicate has one definition.
function ownedReminderWhere(id: string, userId: string) {
  return { id, notifyUserIds: { has: userId } } as const;
}

function revalidateReminderPaths(itemId: string | null | undefined, reminderId: string) {
  revalidatePath('/reminders');
  revalidatePath(`/reminders/${reminderId}`);
  revalidatePath('/dashboard');
  if (itemId) revalidatePath(`/items/${itemId}`);
}

export async function createReminder(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };

  const parsed = createReminderSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { itemId, description, notifyUserIds, ...rest } = parsed.data;

  if (itemId) {
    const item = await prisma.item.findUnique({ where: { id: itemId }, select: { id: true } });
    if (!item) return { ok: false, formError: 'Item not found' };
  }

  const reminder = await prisma.reminder.create({
    data: {
      ...rest,
      description: description || null,
      itemId: itemId ?? null,
      notifyUserIds: notifyUserIds && notifyUserIds.length > 0 ? notifyUserIds : [session.user.id],
    },
    select: { id: true, itemId: true },
  });
  await enqueueSearchIndex('reminder', reminder.id, 'upsert');

  revalidateReminderPaths(reminder.itemId, reminder.id);
  return { ok: true, data: { id: reminder.id } };
}

export async function updateReminder(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };

  const parsed = updateReminderSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { id, itemId, description, notifyUserIds, ...rest } = parsed.data;

  // Ownership-gated lookup: a user can only update reminders they're notified
  // on. findFirst (not findUnique) so we can compose the `notifyUserIds.has`
  // filter; uniform "Not found" response avoids leaking existence of
  // reminders that belong to other users.
  const existing = await prisma.reminder.findFirst({
    where: ownedReminderWhere(id, session.user.id),
    select: { id: true, itemId: true },
  });
  if (!existing) return { ok: false, formError: 'Not found' };

  if (itemId !== undefined && itemId !== null) {
    const item = await prisma.item.findUnique({ where: { id: itemId }, select: { id: true } });
    if (!item) return { ok: false, formError: 'Item not found' };
  }

  const data: Record<string, unknown> = { ...rest };
  if ('itemId' in parsed.data) data.itemId = itemId ?? null;
  if ('description' in parsed.data) data.description = description || null;
  if (notifyUserIds !== undefined) data.notifyUserIds = notifyUserIds;

  await prisma.reminder.update({ where: { id }, data });
  await enqueueSearchIndex('reminder', id, 'upsert');
  revalidateReminderPaths(existing.itemId, id);
  if (itemId !== undefined && itemId !== existing.itemId && existing.itemId)
    revalidatePath(`/items/${existing.itemId}`);

  return { ok: true, data: { id } };
}

export async function deleteReminder(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };

  // Ownership-gated lookup — see updateReminder for rationale.
  const existing = await prisma.reminder.findFirst({
    where: ownedReminderWhere(id, session.user.id),
    select: { itemId: true },
  });
  if (!existing) return { ok: false, formError: 'Not found' };

  await prisma.reminder.delete({ where: { id } });
  await enqueueSearchIndex('reminder', id, 'delete');
  revalidateReminderPaths(existing.itemId, id);
  return { ok: true, data: undefined };
}

export async function setReminderActive(
  id: string,
  active: boolean,
): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };

  // Ownership-gated lookup — previously this action had no auth check at all,
  // so any authed user could toggle any reminder's active flag. See
  // updateReminder for the findFirst-with-composite-where rationale.
  const existing = await prisma.reminder.findFirst({
    where: ownedReminderWhere(id, session.user.id),
    select: { id: true },
  });
  if (!existing) return { ok: false, formError: 'Not found' };

  const updated = await prisma.reminder.update({
    where: { id },
    data: { active },
    select: { id: true, itemId: true },
  });
  await enqueueSearchIndex('reminder', id, 'upsert');
  revalidateReminderPaths(updated.itemId, id);
  return { ok: true, data: { id } };
}

export async function completeReminder(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };
  const userId = session.user.id;

  const parsed = completeReminderSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { id, notes, serviceRecord } = parsed.data;

  // Ownership-gated lookup — see updateReminder for rationale. Completing a
  // reminder writes a ReminderCompletion attributed to userId + advances
  // nextDueOn for everyone notified on it; only users in notifyUserIds can do
  // either.
  const reminder = await prisma.reminder.findFirst({
    where: ownedReminderWhere(id, userId),
    select: {
      id: true,
      itemId: true,
      recurrence: true,
      autoCreateServiceRecord: true,
    },
  });
  if (!reminder) return { ok: false, formError: 'Not found' };

  const now = new Date();
  const recurrence = reminder.recurrence as unknown as Recurrence;
  const nextDueOn = computeNextDueOn(recurrence, now);

  const completion = await prisma.reminderCompletion.create({
    data: {
      id: createId(),
      reminderId: id,
      completedById: userId,
      completedOn: now,
      notes: notes || null,
    },
    select: { id: true },
  });

  if (reminder.autoCreateServiceRecord && reminder.itemId && serviceRecord) {
    const sr = await prisma.serviceRecord.create({
      data: {
        performedOn: now,
        summary: serviceRecord.summary,
        notes: serviceRecord.notes || null,
        cost: serviceRecord.cost,
        vendorId: serviceRecord.vendorId ?? null,
        targets: { create: [{ itemId: reminder.itemId }] },
      },
      select: { id: true },
    });
    await enqueueSearchIndex('service', sr.id, 'upsert');
    await prisma.reminderCompletion.update({
      where: { id: completion.id },
      data: { createdServiceRecordId: sr.id },
    });
  }

  await prisma.reminder.update({
    where: { id },
    data: { lastCompletedOn: now, nextDueOn },
  });
  await enqueueSearchIndex('reminder', id, 'upsert');

  revalidateReminderPaths(reminder.itemId, id);
  return { ok: true, data: { id } };
}
