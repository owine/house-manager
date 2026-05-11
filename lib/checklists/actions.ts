'use server';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { enqueueEmbed } from '@/lib/embedding/enqueue';
import type { ActionResult } from '@/lib/result';
import { enqueueSearchIndex } from '@/lib/search/client';
import {
  addChecklistItemSchema,
  createChecklistSchema,
  reorderChecklistItemsSchema,
  toggleChecklistItemSchema,
  updateChecklistSchema,
} from './schema';

async function requireUser() {
  const s = await auth();
  if (!s?.user) return null;
  return s.user;
}

export async function createChecklist(input: unknown): Promise<ActionResult<{ id: string }>> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  const parsed = createChecklistSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const created = await prisma.checklist.create({ data: parsed.data });
  await enqueueSearchIndex('checklist', created.id, 'upsert');
  await enqueueEmbed('CHECKLIST_ITEM', created.id);
  revalidatePath('/checklists');
  return { ok: true, data: { id: created.id } };
}

export async function updateChecklist(input: unknown): Promise<ActionResult<{ id: string }>> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  const parsed = updateChecklistSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { id, ...data } = parsed.data;
  await prisma.checklist.update({ where: { id }, data });
  await enqueueSearchIndex('checklist', id, 'upsert');
  await enqueueEmbed('CHECKLIST_ITEM', id);
  revalidatePath('/checklists');
  revalidatePath(`/checklists/${id}`);
  return { ok: true, data: { id } };
}

export async function deleteChecklist(id: string): Promise<ActionResult> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  await prisma.checklist.delete({ where: { id } });
  await enqueueSearchIndex('checklist', id, 'delete');
  await enqueueEmbed('CHECKLIST_ITEM', id);
  revalidatePath('/checklists');
  return { ok: true, data: undefined };
}

export async function addChecklistItem(input: unknown): Promise<ActionResult<{ id: string }>> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  const parsed = addChecklistItemSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { checklistId, title, itemId } = parsed.data;

  const last = await prisma.checklistItem.findFirst({
    where: { checklistId },
    orderBy: { position: 'desc' },
    select: { position: true },
  });
  const created = await prisma.checklistItem.create({
    data: { checklistId, title, itemId: itemId ?? null, position: (last?.position ?? -1) + 1 },
  });
  await enqueueSearchIndex('checklist', checklistId, 'upsert');
  await enqueueEmbed('CHECKLIST_ITEM', checklistId);
  revalidatePath(`/checklists/${checklistId}`);
  return { ok: true, data: { id: created.id } };
}

export async function deleteChecklistItem(input: { id: string }): Promise<ActionResult> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  const row = await prisma.checklistItem.delete({
    where: { id: input.id },
    select: { checklistId: true },
  });
  await enqueueSearchIndex('checklist', row.checklistId, 'upsert');
  await enqueueEmbed('CHECKLIST_ITEM', row.checklistId);
  revalidatePath(`/checklists/${row.checklistId}`);
  return { ok: true, data: undefined };
}

export async function toggleChecklistItem(input: unknown): Promise<ActionResult> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  const parsed = toggleChecklistItemSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { id, done } = parsed.data;
  const row = await prisma.checklistItem.update({
    where: { id },
    data: { completedAt: done ? new Date() : null },
    select: { checklistId: true },
  });
  // Don't reindex search — completion status isn't a search field.
  revalidatePath(`/checklists/${row.checklistId}`);
  return { ok: true, data: undefined };
}

export async function resetChecklist(input: { id: string }): Promise<ActionResult> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  await prisma.checklistItem.updateMany({
    where: { checklistId: input.id, completedAt: { not: null } },
    data: { completedAt: null },
  });
  revalidatePath(`/checklists/${input.id}`);
  revalidatePath('/checklists');
  return { ok: true, data: undefined };
}

export async function setChecklistActive(input: {
  id: string;
  active: boolean;
}): Promise<ActionResult> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  await prisma.checklist.update({
    where: { id: input.id },
    data: { active: input.active },
  });
  // The search-index already excludes inactive checklists upstream; an upsert
  // on the active state lets the indexer remove/restore appropriately.
  await enqueueSearchIndex('checklist', input.id, input.active ? 'upsert' : 'delete');
  revalidatePath(`/checklists/${input.id}`);
  revalidatePath('/checklists');
  return { ok: true, data: undefined };
}

export async function reorderChecklistItems(input: unknown): Promise<ActionResult> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  const parsed = reorderChecklistItemsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { checklistId, orderedItemIds } = parsed.data;
  await prisma.$transaction(
    orderedItemIds.map((id, position) =>
      prisma.checklistItem.update({ where: { id }, data: { position } }),
    ),
  );
  await enqueueSearchIndex('checklist', checklistId, 'upsert');
  await enqueueEmbed('CHECKLIST_ITEM', checklistId);
  revalidatePath(`/checklists/${checklistId}`);
  return { ok: true, data: undefined };
}
