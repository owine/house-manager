'use server';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { enqueueEmbed } from '@/lib/embedding/enqueue';
import type { ActionResult } from '@/lib/result';
import { enqueueSearchIndex } from '@/lib/search/client';
import { createNoteSchema, updateNoteSchema } from './schema';

async function validateItemExists(itemId: string): Promise<boolean> {
  const item = await prisma.item.findUnique({ where: { id: itemId }, select: { id: true } });
  return item !== null;
}

export async function createNote(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = createNoteSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { itemId, ...rest } = parsed.data;

  if (itemId !== undefined) {
    const exists = await validateItemExists(itemId);
    if (!exists) return { ok: false, formError: 'Item not found' };
  }

  const note = await prisma.note.create({
    data: { ...rest, itemId: itemId ?? null },
  });
  await enqueueSearchIndex('note', note.id, 'upsert');
  await enqueueEmbed('NOTE', note.id);

  revalidatePath('/notes');
  revalidatePath('/dashboard');
  if (itemId) revalidatePath(`/items/${itemId}`);

  return { ok: true, data: { id: note.id } };
}

export async function updateNote(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const parsed = updateNoteSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { id, itemId, ...rest } = parsed.data;

  // Pre-fetch the existing note's itemId before update so we can revalidate the OLD item path
  const existing = await prisma.note.findUnique({ where: { id }, select: { itemId: true } });
  if (!existing) return { ok: false, formError: 'Note not found' };

  const oldItemId = existing.itemId;

  if (itemId !== undefined) {
    const exists = await validateItemExists(itemId);
    if (!exists) return { ok: false, formError: 'Item not found' };
  }

  // Build update data — if itemId key is present in payload, include it (even if undefined → null)
  const updateData: Record<string, unknown> = { ...rest };
  if ('itemId' in parsed.data) {
    updateData.itemId = itemId ?? null;
  }

  await prisma.note.update({ where: { id }, data: updateData });
  await enqueueSearchIndex('note', id, 'upsert');
  await enqueueEmbed('NOTE', id);

  const newItemId = itemId;

  revalidatePath('/notes');
  revalidatePath(`/notes/${id}`);
  revalidatePath('/dashboard');
  if (oldItemId) revalidatePath(`/items/${oldItemId}`);
  if (newItemId && newItemId !== oldItemId) revalidatePath(`/items/${newItemId}`);

  return { ok: true, data: { id } };
}

export async function deleteNote(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };

  const existing = await prisma.note.findUnique({ where: { id }, select: { itemId: true } });
  if (!existing) return { ok: false, formError: 'Note not found' };

  await prisma.note.delete({ where: { id } });
  await enqueueSearchIndex('note', id, 'delete');
  await enqueueEmbed('NOTE', id);

  revalidatePath('/notes');
  revalidatePath('/dashboard');
  if (existing.itemId) revalidatePath(`/items/${existing.itemId}`);

  return { ok: true, data: undefined };
}
