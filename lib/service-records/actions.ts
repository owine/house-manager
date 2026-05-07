'use server';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import type { ActionResult } from '@/lib/result';
import { enqueueSearchIndex } from '@/lib/search/client';
import {
  createServiceRecordSchema,
  type ServiceRecordTargetInput,
  updateServiceRecordSchema,
} from './schema';

function emptyToUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v === '' ? undefined : v;
  return out as T;
}

async function validateTargets(targets: ServiceRecordTargetInput[]): Promise<string | null> {
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

async function validateVendorExists(vendorId: string): Promise<boolean> {
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { id: true } });
  return vendor !== null;
}

function targetsToCreateData(targets: ServiceRecordTargetInput[]) {
  return targets.map((t) => ({
    itemId: t.itemId ?? null,
    systemId: t.systemId ?? null,
  }));
}

function revalidateForTargets(targets: ServiceRecordTargetInput[]) {
  for (const t of targets) {
    if (t.itemId) revalidatePath(`/items/${t.itemId}`);
    if (t.systemId) revalidatePath(`/systems/${t.systemId}`);
  }
}

export async function createServiceRecord(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = createServiceRecordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const data = emptyToUndefined(parsed.data as Record<string, unknown>) as typeof parsed.data;

  const targetErr = await validateTargets(data.targets);
  if (targetErr) return { ok: false, formError: targetErr };

  if (data.vendorId !== undefined) {
    const exists = await validateVendorExists(data.vendorId);
    if (!exists) return { ok: false, formError: 'Vendor not found' };
  }

  const { targets, ...rest } = data;
  const record = await prisma.serviceRecord.create({
    data: {
      ...rest,
      targets: { create: targetsToCreateData(targets) },
    },
  });
  await enqueueSearchIndex('service', record.id, 'upsert');

  revalidatePath('/service');
  revalidatePath('/dashboard');
  if (data.vendorId) revalidatePath(`/vendors/${data.vendorId}`);
  revalidateForTargets(targets);

  return { ok: true, data: { id: record.id } };
}

export async function updateServiceRecord(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = updateServiceRecordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { id, targets, ...rest } = parsed.data;
  const data = emptyToUndefined(rest as Record<string, unknown>) as typeof rest;

  if (targets !== undefined) {
    const targetErr = await validateTargets(targets);
    if (targetErr) return { ok: false, formError: targetErr };
  }

  if (data.vendorId !== undefined) {
    const exists = await validateVendorExists(data.vendorId);
    if (!exists) return { ok: false, formError: 'Vendor not found' };
  }

  await prisma.$transaction(async (tx) => {
    await tx.serviceRecord.update({ where: { id }, data });
    if (targets !== undefined) {
      const existing = await tx.serviceRecordTarget.findMany({
        where: { serviceRecordId: id },
        select: { id: true, itemId: true, systemId: true },
      });
      const key = (t: { itemId?: string | null; systemId?: string | null }) =>
        `${t.itemId ?? ''}|${t.systemId ?? ''}`;
      const wantSet = new Set(targets.map(key));
      const haveSet = new Set(existing.map(key));

      const toDelete = existing.filter((e) => !wantSet.has(key(e))).map((e) => e.id);
      const toAdd = targets
        .filter((t) => !haveSet.has(key(t)))
        .map((t) => ({
          serviceRecordId: id,
          itemId: t.itemId ?? null,
          systemId: t.systemId ?? null,
        }));

      if (toDelete.length > 0) {
        await tx.serviceRecordTarget.deleteMany({ where: { id: { in: toDelete } } });
      }
      if (toAdd.length > 0) {
        await tx.serviceRecordTarget.createMany({ data: toAdd });
      }
    }
  });
  await enqueueSearchIndex('service', id, 'upsert');

  revalidatePath('/service');
  revalidatePath(`/service/${id}`);
  revalidatePath('/dashboard');
  if (data.vendorId) revalidatePath(`/vendors/${data.vendorId}`);
  if (targets) revalidateForTargets(targets);

  return { ok: true, data: { id } };
}

export async function deleteServiceRecord(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const existing = await prisma.serviceRecord.findUnique({
    where: { id },
    select: {
      vendorId: true,
      targets: { select: { itemId: true, systemId: true } },
    },
  });
  if (!existing) return { ok: false, formError: 'Service record not found' };

  await prisma.serviceRecord.delete({ where: { id } });
  await enqueueSearchIndex('service', id, 'delete');

  revalidatePath('/service');
  revalidatePath('/dashboard');
  if (existing.vendorId) revalidatePath(`/vendors/${existing.vendorId}`);
  for (const t of existing.targets) {
    if (t.itemId) revalidatePath(`/items/${t.itemId}`);
    if (t.systemId) revalidatePath(`/systems/${t.systemId}`);
  }

  return { ok: true, data: undefined };
}
