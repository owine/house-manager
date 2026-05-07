'use server';
import { Prisma } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import type { ActionResult } from '@/lib/result';
import { enqueueSearchIndex } from '@/lib/search/client';
import { createVendorSchema, updateVendorSchema } from './schema';

export type TryDeleteVendorResult =
  | { ok: true }
  | { ok: false; hasLinks: true; itemCount: number; systemCount: number }
  | { ok: false; formError: string };

export type ConvertVendorLinksResult =
  | { ok: true; convertedItemCount: number; convertedSystemCount: number }
  | { ok: false; error: 'not_found' }
  | { ok: false; formError: string };

export type DeleteVendorAndLinksResult =
  | { ok: true; deletedItemCount: number; deletedSystemCount: number }
  | { ok: false; formError: string };

function emptyToUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v === '' ? undefined : v;
  return out as T;
}

export async function createVendor(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = createVendorSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const vendor = await prisma.vendor.create({ data: emptyToUndefined(parsed.data) });
  await enqueueSearchIndex('vendor', vendor.id, 'upsert');
  revalidatePath('/vendors');
  return { ok: true, data: { id: vendor.id } };
}

export async function updateVendor(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = updateVendorSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { id, ...rest } = parsed.data;
  await prisma.vendor.update({ where: { id }, data: emptyToUndefined(rest) });
  await enqueueSearchIndex('vendor', id, 'upsert');

  revalidatePath('/vendors');
  revalidatePath(`/vendors/${id}`);
  return { ok: true, data: { id } };
}

/**
 * Legacy delete entry-point. The UI now uses `tryDeleteVendor` + the mediated
 * resolution flows (convert-to-freeform, delete-with-links). This thin wrapper
 * is kept for any non-UI callers (tests, future scripts) and delegates to
 * `tryDeleteVendor` so it can never surface a raw P2003 on linked vendors.
 */
export async function deleteVendor(id: string): Promise<TryDeleteVendorResult> {
  return tryDeleteVendor(id);
}

/**
 * Probe-style vendor delete. Tries a plain delete; if Postgres rejects via the
 * Restrict FK on ItemVendor / SystemVendor, returns structured link counts so
 * the UI can offer a resolution (convert to freeform / delete links).
 */
export async function tryDeleteVendor(vendorId: string): Promise<TryDeleteVendorResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  try {
    await prisma.vendor.delete({ where: { id: vendorId } });
    await enqueueSearchIndex('vendor', vendorId, 'delete');
    revalidatePath('/vendors');
    revalidatePath('/items');
    revalidatePath('/systems');
    return { ok: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
      const [itemCount, systemCount] = await Promise.all([
        prisma.itemVendor.count({ where: { vendorId } }),
        prisma.systemVendor.count({ where: { vendorId } }),
      ]);
      return { ok: false, hasLinks: true, itemCount, systemCount };
    }
    throw err;
  }
}

/**
 * Resolution flow A: copy `vendor.name` into each linked ItemVendor /
 * SystemVendor row's `freeformName`, null its `vendorId`, then delete the
 * vendor. The XOR CHECK is satisfied at every intermediate state because
 * Prisma sends both column updates in a single UPDATE statement.
 */
export async function convertVendorLinksToFreeform(
  vendorId: string,
): Promise<ConvertVendorLinksResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const result = await prisma.$transaction(async (tx) => {
    const vendor = await tx.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) {
      return { ok: false as const, error: 'not_found' as const };
    }

    const itemUpdate = await tx.itemVendor.updateMany({
      where: { vendorId },
      data: { vendorId: null, freeformName: vendor.name },
    });
    const systemUpdate = await tx.systemVendor.updateMany({
      where: { vendorId },
      data: { vendorId: null, freeformName: vendor.name },
    });

    await tx.vendor.delete({ where: { id: vendorId } });

    return {
      ok: true as const,
      convertedItemCount: itemUpdate.count,
      convertedSystemCount: systemUpdate.count,
    };
  });

  if (result.ok) {
    await enqueueSearchIndex('vendor', vendorId, 'delete');
    revalidatePath('/vendors');
    revalidatePath('/items');
    revalidatePath('/systems');
  }
  return result;
}

/**
 * Resolution flow B: delete every ItemVendor / SystemVendor row referencing
 * this vendor, then delete the vendor itself.
 */
export async function deleteVendorAndLinks(vendorId: string): Promise<DeleteVendorAndLinksResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const result = await prisma.$transaction(async (tx) => {
    const itemDelete = await tx.itemVendor.deleteMany({ where: { vendorId } });
    const systemDelete = await tx.systemVendor.deleteMany({ where: { vendorId } });
    await tx.vendor.delete({ where: { id: vendorId } });
    return {
      ok: true as const,
      deletedItemCount: itemDelete.count,
      deletedSystemCount: systemDelete.count,
    };
  });

  await enqueueSearchIndex('vendor', vendorId, 'delete');
  revalidatePath('/vendors');
  revalidatePath('/items');
  revalidatePath('/systems');
  return result;
}
