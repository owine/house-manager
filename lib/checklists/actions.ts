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

// CHECKLIST_ITEM embeddings are keyed by ChecklistItem.id, because the loader
// in lib/embedding/index.ts looks up a *ChecklistItem* by it. A checklist id
// finds nothing, and the job tombstones zero rows and reports success (Q-H1).
// Sequential, not Promise.all: concurrent first calls to getBoss() each start
// their own pg-boss instance (A-M1).
async function enqueueChecklistItemEmbeds(itemIds: string[]): Promise<void> {
  for (const itemId of itemIds) await enqueueEmbed('CHECKLIST_ITEM', itemId);
}

async function itemIdsOf(checklistId: string): Promise<string[]> {
  const rows = await prisma.checklistItem.findMany({
    where: { checklistId },
    select: { id: true },
  });
  return rows.map((r) => r.id);
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
  // The checklist name is part of every item's embedded text.
  await enqueueChecklistItemEmbeds(await itemIdsOf(id));
  revalidatePath('/checklists');
  revalidatePath(`/checklists/${id}`);
  return { ok: true, data: { id } };
}

export async function deleteChecklist(id: string): Promise<ActionResult> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  // Capture BEFORE the delete: the FK cascade removes the items, and no cascade
  // reaches the polymorphic embeddings table. Each job then finds its row gone
  // and tombstones it.
  const itemIds = await itemIdsOf(id);
  await prisma.checklist.delete({ where: { id } });
  await enqueueSearchIndex('checklist', id, 'delete');
  await enqueueChecklistItemEmbeds(itemIds);
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
  await enqueueEmbed('CHECKLIST_ITEM', created.id);
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
  // The job finds the row gone and tombstones its embeddings.
  await enqueueEmbed('CHECKLIST_ITEM', input.id);
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
  // Don't reindex search — completion status isn't a search field. It IS part
  // of the embedded text ("Status: completed"), so re-embed.
  await enqueueEmbed('CHECKLIST_ITEM', id);
  revalidatePath(`/checklists/${row.checklistId}`);
  return { ok: true, data: undefined };
}

export async function resetChecklist(input: { id: string }): Promise<ActionResult> {
  const u = await requireUser();
  if (!u) return { ok: false, formError: 'Unauthorized' };
  const reset = await prisma.checklistItem.updateManyAndReturn({
    where: { checklistId: input.id, completedAt: { not: null } },
    data: { completedAt: null },
    select: { id: true },
  });
  // Status is embedded; only the rows this call actually flipped changed.
  await enqueueChecklistItemEmbeds(reset.map((r) => r.id));
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
  revalidatePath(`/checklists/${checklistId}`);
  return { ok: true, data: undefined };
}
