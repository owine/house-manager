import { createId } from '@paralleldrive/cuid2';
import { Prisma } from '@prisma/client';
import { atomicWrite, removeDir } from '@/lib/attachments/storage';
import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { enqueueSearchIndex } from '@/lib/search/client';
import { normalizeInboundAttachment } from './normalize-attachment';
import type { ForwardEmailWebhookBody } from './schema';

const log = getLogger('incoming-email.actions');

// Single-user app: webhook deliveries aren't tied to a session, so we attribute
// every persisted Attachment to the existing user. Memoized after first lookup.
let cachedSystemUserId: string | null = null;

async function getSystemUploaderUserId(): Promise<string> {
  if (cachedSystemUserId) return cachedSystemUserId;
  const user = await prisma.user.findFirst({
    where: {},
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!user) {
    throw new Error(
      'inbound-email: no User row found to attribute attachments to. Sign in once before configuring the inbound webhook.',
    );
  }
  cachedSystemUserId = user.id;
  return user.id;
}

export type IngestResult = { id: string; duplicate: boolean };

/**
 * Persist a parsed ForwardEmail webhook payload as an `IncomingEmail` row plus
 * one `Attachment` per attachment. Idempotent on `messageId`: a re-delivery of
 * the same Message-ID returns `{ duplicate: true }` and writes nothing.
 *
 * Concurrent re-deliveries are handled via the unique-violation catch in the
 * transaction body — Prisma raises P2002 if a sibling request committed first;
 * we re-fetch by messageId and surface the same id.
 */
export async function ingestIncomingEmail(parsed: ForwardEmailWebhookBody): Promise<IngestResult> {
  const env = getEnv();
  const uploadedById = await getSystemUploaderUserId();

  // Pre-check: avoids any DB writes (and any attachment-storage I/O) for the
  // common retry-of-already-ingested case.
  const existing = await prisma.incomingEmail.findUnique({
    where: { messageId: parsed.messageId },
    select: { id: true },
  });
  if (existing) return { id: existing.id, duplicate: true };

  const fromAddress = parsed.from.value[0].address;
  const fromName = parsed.from.value[0].name ?? null;
  const receivedAt = parsed.date ?? new Date();
  const headersJson = (parsed.headers ?? {}) as Prisma.InputJsonValue;
  const authResultsJson = {
    dkim: parsed.dkim ?? null,
    spf: parsed.spf ?? null,
    dmarc: parsed.dmarc ?? null,
  } as Prisma.InputJsonValue;

  // Every attachment directory this call creates. If anything below fails they
  // are removed before the error propagates. The webhook then answers 500 and
  // ForwardEmail retries, and without this each retry would leave another full
  // copy of the attachments on disk with no row pointing at it.
  const writtenDirs: string[] = [];

  let created: { email: { id: string }; attachmentIds: string[] };
  try {
    // Write every attachment before the DB insert: if a write fails we'd
    // rather fail before persisting half a row.
    const attachmentWrites: Array<{
      storagePath: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
    }> = [];

    for (const att of parsed.attachments) {
      const buffer = Buffer.from(att.content.data);
      const id = createId();
      const dir = `inbound/${id.slice(0, 2)}/${id}`;
      // The sender controls this part's filename and Content-Type, and neither
      // is trusted: the stored type comes from the bytes, the on-disk name is
      // fixed, and a missing/degenerate name gets a generated one.
      const normalized = await normalizeInboundAttachment({
        filename: att.filename,
        buffer,
        fallbackStem: `attachment-${id}`,
      });
      writtenDirs.push(dir);
      const storagePath = await atomicWrite(env.FILES_DIR, dir, normalized.storageName, buffer);
      attachmentWrites.push({
        storagePath,
        filename: normalized.filename,
        mimeType: normalized.mimeType,
        sizeBytes: att.size ?? buffer.length,
      });
    }

    created = await prisma.$transaction(async (tx) => {
      const email = await tx.incomingEmail.create({
        data: {
          messageId: parsed.messageId,
          fromAddress,
          fromName,
          subject: parsed.subject,
          receivedAt,
          bodyText: parsed.text ?? null,
          bodyHtml: parsed.html ?? null,
          headersJson,
          authResultsJson,
        },
        select: { id: true },
      });
      const attachmentIds: string[] = [];
      if (attachmentWrites.length > 0) {
        // createMany doesn't return rows; re-select by the unique parent edge.
        await tx.attachment.createMany({
          data: attachmentWrites.map((a) => ({
            incomingEmailId: email.id,
            uploadedById,
            ...a,
          })),
        });
        const rows = await tx.attachment.findMany({
          where: { incomingEmailId: email.id },
          select: { id: true },
        });
        attachmentIds.push(...rows.map((r) => r.id));
      }
      return { email, attachmentIds };
    });
  } catch (err) {
    // Nothing we wrote is referenced: either the transaction never ran or it
    // rolled back.
    await Promise.all(writtenDirs.map((dir) => removeDir(env.FILES_DIR, dir).catch(() => {})));
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // TOCTOU: a concurrent retry of the same Message-ID committed first.
      // Surface the existing row instead of erroring. Its own attachments are
      // on disk; ours were just removed above.
      log.warn(
        { messageId: parsed.messageId },
        'inbound-email: concurrent insert race resolved via existing row',
      );
      const winner = await prisma.incomingEmail.findUnique({
        where: { messageId: parsed.messageId },
        select: { id: true },
      });
      if (winner) return { id: winner.id, duplicate: true };
    }
    throw err;
  }

  // Outside the try on purpose: a failure here must never delete files that
  // committed rows point at. (enqueueSearchIndex swallows its own errors anyway.)
  for (const id of created.attachmentIds) {
    await enqueueSearchIndex('attachment', id, 'upsert');
  }
  return { id: created.email.id, duplicate: false };
}
