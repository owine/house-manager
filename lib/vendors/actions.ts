'use server';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import type { ActionResult } from '@/lib/result';
import { enqueueSearchIndex } from '@/lib/search/client';
import { createVendorSchema, updateVendorSchema } from './schema';

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

export async function deleteVendor(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  await prisma.vendor.delete({ where: { id } });
  await enqueueSearchIndex('vendor', id, 'delete');
  revalidatePath('/vendors');
  return { ok: true, data: undefined };
}
