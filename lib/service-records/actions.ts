'use server';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import type { ActionResult } from '@/lib/result';
import { enqueueSearchIndex } from '@/lib/search/client';
import { createServiceRecordSchema, updateServiceRecordSchema } from './schema';

function emptyToUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v === '' ? undefined : v;
  return out as T;
}

async function validateItemExists(itemId: string): Promise<boolean> {
  const item = await prisma.item.findUnique({ where: { id: itemId }, select: { id: true } });
  return item !== null;
}

async function validateVendorExists(vendorId: string): Promise<boolean> {
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { id: true } });
  return vendor !== null;
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

  if (data.itemId !== undefined) {
    const exists = await validateItemExists(data.itemId);
    if (!exists) return { ok: false, formError: 'Item not found' };
  }

  if (data.vendorId !== undefined) {
    const exists = await validateVendorExists(data.vendorId);
    if (!exists) return { ok: false, formError: 'Vendor not found' };
  }

  const record = await prisma.serviceRecord.create({ data });
  await enqueueSearchIndex('service', record.id, 'upsert');

  revalidatePath('/service');
  revalidatePath('/dashboard');
  if (data.itemId) revalidatePath(`/items/${data.itemId}`);
  if (data.vendorId) revalidatePath(`/vendors/${data.vendorId}`);

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

  const { id, ...rest } = parsed.data;
  const data = emptyToUndefined(rest as Record<string, unknown>) as typeof rest;

  if (data.itemId !== undefined) {
    const exists = await validateItemExists(data.itemId);
    if (!exists) return { ok: false, formError: 'Item not found' };
  }

  if (data.vendorId !== undefined) {
    const exists = await validateVendorExists(data.vendorId);
    if (!exists) return { ok: false, formError: 'Vendor not found' };
  }

  await prisma.serviceRecord.update({ where: { id }, data });
  await enqueueSearchIndex('service', id, 'upsert');

  revalidatePath('/service');
  revalidatePath(`/service/${id}`);
  revalidatePath('/dashboard');
  if (data.itemId) revalidatePath(`/items/${data.itemId}`);
  if (data.vendorId) revalidatePath(`/vendors/${data.vendorId}`);

  return { ok: true, data: { id } };
}

export async function deleteServiceRecord(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const existing = await prisma.serviceRecord.findUnique({
    where: { id },
    select: { itemId: true, vendorId: true },
  });
  if (!existing) return { ok: false, formError: 'Service record not found' };

  await prisma.serviceRecord.delete({ where: { id } });
  await enqueueSearchIndex('service', id, 'delete');

  revalidatePath('/service');
  revalidatePath('/dashboard');
  if (existing.itemId) revalidatePath(`/items/${existing.itemId}`);
  if (existing.vendorId) revalidatePath(`/vendors/${existing.vendorId}`);

  return { ok: true, data: undefined };
}
