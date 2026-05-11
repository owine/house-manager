'use server';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { enqueueEmbed } from '@/lib/embedding/enqueue';
import type { ActionResult } from '@/lib/result';
import type { TargetInput } from '@/lib/targets/schema';
import { createWarrantySchema } from './schema';

function emptyToUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v === '' ? undefined : v;
  return out as T;
}

async function validateTargets(targets: TargetInput[]): Promise<string | null> {
  const itemIds = targets.map((t) => t.itemId).filter((v): v is string => Boolean(v));
  const systemIds = targets.map((t) => t.systemId).filter((v): v is string => Boolean(v));

  if (itemIds.length > 0) {
    const found = await prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true },
    });
    if (found.length !== new Set(itemIds).size) return 'Item not found';
  }
  if (systemIds.length > 0) {
    const found = await prisma.system.findMany({
      where: { id: { in: systemIds } },
      select: { id: true },
    });
    if (found.length !== new Set(systemIds).size) return 'System not found';
  }
  return null;
}

function targetsToCreateData(targets: TargetInput[]) {
  return targets.map((t) => ({
    itemId: t.itemId ?? null,
    systemId: t.systemId ?? null,
  }));
}

function revalidateForTargets(targets: TargetInput[]) {
  for (const t of targets) {
    if (t.itemId) revalidatePath(`/items/${t.itemId}`);
    if (t.systemId) revalidatePath(`/systems/${t.systemId}`);
  }
}

export async function createWarranty(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };
  const userId = session.user.id;

  const parsed = createWarrantySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const data = emptyToUndefined(parsed.data as Record<string, unknown>) as typeof parsed.data;

  const targetErr = await validateTargets(data.targets);
  if (targetErr) return { ok: false, formError: targetErr };

  const { targets, createExpiryReminder, expiryReminderLeadDays, ...rest } = data;
  const warranty = await prisma.warranty.create({
    data: {
      ...rest,
      targets: { create: targetsToCreateData(targets) },
    },
  });
  await enqueueEmbed('WARRANTY', warranty.id);

  if (createExpiryReminder) {
    await prisma.reminder.create({
      data: {
        title: `${warranty.provider} warranty expires`,
        description: warranty.policyNumber
          ? `Policy ${warranty.policyNumber}. Coverage ends ${warranty.endsOn.toISOString().slice(0, 10)}.`
          : `Coverage ends ${warranty.endsOn.toISOString().slice(0, 10)}.`,
        recurrence: { kind: 'once' },
        leadTimeDays: expiryReminderLeadDays,
        notifyUserIds: [userId],
        targets: {
          create: targets.map((t) => ({
            itemId: t.itemId ?? null,
            systemId: t.systemId ?? null,
            nextDueOn: warranty.endsOn,
          })),
        },
      },
    });
  }

  revalidatePath('/dashboard');
  revalidateForTargets(targets);

  return { ok: true, data: { id: warranty.id } };
}

export async function deleteWarranty(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const existing = await prisma.warranty.findUnique({
    where: { id },
    select: { targets: { select: { itemId: true, systemId: true } } },
  });
  if (!existing) return { ok: false, formError: 'Warranty not found' };

  await prisma.warranty.delete({ where: { id } });
  await enqueueEmbed('WARRANTY', id);

  revalidatePath('/dashboard');
  for (const t of existing.targets) {
    if (t.itemId) revalidatePath(`/items/${t.itemId}`);
    if (t.systemId) revalidatePath(`/systems/${t.systemId}`);
  }

  return { ok: true, data: undefined };
}
