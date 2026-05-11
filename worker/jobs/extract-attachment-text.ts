import { readFile } from 'node:fs/promises';
import { resolveStoragePath } from '@/lib/attachments/storage';
import { prisma } from '@/lib/db';
import { enqueueEmbed } from '@/lib/embedding/enqueue';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { ocrImageBuffer } from '@/lib/ocr/tesseract';
import { extractPdfText } from '@/lib/pdf/text';

const log = getLogger('worker.extract-attachment-text');

export type ExtractAttachmentTextJob = { attachmentId: string };

// PDFs with a text layer below this threshold get OCR'd page-by-page. Most
// invoices / inspection reports clear it on page 1; scanned docs trigger
// the fallback path.
const TEXT_LAYER_FALLBACK_THRESHOLD = 200;

// Hard cap on stored text per attachment. Chunking still happens at the
// embedding layer; this cap exists so a giant manual doesn't bloat the
// row beyond what Postgres TEXT comfortably stores.
const MAX_TEXT_LENGTH = 256_000;

/**
 * Per-attachment text extraction. Dispatches by mime type and writes
 * `extractedText` / `extractedAt` / `extractedError` / `ocrUsed` back
 * onto the Attachment row, then enqueues an embed-content job so the
 * Ask index picks up the new content.
 *
 *   - PDF text-layer (unpdf): primary path for invoices, reports, manuals.
 *   - PDF OCR fallback (Tesseract.js on rendered pages): scanned docs.
 *     [TODO Phase D follow-up: actually render pages via unpdf canvas;
 *      v1 just notes the gap so we don't ship silently broken OCR.]
 *   - Image OCR (Tesseract.js): phone photos of receipts, JPG / PNG /
 *     HEIC after `sharp` normalization (HEIC support also TODO).
 *   - text/* and markdown: read directly.
 *   - Everything else: marked extracted with reason='unsupported_mime'.
 *
 * Skips entirely when ASK_ENABLED=false (no point doing local OCR if
 * the indexer isn't going to consume it).
 */
export async function handleExtractAttachmentText(
  jobs: { data: ExtractAttachmentTextJob }[],
): Promise<void> {
  const env = getEnv();
  if (!env.ASK_ENABLED) {
    log.debug({ count: jobs.length }, 'extract-attachment-text: ASK_ENABLED=false, skipping');
    return;
  }

  for (const { data } of jobs) {
    await extractOne(data.attachmentId, env.FILES_DIR);
  }
}

async function extractOne(attachmentId: string, filesDir: string): Promise<void> {
  const row = await prisma.attachment.findUnique({
    where: { id: attachmentId },
    select: {
      id: true,
      mimeType: true,
      storagePath: true,
      aiIndexable: true,
      filename: true,
    },
  });
  if (!row) {
    log.warn({ attachmentId }, 'extract-attachment-text: row not found');
    return;
  }
  if (row.aiIndexable === false) {
    log.info({ attachmentId }, 'extract-attachment-text: aiIndexable=false; skipping');
    return;
  }
  if (!row.storagePath) {
    await mark(attachmentId, {
      extractedError: 'no_storage_path',
      ocrUsed: false,
    });
    return;
  }

  let buf: Buffer;
  try {
    buf = await readFile(resolveStoragePath(filesDir, row.storagePath));
  } catch (err) {
    log.warn({ err, attachmentId }, 'extract-attachment-text: read failed');
    await mark(attachmentId, { extractedError: 'read_failed', ocrUsed: false });
    return;
  }

  const mime = row.mimeType ?? '';
  let extractedText = '';
  let ocrUsed = false;
  let extractedError: string | null = null;

  try {
    if (mime === 'application/pdf') {
      const { text } = await extractPdfText(buf);
      if (text.length >= TEXT_LAYER_FALLBACK_THRESHOLD) {
        extractedText = text;
      } else {
        // No usable text layer. Page-render OCR fallback lives in a
        // follow-up — for now mark as needing OCR.
        extractedError = 'pdf_needs_ocr_fallback_unimplemented';
        log.info({ attachmentId }, 'extract-attachment-text: PDF text layer too short');
      }
    } else if (mime.startsWith('image/')) {
      extractedText = await ocrImageBuffer(buf);
      ocrUsed = extractedText.length > 0;
    } else if (mime.startsWith('text/') || mime === 'application/json') {
      extractedText = buf.toString('utf8');
    } else {
      extractedError = `unsupported_mime:${mime || 'unknown'}`;
    }
  } catch (err) {
    log.error({ err, attachmentId, mime }, 'extract-attachment-text: failed');
    await mark(attachmentId, { extractedError: 'extract_threw', ocrUsed });
    return;
  }

  const truncated = extractedText.slice(0, MAX_TEXT_LENGTH);
  await mark(attachmentId, {
    extractedText: truncated || null,
    extractedError,
    ocrUsed,
  });

  if (truncated.length > 0) {
    await enqueueEmbed('ATTACHMENT', attachmentId);
  }

  log.info(
    {
      attachmentId,
      mime,
      ocrUsed,
      chars: truncated.length,
      extractedError,
    },
    'extract-attachment-text: complete',
  );
}

async function mark(
  attachmentId: string,
  data: {
    extractedText?: string | null;
    extractedError?: string | null;
    ocrUsed: boolean;
  },
): Promise<void> {
  await prisma.attachment.update({
    where: { id: attachmentId },
    data: {
      extractedText: data.extractedText ?? null,
      extractedAt: new Date(),
      extractedError: data.extractedError ?? null,
      ocrUsed: data.ocrUsed,
    },
  });
}
