'use server';
import type { VendorRole } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { metadataSchemaFor } from '@/lib/categories';
import { prisma } from '@/lib/db';
import { enqueueEmbed } from '@/lib/embedding/enqueue';
import type { ActionResult } from '@/lib/result';
import { enqueueSearchIndex } from '@/lib/search/client';
import { vendorLinkSchema } from '@/lib/vendor-links/schema';
import { createItemSchema, updateItemSchema } from './schema';

export async function createItem(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = createItemSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const metadataResult = metadataSchemaFor(parsed.data.categorySlug).safeParse(
    parsed.data.metadata ?? {},
  );
  if (!metadataResult.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of metadataResult.error.issues) {
      const key = ['metadata', ...issue.path].join('.');
      if (!fieldErrors[key]) fieldErrors[key] = [];
      fieldErrors[key].push(issue.message);
    }
    return { ok: false, fieldErrors };
  }

  const category = await prisma.category.findUnique({ where: { slug: parsed.data.categorySlug } });
  if (!category) return { ok: false, formError: 'Unknown category' };

  const { categorySlug, metadata, ...rest } = parsed.data;
  const item = await prisma.item.create({
    data: { ...rest, categoryId: category.id, metadata: metadataResult.data as object },
  });
  await enqueueSearchIndex('item', item.id, 'upsert');
  await enqueueEmbed('ITEM', item.id);

  revalidatePath('/items');
  revalidatePath('/dashboard');
  return { ok: true, data: { id: item.id } };
}

export async function updateItem(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = updateItemSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { id, categorySlug, metadata, ...rest } = parsed.data;

  const data: Record<string, unknown> = { ...rest };
  if (categorySlug !== undefined) {
    const category = await prisma.category.findUnique({ where: { slug: categorySlug } });
    if (!category) return { ok: false, formError: 'Unknown category' };
    data.categoryId = category.id;
  }
  if (metadata !== undefined) {
    const slug =
      categorySlug ??
      (
        await prisma.item.findUnique({
          where: { id },
          select: { category: { select: { slug: true } } },
        })
      )?.category.slug;
    if (slug) {
      const metadataResult = metadataSchemaFor(slug).safeParse(metadata);
      if (!metadataResult.success) {
        const fieldErrors: Record<string, string[]> = {};
        for (const issue of metadataResult.error.issues) {
          const key = ['metadata', ...issue.path].join('.');
          if (!fieldErrors[key]) fieldErrors[key] = [];
          fieldErrors[key].push(issue.message);
        }
        return { ok: false, fieldErrors };
      }
      data.metadata = metadataResult.data as object;
    }
  }

  await prisma.item.update({ where: { id }, data });
  await enqueueSearchIndex('item', id, 'upsert');
  await enqueueEmbed('ITEM', id);

  revalidatePath('/items');
  revalidatePath(`/items/${id}`);
  revalidatePath('/dashboard');
  return { ok: true, data: { id } };
}

export async function archiveItem(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  await prisma.item.update({ where: { id }, data: { archivedAt: new Date() } });
  await enqueueSearchIndex('item', id, 'upsert');
  await enqueueEmbed('ITEM', id);

  revalidatePath('/items');
  revalidatePath(`/items/${id}`);
  revalidatePath('/dashboard');
  return { ok: true, data: undefined };
}

export async function restoreItem(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  await prisma.item.update({ where: { id }, data: { archivedAt: null } });
  await enqueueSearchIndex('item', id, 'upsert');
  await enqueueEmbed('ITEM', id);

  revalidatePath('/items');
  revalidatePath(`/items/${id}`);
  revalidatePath('/dashboard');
  return { ok: true, data: undefined };
}

// ---------- ItemVendor (vendor links) ----------

const addItemVendorInput = vendorLinkSchema.and(z.object({ itemId: z.string().min(1) }));

export async function addItemVendor(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = addItemVendorInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const link = await prisma.itemVendor.create({
    data: {
      itemId: parsed.data.itemId,
      vendorId: parsed.data.vendorId ?? null,
      freeformName: parsed.data.freeformName ?? null,
      role: parsed.data.role as VendorRole,
      notes: parsed.data.notes ?? null,
      serviceContract: parsed.data.serviceContract,
      contractEndsOn: parsed.data.contractEndsOn ?? null,
    },
  });
  revalidatePath(`/items/${parsed.data.itemId}`);
  revalidatePath('/vendors');
  if (parsed.data.vendorId) revalidatePath(`/vendors/${parsed.data.vendorId}`);
  return { ok: true, data: { id: link.id } };
}

const updateItemVendorInput = vendorLinkSchema.and(z.object({ id: z.string().min(1) }));

export async function updateItemVendor(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = updateItemVendorInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const updated = await prisma.itemVendor.update({
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
  revalidatePath(`/items/${updated.itemId}`);
  revalidatePath('/vendors');
  if (updated.vendorId) revalidatePath(`/vendors/${updated.vendorId}`);
  return { ok: true, data: { id: updated.id } };
}

const removeItemVendorInput = z.object({ id: z.string().min(1) });

export async function removeItemVendor(input: { id: string }): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = removeItemVendorInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const removed = await prisma.itemVendor.delete({ where: { id: parsed.data.id } });
  revalidatePath(`/items/${removed.itemId}`);
  revalidatePath('/vendors');
  if (removed.vendorId) revalidatePath(`/vendors/${removed.vendorId}`);
  return { ok: true, data: undefined };
}

export async function setIncludeInSuggestions(input: {
  itemId: string;
  value: boolean;
}): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };
  await prisma.item.update({
    where: { id: input.itemId },
    data: { includeInSuggestions: input.value },
  });
  revalidatePath(`/items/${input.itemId}`);
  return { ok: true, data: undefined };
}
