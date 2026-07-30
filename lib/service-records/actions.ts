'use server';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { enqueueEmbed } from '@/lib/embedding/enqueue';
import type { ActionResult } from '@/lib/result';
import { enqueueSearchIndex } from '@/lib/search/client';
import type { PartTargetInput } from '@/lib/targets/schema';
import { createServiceRecordSchema, updateServiceRecordSchema } from './schema';

function emptyToUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v === '' ? undefined : v;
  return out as T;
}

async function validateTargets(targets: PartTargetInput[]): Promise<string | null> {
  const itemIds = targets.map((t) => t.itemId).filter((v): v is string => Boolean(v));
  const systemIds = targets.map((t) => t.systemId).filter((v): v is string => Boolean(v));
  const partIds = targets.map((t) => t.partId).filter((v): v is string => Boolean(v));

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
  if (partIds.length > 0) {
    const found = await prisma.part.findMany({
      where: { id: { in: partIds } },
      select: { id: true },
    });
    if (found.length !== new Set(partIds).size) return 'Part not found';
  }
  return null;
}

async function validateVendorExists(vendorId: string): Promise<boolean> {
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { id: true } });
  return vendor !== null;
}

function targetsToCreateData(targets: PartTargetInput[]) {
  return targets.map((t) => ({
    itemId: t.itemId ?? null,
    systemId: t.systemId ?? null,
    // service_record_targets_parent_xor requires EXACTLY one non-NULL parent
    // (unlike reminder_targets, which tolerates zero for a standalone chore).
    // Dropping partId here makes a part-only row all-NULL and the insert throws.
    partId: t.partId ?? null,
  }));
}

/**
 * `partId` is deliberately REQUIRED, not optional. Every field on
 * PartTargetInput is `.optional().nullable()`, so TargetInput and
 * PartTargetInput are mutually assignable and a widened contract produces zero
 * type errors. Requiring `partId` on this parameter is the only thing that turns
 * "the caller's select / mapper forgot partId" into a compile error — most
 * importantly for the diff `select` in updateServiceRecord, whose omission would
 * otherwise silently delete part targets. Do not relax it to optional.
 */
function revalidateForTargets(
  targets: { itemId?: string | null; systemId?: string | null; partId: string | null }[],
) {
  for (const t of targets) {
    if (t.itemId) revalidatePath(`/items/${t.itemId}`);
    if (t.systemId) revalidatePath(`/systems/${t.systemId}`);
    // /parts/:id does not exist until PR 1b; revalidating an unknown path is a
    // no-op, which keeps the two PRs independent.
    if (t.partId) revalidatePath(`/parts/${t.partId}`);
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
  await enqueueEmbed('SERVICE_RECORD', record.id);

  revalidatePath('/service');
  revalidatePath('/dashboard');
  if (data.vendorId) revalidatePath(`/vendors/${data.vendorId}`);
  revalidateForTargets(targets.map((t) => ({ ...t, partId: t.partId ?? null })));

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

  // Self-performed records must not retain a vendor. The form sends vendorId:
  // undefined when flipping to self-performed, which Prisma's update would
  // ignore — leaving the prior vendorId in place. Explicitly null it out, but
  // only when this update actually sets selfPerformed (partial updates that
  // omit selfPerformed must not touch vendorId).
  const updateData = data.selfPerformed === true ? { ...data, vendorId: null } : data;

  // Hoisted out of the transaction so the pre-update targets can also be
  // revalidated below — a target the user just removed still needs its page
  // rebuilt, and feeding these rows to revalidateForTargets (whose `partId` is
  // required) is what makes an incomplete `select` a compile error.
  let previousTargets: { itemId: string | null; systemId: string | null; partId: string | null }[] =
    [];

  await prisma.$transaction(async (tx) => {
    await tx.serviceRecord.update({ where: { id }, data: updateData });
    if (targets !== undefined) {
      const existing = await tx.serviceRecordTarget.findMany({
        where: { serviceRecordId: id },
        // partId is load-bearing, not cosmetic: it feeds the diff `key()` below.
        // Omit it and every persisted part row keys as "x||" while its submitted
        // counterpart keys as "||p1" — the row is absent from wantSet, lands in
        // toDelete, and the user's part target is silently destroyed. `key()`'s
        // parameter is structurally typed with optional fields, so it would NOT
        // flag the omission on its own; the compile-time guard is the assignment
        // to previousTargets, which revalidateForTargets forces to carry partId.
        select: { id: true, itemId: true, systemId: true, partId: true },
      });
      previousTargets = existing;
      const key = (t: {
        itemId?: string | null;
        systemId?: string | null;
        partId?: string | null;
      }) => `${t.itemId ?? ''}|${t.systemId ?? ''}|${t.partId ?? ''}`;
      const wantSet = new Set(targets.map(key));
      const haveSet = new Set(existing.map(key));

      const toDelete = existing.filter((e) => !wantSet.has(key(e))).map((e) => e.id);
      const toAdd = targets
        .filter((t) => !haveSet.has(key(t)))
        .map((t) => ({
          serviceRecordId: id,
          itemId: t.itemId ?? null,
          systemId: t.systemId ?? null,
          partId: t.partId ?? null,
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
  await enqueueEmbed('SERVICE_RECORD', id);

  revalidatePath('/service');
  revalidatePath(`/service/${id}`);
  revalidatePath('/dashboard');
  if (data.vendorId) revalidatePath(`/vendors/${data.vendorId}`);
  revalidateForTargets(previousTargets);
  if (targets) revalidateForTargets(targets.map((t) => ({ ...t, partId: t.partId ?? null })));

  return { ok: true, data: { id } };
}

export async function deleteServiceRecord(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const existing = await prisma.serviceRecord.findUnique({
    where: { id },
    select: {
      vendorId: true,
      targets: { select: { itemId: true, systemId: true, partId: true } },
    },
  });
  if (!existing) return { ok: false, formError: 'Service record not found' };

  await prisma.serviceRecord.delete({ where: { id } });
  await enqueueSearchIndex('service', id, 'delete');
  await enqueueEmbed('SERVICE_RECORD', id);

  revalidatePath('/service');
  revalidatePath('/dashboard');
  if (existing.vendorId) revalidatePath(`/vendors/${existing.vendorId}`);
  revalidateForTargets(existing.targets);

  return { ok: true, data: undefined };
}
