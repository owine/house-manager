'use server';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import type { ActionResult } from '@/lib/result';
import { createWarrantySchema, updateWarrantySchema } from './schema';

function emptyToUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v === '' ? undefined : v;
  return out as T;
}

async function validateItemExists(itemId: string): Promise<boolean> {
  const item = await prisma.item.findUnique({ where: { id: itemId }, select: { id: true } });
  return item !== null;
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

  const exists = await validateItemExists(data.itemId);
  if (!exists) return { ok: false, formError: 'Item not found' };

  const warranty = await prisma.warranty.create({ data });

  revalidatePath(`/items/${data.itemId}`);
  revalidatePath('/dashboard');

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

  const { id, ...rest } = parsed.data;
  const data = emptyToUndefined(rest as Record<string, unknown>) as typeof rest;

  // Pre-fetch the existing warranty to get the old itemId for revalidation
  const existing = await prisma.warranty.findUnique({
    where: { id },
    select: { itemId: true },
  });
  if (!existing) return { ok: false, formError: 'Warranty not found' };

  const oldItemId = existing.itemId;

  if (data.itemId !== undefined) {
    const exists = await validateItemExists(data.itemId);
    if (!exists) return { ok: false, formError: 'Item not found' };
  }

  await prisma.warranty.update({ where: { id }, data });

  revalidatePath(`/items/${oldItemId}`);
  revalidatePath('/dashboard');
  if (data.itemId && data.itemId !== oldItemId) {
    revalidatePath(`/items/${data.itemId}`);
  }

  return { ok: true, data: { id } };
}

export async function deleteWarranty(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const existing = await prisma.warranty.findUnique({
    where: { id },
    select: { itemId: true },
  });
  if (!existing) return { ok: false, formError: 'Warranty not found' };

  await prisma.warranty.delete({ where: { id } });

  revalidatePath(`/items/${existing.itemId}`);
  revalidatePath('/dashboard');

  return { ok: true, data: undefined };
}
