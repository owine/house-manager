'use server';
import { createId } from '@paralleldrive/cuid2';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import type { ActionResult } from '@/lib/result';
import { computeNextDueOn } from './recurrence';
import {
  completeReminderSchema,
  createReminderSchema,
  type Recurrence,
  updateReminderSchema,
} from './schema';

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

  const existing = await prisma.reminder.findUnique({
    where: { id },
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
  revalidateReminderPaths(existing.itemId, id);
  if (itemId !== undefined && itemId !== existing.itemId && existing.itemId)
    revalidatePath(`/items/${existing.itemId}`);

  return { ok: true, data: { id } };
}

export async function deleteReminder(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };

  const existing = await prisma.reminder.findUnique({
    where: { id },
    select: { itemId: true },
  });
  if (!existing) return { ok: false, formError: 'Not found' };

  await prisma.reminder.delete({ where: { id } });
  revalidateReminderPaths(existing.itemId, id);
  return { ok: true, data: undefined };
}

export async function setReminderActive(
  id: string,
  active: boolean,
): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };

  const updated = await prisma.reminder.update({
    where: { id },
    data: { active },
    select: { id: true, itemId: true },
  });
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

  const reminder = await prisma.reminder.findUnique({
    where: { id },
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
        itemId: reminder.itemId,
        performedOn: now,
        summary: serviceRecord.summary,
        notes: serviceRecord.notes || null,
        cost: serviceRecord.cost,
        vendorId: serviceRecord.vendorId ?? null,
      },
      select: { id: true },
    });
    await prisma.reminderCompletion.update({
      where: { id: completion.id },
      data: { createdServiceRecordId: sr.id },
    });
  }

  await prisma.reminder.update({
    where: { id },
    data: { lastCompletedOn: now, nextDueOn },
  });

  revalidateReminderPaths(reminder.itemId, id);
  return { ok: true, data: { id } };
}
