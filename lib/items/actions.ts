'use server';
import type { VendorRole } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { metadataSchemaFor } from '@/lib/categories';
import { prisma } from '@/lib/db';
import { enqueueEmbed } from '@/lib/embedding/enqueue';
import { freeformMetadataSchema } from '@/lib/metadata/freeform';
import { enqueueItemRenameCascade } from '@/lib/rename-cascade';
import type { ActionResult } from '@/lib/result';
import { enqueueSearchIndex } from '@/lib/search/client';
import { vendorLinkSchema } from '@/lib/vendor-links/schema';
import { createItemSchema, updateItemSchema } from './schema';

/**
 * Collapse a metadata validation failure onto the `metadata` field.
 *
 * The freeform metadata UI registers a single `metadata` textarea, so a nested
 * key like `metadata.dims` matches no field: RHF would nest the error where
 * FormMessage cannot read it and the form would fail silently (issue #304).
 * The offending path moves into the message instead, so the user still learns
 * which key is at fault.
 */
/**
 * Key per-category metadata failures onto a field that is actually registered,
 * which differs by category shape.
 *
 * FREEFORM (`other`, unknown slugs): the UI registers ONE `metadata` textarea,
 * so a flat key renders inline. A dotted key would nest under it and render
 * nothing — that was issue #304.
 *
 * STRUCTURED (appliance, hvac, …): the UI registers `metadata.<key>` fields and
 * NOTHING as plain `metadata`. A flat key here renders nowhere, while
 * `applyActionFieldErrors` still returns `applied: true` from its optimistic
 * flat-key branch, suppressing the caller's fallback toast — silent, the same
 * failure #304 was about, just mirrored. Dotted keys are safe: the helper
 * renders them on the registered field AND mirrors them to the root banner.
 *
 * The two schemas are compared by identity against `freeformMetadataSchema`,
 * which `metadataSchemaFor` returns for both `other` and unknown slugs.
 */
function metadataFieldErrors(issues: z.ZodIssue[], slug: string): Record<string, string[]> {
  const structured = metadataSchemaFor(slug) !== freeformMetadataSchema;

  if (!structured) {
    const messages = issues.map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    return { metadata: messages };
  }

  const out: Record<string, string[]> = {};
  for (const issue of issues) {
    const path = issue.path.join('.');
    // A root-level issue on a structured schema has no field to sit on; the
    // flat key is the only option and the caller's banner is the backstop.
    const key = path ? `metadata.${path}` : 'metadata';
    out[key] ??= [];
    out[key].push(issue.message);
  }
  return out;
}

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
    return {
      ok: false,
      fieldErrors: metadataFieldErrors(metadataResult.error.issues, parsed.data.categorySlug),
    };
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
        return { ok: false, fieldErrors: metadataFieldErrors(metadataResult.error.issues, slug) };
      }
      data.metadata = metadataResult.data as object;
    }
  }

  await prisma.item.update({ where: { id }, data });
  await enqueueSearchIndex('item', id, 'upsert');
  await enqueueEmbed('ITEM', id);
  await enqueueItemRenameCascade(id);

  revalidatePath('/items');
  revalidatePath(`/items/${id}`);
  revalidatePath('/dashboard');
  return { ok: true, data: { id } };
}

export async function archiveItem(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  await prisma.item.update({ where: { id }, data: { archivedAt: new Date(), restoredAt: null } });
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

  await prisma.item.update({ where: { id }, data: { archivedAt: null, restoredAt: new Date() } });
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
