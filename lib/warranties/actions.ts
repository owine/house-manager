'use server';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import type { ActionResult } from '@/lib/result';
import { createWarrantySchema, updateWarrantySchema, type WarrantyTargetInput } from './schema';

function emptyToUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v === '' ? undefined : v;
  return out as T;
}

async function validateTargets(targets: WarrantyTargetInput[]): Promise<string | null> {
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

function targetsToCreateData(targets: WarrantyTargetInput[]) {
  return targets.map((t) => ({
    itemId: t.itemId ?? null,
    systemId: t.systemId ?? null,
  }));
}

function revalidateForTargets(targets: WarrantyTargetInput[]) {
  for (const t of targets) {
    if (t.itemId) revalidatePath(`/items/${t.itemId}`);
    if (t.systemId) revalidatePath(`/systems/${t.systemId}`);
  }
}

export async function createWarranty(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

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

  const { targets, ...rest } = data;
  const warranty = await prisma.warranty.create({
    data: {
      ...rest,
      targets: { create: targetsToCreateData(targets) },
    },
  });

  revalidatePath('/dashboard');
  revalidateForTargets(targets);

  return { ok: true, data: { id: warranty.id } };
}

export async function updateWarranty(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = updateWarrantySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { id, targets, ...rest } = parsed.data;
  const data = emptyToUndefined(rest as Record<string, unknown>) as typeof rest;

  // Pre-fetch the existing warranty + targets for revalidation
  const existing = await prisma.warranty.findUnique({
    where: { id },
    select: {
      id: true,
      targets: { select: { itemId: true, systemId: true } },
    },
  });
  if (!existing) return { ok: false, formError: 'Warranty not found' };

  if (targets !== undefined) {
    const targetErr = await validateTargets(targets);
    if (targetErr) return { ok: false, formError: targetErr };
  }

  await prisma.$transaction(async (tx) => {
    await tx.warranty.update({ where: { id }, data });
    if (targets !== undefined) {
      const existingTargets = await tx.warrantyTarget.findMany({
        where: { warrantyId: id },
        select: { id: true, itemId: true, systemId: true },
      });
      const key = (t: { itemId?: string | null; systemId?: string | null }) =>
        `${t.itemId ?? ''}|${t.systemId ?? ''}`;
      const wantSet = new Set(targets.map(key));
      const haveSet = new Set(existingTargets.map(key));

      const toDelete = existingTargets.filter((e) => !wantSet.has(key(e))).map((e) => e.id);
      const toAdd = targets
        .filter((t) => !haveSet.has(key(t)))
        .map((t) => ({
          warrantyId: id,
          itemId: t.itemId ?? null,
          systemId: t.systemId ?? null,
        }));

      if (toDelete.length > 0) {
        await tx.warrantyTarget.deleteMany({ where: { id: { in: toDelete } } });
      }
      if (toAdd.length > 0) {
        await tx.warrantyTarget.createMany({ data: toAdd });
      }
    }
  });

  revalidatePath('/dashboard');
  // Revalidate previous + new target paths
  for (const t of existing.targets) {
    if (t.itemId) revalidatePath(`/items/${t.itemId}`);
    if (t.systemId) revalidatePath(`/systems/${t.systemId}`);
  }
  if (targets) revalidateForTargets(targets);

  return { ok: true, data: { id } };
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

  revalidatePath('/dashboard');
  for (const t of existing.targets) {
    if (t.itemId) revalidatePath(`/items/${t.itemId}`);
    if (t.systemId) revalidatePath(`/systems/${t.systemId}`);
  }

  return { ok: true, data: undefined };
}
