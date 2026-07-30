'use server';
import type { PartKind } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { enqueueEmbed } from '@/lib/embedding/enqueue';
import { freeformMetadataSchema } from '@/lib/metadata/freeform';
import type { ActionResult } from '@/lib/result';
import { enqueueSearchIndex } from '@/lib/search/client';
import { partKindSchemaFor } from './kinds';
import { createPartSchema, updatePartSchema } from './schema';

function revalidatePart(id?: string) {
  revalidatePath('/parts');
  if (id) revalidatePath(`/parts/${id}`);
  revalidatePath('/dashboard');
}

/**
 * Key a per-kind spec failure onto a field the UI actually registers. See
 * `refineMetadata` in ./schema for why the shape differs by kind — a flat key
 * on a structured kind renders nowhere yet still reports `applied: true`,
 * which suppresses the caller's fallback toast.
 */
function metadataFieldErrors(kind: PartKind, issues: z.ZodIssue[]): Record<string, string[]> {
  const structured = partKindSchemaFor(kind) !== freeformMetadataSchema;
  const out: Record<string, string[]> = {};
  for (const issue of issues) {
    const path = issue.path.join('.');
    const key = structured && path ? `metadata.${path}` : 'metadata';
    const message =
      structured && path ? issue.message : path ? `${path}: ${issue.message}` : issue.message;
    out[key] ??= [];
    out[key].push(message);
  }
  return out;
}

export async function createPart(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = createPartSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { metadata, purchaseLinks, typicalCost, ...rest } = parsed.data;
  const part = await prisma.part.create({
    data: {
      ...rest,
      typicalCost: typicalCost ?? null,
      purchaseLinks: purchaseLinks as Prisma.InputJsonValue,
      metadata: (metadata ?? {}) as Prisma.InputJsonValue,
    },
  });

  await enqueueSearchIndex('part', part.id, 'upsert');
  await enqueueEmbed('PART', part.id);

  revalidatePart();
  return { ok: true, data: { id: part.id } };
}

export async function updatePart(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = updatePartSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { id, metadata, purchaseLinks, ...rest } = parsed.data;

  const data: Prisma.PartUpdateInput = { ...rest };
  if (purchaseLinks !== undefined) data.purchaseLinks = purchaseLinks as Prisma.InputJsonValue;
  if (metadata !== undefined) {
    // The schema validated metadata only when `kind` travelled with it; when it
    // did not, resolve the stored kind here.
    let kind = rest.kind;
    if (kind === undefined) {
      const existing = await prisma.part.findUnique({ where: { id }, select: { kind: true } });
      if (!existing) return { ok: false, formError: 'Part not found' };
      kind = existing.kind;
    }
    const result = partKindSchemaFor(kind).safeParse(metadata ?? {});
    if (!result.success) {
      return {
        ok: false,
        // Same keying rule as refineMetadata in ./schema — flat for the
        // freeform kind (one registered `metadata` textarea), nested for
        // structured kinds (which register `metadata.<key>` and nothing flat).
        fieldErrors: metadataFieldErrors(kind, result.error.issues),
      };
    }
    data.metadata = result.data as Prisma.InputJsonValue;
  }

  await prisma.part.update({ where: { id }, data });

  await enqueueSearchIndex('part', id, 'upsert');
  await enqueueEmbed('PART', id);

  revalidatePart(id);
  return { ok: true, data: { id } };
}

export async function archivePart(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  await prisma.part.update({ where: { id }, data: { archivedAt: new Date() } });
  // Upsert, not delete: archived rows stay in the index, same as items.
  await enqueueSearchIndex('part', id, 'upsert');
  // The embedding, unlike the search doc, is tombstoned for an archived part —
  // buildCanonical returns null and embedEntity deletes the rows.
  await enqueueEmbed('PART', id);

  revalidatePart(id);
  return { ok: true, data: undefined };
}

export async function restorePart(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  await prisma.part.update({ where: { id }, data: { archivedAt: null } });
  await enqueueSearchIndex('part', id, 'upsert');
  await enqueueEmbed('PART', id);

  revalidatePart(id);
  return { ok: true, data: undefined };
}

// ---------- PartLink ----------

const linkPartInput = z
  .object({
    partId: z.string().min(1),
    itemId: z.string().min(1).optional().nullable(),
    systemId: z.string().min(1).optional().nullable(),
    location: z.string().max(200).optional().nullable(),
    quantityInstalled: z.coerce.number().int().positive().optional().nullable(),
  })
  .refine((v) => Boolean(v.itemId) !== Boolean(v.systemId), {
    message: 'Link a part to exactly one item or system',
    path: ['partId'],
  });

export async function linkPartToParent(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = linkPartInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { partId, itemId, systemId, location, quantityInstalled } = parsed.data;

  try {
    const link = await prisma.partLink.create({
      data: {
        partId,
        itemId: itemId ?? null,
        systemId: systemId ?? null,
        location: location ?? null,
        quantityInstalled: quantityInstalled ?? null,
      },
    });
    await revalidateLink(partId, itemId, systemId);
    return { ok: true, data: { id: link.id } };
  } catch (error) {
    // The `NULLS NOT DISTINCT` unique on (partId, itemId, systemId) makes a
    // repeat link a P2002. Linking something already linked is a no-op the user
    // asked for, not an error to surface.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await prisma.partLink.findFirst({
        where: { partId, itemId: itemId ?? null, systemId: systemId ?? null },
        select: { id: true },
      });
      await revalidateLink(partId, itemId, systemId);
      if (existing) return { ok: true, data: { id: existing.id } };
    }
    throw error;
  }
}

const unlinkPartInput = z.object({ linkId: z.string().min(1) });

export async function unlinkPart(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = unlinkPartInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const removed = await prisma.partLink.delete({ where: { id: parsed.data.linkId } });
  await revalidateLink(removed.partId, removed.itemId, removed.systemId);
  return { ok: true, data: undefined };
}

// The part's search doc and its embedding both denormalize its parents' names,
// so a link change makes them stale — re-index and re-embed alongside the
// revalidation.
async function revalidateLink(partId: string, itemId?: string | null, systemId?: string | null) {
  await enqueueSearchIndex('part', partId, 'upsert');
  await enqueueEmbed('PART', partId);
  revalidatePart(partId);
  if (itemId) revalidatePath(`/items/${itemId}`);
  if (systemId) revalidatePath(`/systems/${systemId}`);
}
