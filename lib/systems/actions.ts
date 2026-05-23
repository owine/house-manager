'use server';
import type { VendorRole } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { enqueueEmbed } from '@/lib/embedding/enqueue';
import type { ActionResult } from '@/lib/result';
import { vendorLinkSchema } from '@/lib/vendor-links/schema';
import { createSystemSchema, updateSystemWithIdSchema } from './schema';

function emptyToUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v === '' ? undefined : v;
  return out as T;
}

function revalidateSystemPaths(id?: string) {
  revalidatePath('/systems');
  if (id) revalidatePath(`/systems/${id}`);
}

export async function createSystem(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = createSystemSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const system = await prisma.system.create({ data: emptyToUndefined(parsed.data) });
  revalidateSystemPaths(system.id);
  return { ok: true, data: { id: system.id } };
}

export async function updateSystem(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = updateSystemWithIdSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { id, ...rest } = parsed.data;
  await prisma.system.update({ where: { id }, data: emptyToUndefined(rest) });
  revalidateSystemPaths(id);
  return { ok: true, data: { id } };
}

export async function archiveSystem(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  await prisma.system.update({ where: { id }, data: { archivedAt: new Date() } });
  revalidateSystemPaths(id);
  return { ok: true, data: undefined };
}

export async function unarchiveSystem(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  await prisma.system.update({ where: { id }, data: { archivedAt: null } });
  revalidateSystemPaths(id);
  return { ok: true, data: undefined };
}

export async function deleteSystem(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  await prisma.system.delete({ where: { id } });
  revalidatePath('/systems');
  revalidatePath('/items');
  return { ok: true, data: undefined };
}

// ---------- Component (Item) assignment ----------

const assignItemInput = z.object({
  itemId: z.string().min(1),
  systemId: z.string().min(1),
});

export async function assignItemToSystem(input: {
  itemId: string;
  systemId: string;
}): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = assignItemInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  await prisma.item.update({
    where: { id: parsed.data.itemId },
    data: { systemId: parsed.data.systemId },
  });
  // system.name is part of the Item embed; reassignment must trigger re-embed.
  await enqueueEmbed('ITEM', parsed.data.itemId);
  revalidateSystemPaths(parsed.data.systemId);
  revalidatePath('/items');
  revalidatePath(`/items/${parsed.data.itemId}`);
  return { ok: true, data: undefined };
}

const unassignItemInput = z.object({ itemId: z.string().min(1) });

export async function unassignItemFromSystem(input: {
  itemId: string;
}): Promise<ActionResult<{ previousSystemId: string | null }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = unassignItemInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const before = await prisma.item.findUnique({
    where: { id: parsed.data.itemId },
    select: { systemId: true },
  });
  await prisma.item.update({
    where: { id: parsed.data.itemId },
    data: { systemId: null },
  });
  await enqueueEmbed('ITEM', parsed.data.itemId);
  revalidatePath('/systems');
  if (before?.systemId) revalidatePath(`/systems/${before.systemId}`);
  revalidatePath('/items');
  revalidatePath(`/items/${parsed.data.itemId}`);
  return { ok: true, data: { previousSystemId: before?.systemId ?? null } };
}

// ---------- SystemVendor (vendor links) ----------

const addSystemVendorInput = vendorLinkSchema.and(z.object({ systemId: z.string().min(1) }));

export async function addSystemVendor(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = addSystemVendorInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const link = await prisma.systemVendor.create({
    data: {
      systemId: parsed.data.systemId,
      vendorId: parsed.data.vendorId ?? null,
      freeformName: parsed.data.freeformName ?? null,
      role: parsed.data.role as VendorRole,
      notes: parsed.data.notes ?? null,
      serviceContract: parsed.data.serviceContract,
      contractEndsOn: parsed.data.contractEndsOn ?? null,
    },
  });
  revalidateSystemPaths(parsed.data.systemId);
  if (parsed.data.vendorId) revalidatePath(`/vendors/${parsed.data.vendorId}`);
  return { ok: true, data: { id: link.id } };
}

const updateSystemVendorInput = vendorLinkSchema.and(z.object({ id: z.string().min(1) }));

export async function updateSystemVendor(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = updateSystemVendorInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const updated = await prisma.systemVendor.update({
    where: { id: parsed.data.id },
    data: {
      vendorId: parsed.data.vendorId ?? null,
      freeformName: parsed.data.freeformName ?? null,
      role: parsed.data.role as VendorRole,
      notes: parsed.data.notes ?? null,
      serviceContract: parsed.data.serviceContract,
      contractEndsOn: parsed.data.contractEndsOn ?? null,
    },
  });
  revalidateSystemPaths(updated.systemId);
  if (updated.vendorId) revalidatePath(`/vendors/${updated.vendorId}`);
  return { ok: true, data: { id: updated.id } };
}

const removeSystemVendorInput = z.object({ id: z.string().min(1) });

export async function removeSystemVendor(input: { id: string }): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = removeSystemVendorInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const removed = await prisma.systemVendor.delete({ where: { id: parsed.data.id } });
  revalidateSystemPaths(removed.systemId);
  if (removed.vendorId) revalidatePath(`/vendors/${removed.vendorId}`);
  return { ok: true, data: undefined };
}
