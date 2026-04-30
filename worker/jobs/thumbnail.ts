import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { atomicWrite, resolveStoragePath } from '@/lib/attachments/storage';
import { prisma as defaultPrisma } from '@/lib/db';

export type ThumbnailJob = { attachmentId: string };

// db is optional so tests can inject a testcontainer-scoped PrismaClient
// without touching the production singleton.
export async function handleThumbnail(
  payload: ThumbnailJob,
  db: typeof defaultPrisma = defaultPrisma,
): Promise<void> {
  const { attachmentId } = payload;
  const filesDir = process.env.FILES_DIR;
  if (!filesDir) {
    console.error('[thumbnail] FILES_DIR is not set');
    return;
  }
  const row = await db.attachment.findUnique({
    where: { id: attachmentId },
    select: { mimeType: true, storagePath: true, thumbnailPath: true },
  });
  if (!row) return;
  if (row.thumbnailPath) return; // idempotent
  if (!row.mimeType.startsWith('image/')) return;

  let buffer: Buffer;
  try {
    const abs = resolveStoragePath(filesDir, row.storagePath);
    buffer = await readFile(abs);
  } catch (e) {
    console.error('[thumbnail] cannot read source', { attachmentId, error: (e as Error).message });
    return;
  }

  let resized: Buffer;
  try {
    resized = await sharp(buffer)
      .resize(480, 480, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch (e) {
    // sharp/libvips can fail on HEIC + corrupt files; log and bail without
    // throwing so pg-boss treats the job as done (no retry).
    console.error('[thumbnail] resize failed', {
      attachmentId,
      mimeType: row.mimeType,
      error: (e as Error).message,
    });
    return;
  }

  const rel = await atomicWrite(filesDir, attachmentId, 'thumb.webp', resized);
  await db.attachment.update({
    where: { id: attachmentId },
    data: { thumbnailPath: rel },
  });
}
