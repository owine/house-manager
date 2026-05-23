import { createId } from '@paralleldrive/cuid2';
import { Prisma } from '@prisma/client';
import { atomicWrite } from '@/lib/attachments/storage';
import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { enqueueSearchIndex } from '@/lib/search/client';
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

  // Decode every attachment to a Buffer up-front so we can write before the DB
  // insert; if a write fails we'd rather fail before persisting half a row.
  const attachmentWrites: Array<{
    storagePath: string;
    filename: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
  }> = [];

  for (const att of parsed.attachments) {
    const buffer = Buffer.from(att.content.data);
    const id = createId();
    const dir = `inbound/${id.slice(0, 2)}/${id}`;
    const baseName = att.filename ?? `attachment-${id}`;
    // Strip path separators in supplied filename — defense against an attacker
    // (or buggy mailer) crafting `../escape.pdf`. resolveStoragePath also
    // catches this, but failing here gives a cleaner error.
    const safeName = baseName.replace(/[/\\]/g, '_');
    const storagePath = await atomicWrite(env.FILES_DIR, dir, safeName, buffer);
    attachmentWrites.push({
      storagePath,
      filename: att.filename ?? null,
      mimeType: att.contentType ?? null,
      sizeBytes: att.size ?? buffer.length,
    });
  }

  const fromAddress = parsed.from.value[0].address;
  const fromName = parsed.from.value[0].name ?? null;
  const receivedAt = parsed.date ?? new Date();
  const headersJson = (parsed.headers ?? {}) as Prisma.InputJsonValue;
  const authResultsJson = {
    dkim: parsed.dkim ?? null,
    spf: parsed.spf ?? null,
    dmarc: parsed.dmarc ?? null,
  } as Prisma.InputJsonValue;

  try {
    const created = await prisma.$transaction(async (tx) => {
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
    for (const id of created.attachmentIds) {
      await enqueueSearchIndex('attachment', id, 'upsert');
    }
    return { id: created.email.id, duplicate: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // TOCTOU: a concurrent retry of the same Message-ID committed first.
      // Surface the existing row instead of erroring; the attachments we just
      // wrote will end up orphaned on disk but unreferenced in DB. Acceptable
      // tradeoff vs. a coordinated lock — in practice this race is very rare.
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
}
