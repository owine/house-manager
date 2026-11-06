import { enqueueAttachmentExtraction, enqueueEmbed } from '@/lib/embedding/enqueue';
import { enqueueSearchIndex } from '@/lib/search/client';
import type { CreateServiceRecordFromEmailResult } from './create-service-record';

/**
 * Post-commit side effects of drafting a service record from an email, shared
 * by the auto-stub job and the inbox's "Create service record" action so the
 * two cannot drift (they once did, for three months: #399). Each enqueue
 * swallows its own errors.
 *
 * The linked attachments are also queued for text EXTRACTION, not just an embed.
 * Linking is the point where an email's file becomes the member's (they, or
 * the DMARC + bound-sender auto-stub gate, accepted it), so it is now fair
 * game for Ask. Before this, an emailed invoice on a service record was never
 * extracted and Ask could not see it. The extract job chains the embed.
 */
export async function enqueueDraftFollowUps(
  created: CreateServiceRecordFromEmailResult,
): Promise<void> {
  await enqueueSearchIndex('service', created.serviceRecordId, 'upsert');
  await enqueueEmbed('SERVICE_RECORD', created.serviceRecordId);
  for (const attachmentId of created.linkedAttachmentIds) {
    // Re-embed now: an already-extracted file's text names its parent
    // ("Linked to serviceRecord: …"). And extract the ones never extracted,
    // without re-OCRing the rest on every re-draft.
    await enqueueEmbed('ATTACHMENT', attachmentId);
    await enqueueAttachmentExtraction(attachmentId, { onlyIfUnextracted: true });
  }
}
