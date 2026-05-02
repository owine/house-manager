'use server';
import { createId } from '@paralleldrive/cuid2';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { getBoss, Queue } from '@/lib/queue';
import type { ActionResult } from '@/lib/result';
import { enqueueSearchIndex } from '@/lib/search/client';
import { ALLOWED_MIME, extensionFor, verifyMagicBytes } from './mime';
import { addAttachmentLinkSchema, type ParentType, uploadAttachmentSchema } from './schema';
import { atomicWrite, removeDir } from './storage';

const MAX_BYTES = 25_000_000;

const FK_FIELD: Record<ParentType, 'itemId' | 'warrantyId' | 'serviceRecordId' | 'noteId'> = {
  item: 'itemId',
  warranty: 'warrantyId',
  serviceRecord: 'serviceRecordId',
  note: 'noteId',
};

const REVALIDATE_PATH: Record<ParentType, (id: string) => string[]> = {
  item: (id) => [`/items/${id}`, '/dashboard'],
  warranty: (id) => [`/warranties/${id}`, '/dashboard'],
  serviceRecord: (id) => [`/service/${id}`, '/dashboard'],
  note: (id) => [`/notes/${id}`, '/dashboard'],
};

async function parentExists(parentType: ParentType, id: string): Promise<boolean> {
  switch (parentType) {
    case 'item':
      return !!(await prisma.item.findUnique({ where: { id }, select: { id: true } }));
    case 'warranty':
      return !!(await prisma.warranty.findUnique({ where: { id }, select: { id: true } }));
    case 'serviceRecord':
      return !!(await prisma.serviceRecord.findUnique({ where: { id }, select: { id: true } }));
    case 'note':
      return !!(await prisma.note.findUnique({ where: { id }, select: { id: true } }));
  }
}

export async function uploadAttachment(formData: FormData): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };
  const uploadedById = session.user.id;
  if (!uploadedById) return { ok: false, formError: 'Unauthorized' };
  const env = getEnv();

  const parsed = uploadAttachmentSchema.safeParse({
    parentType: formData.get('parentType'),
    parentId: formData.get('parentId'),
  });
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { parentType, parentId } = parsed.data;

  const file = formData.get('file');
  if (!(file instanceof File)) return { ok: false, formError: 'No file provided' };
  if (file.size > MAX_BYTES) return { ok: false, formError: 'File exceeds 25 MB limit' };
  if (!ALLOWED_MIME.has(file.type)) return { ok: false, formError: 'Unsupported file type' };

  const buffer = Buffer.from(await file.arrayBuffer());
  if (!(await verifyMagicBytes(buffer, file.type))) {
    return { ok: false, formError: 'File contents do not match declared type' };
  }

  if (!(await parentExists(parentType, parentId))) {
    return { ok: false, formError: 'Parent not found' };
  }

  const id = createId();
  const ext = extensionFor(file.type);
  const storagePath = `${id}/original.${ext}`;

  try {
    await atomicWrite(env.FILES_DIR, id, `original.${ext}`, buffer);
  } catch (e) {
    return { ok: false, formError: `Storage error: ${(e as Error).message}` };
  }

  try {
    const created = await prisma.attachment.create({
      data: {
        id,
        filename: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        storagePath,
        uploadedById,
        [FK_FIELD[parentType]]: parentId,
      },
      select: { id: true },
    });
    await enqueueSearchIndex('attachment', created.id, 'upsert');

    if (file.type.startsWith('image/')) {
      try {
        const boss = await getBoss();
        await boss.send(Queue.Thumbnail, { attachmentId: id });
      } catch (e) {
        // Queue failure is logged-but-not-fatal — the upload still succeeded.
        console.error('[attachments] failed to enqueue thumbnail job', e);
      }
    }

    for (const p of REVALIDATE_PATH[parentType](parentId)) revalidatePath(p);
    return { ok: true, data: { id: created.id } };
  } catch (e) {
    // DB write failed after the file landed on disk — clean up the directory.
    await removeDir(env.FILES_DIR, id).catch(() => {});
    return { ok: false, formError: `Database error: ${(e as Error).message}` };
  }
}

export async function deleteAttachment(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };
  const env = getEnv();

  const row = await prisma.attachment.findUnique({
    where: { id },
    select: { itemId: true, warrantyId: true, serviceRecordId: true, noteId: true },
  });
  if (!row) return { ok: false, formError: 'Not found' };

  await prisma.attachment.delete({ where: { id } });
  await enqueueSearchIndex('attachment', id, 'delete');
  await removeDir(env.FILES_DIR, id).catch((e) => {
    console.error('[attachments] failed to remove storage dir', e);
  });

  if (row.itemId) revalidatePath(`/items/${row.itemId}`);
  if (row.warrantyId) revalidatePath(`/warranties/${row.warrantyId}`);
  if (row.serviceRecordId) revalidatePath(`/service/${row.serviceRecordId}`);
  if (row.noteId) revalidatePath(`/notes/${row.noteId}`);
  revalidatePath('/dashboard');

  return { ok: true, data: undefined };
}

export async function addAttachmentLink(formData: FormData): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };
  const uploadedById = session.user.id;
  if (!uploadedById) return { ok: false, formError: 'Unauthorized' };

  const parsed = addAttachmentLinkSchema.safeParse({
    parentType: formData.get('parentType'),
    parentId: formData.get('parentId'),
    externalUrl: formData.get('externalUrl'),
    displayLabel: formData.get('displayLabel') ?? undefined,
    externalProvider: formData.get('externalProvider') ?? undefined,
    externalProviderId: formData.get('externalProviderId') ?? undefined,
  });
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { parentType, parentId, externalUrl, displayLabel, externalProvider, externalProviderId } =
    parsed.data;

  if (!(await parentExists(parentType, parentId))) {
    return { ok: false, formError: 'Parent not found' };
  }

  const id = createId();
  try {
    const created = await prisma.attachment.create({
      data: {
        id,
        externalUrl,
        displayLabel: displayLabel || null,
        externalProvider: externalProvider || null,
        externalProviderId: externalProviderId || null,
        uploadedById,
        [FK_FIELD[parentType]]: parentId,
      },
      select: { id: true },
    });
    await enqueueSearchIndex('attachment', created.id, 'upsert');
    for (const p of REVALIDATE_PATH[parentType](parentId)) revalidatePath(p);
    return { ok: true, data: { id: created.id } };
  } catch (e) {
    return { ok: false, formError: `Database error: ${(e as Error).message}` };
  }
}
