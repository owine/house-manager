import { readFile } from 'node:fs/promises';
import { resolveStoragePath } from '@/lib/attachments/storage';
import { prisma } from '@/lib/db';
import { enqueueEmbed } from '@/lib/embedding/enqueue';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { OCR_UNAVAILABLE, OcrUnavailableError } from '@/lib/ocr/errors';
import { normalizeImageForOcr } from '@/lib/ocr/normalize-image';
import { ensureOcrAvailable, ocrImageBuffer } from '@/lib/ocr/tesseract';
import { renderPdfPagesToPng } from '@/lib/pdf/render';
import { extractPdfText, PdfMemoryError, PdfTimeoutError } from '@/lib/pdf/text';
import { enqueueSearchIndex } from '@/lib/search/client';

const log = getLogger('worker.extract-attachment-text');

export type ExtractAttachmentTextJob = {
  attachmentId: string;
  /**
   * Set by embed.backfill's OCR retry. Boot, the nightly run and an admin
   * Rebuild can enqueue the same row before the queue drains; only the first
   * job should find it still `ocr_unavailable`.
   */
  onlyIfOcrUnavailable?: boolean;
  /**
   * Set by embed.backfill's never-extracted pass, for the same reason: skip a
   * row some other job has extracted since it was queued.
   */
  onlyIfUnextracted?: boolean;
};

/**
 * Stored before the decode and overwritten when it finishes, with `extractedAt`
 * still null. A decode that never returns (a native crash in sharp/libvips, an
 * OOM kill) leaves it behind: pg-boss still retries the job, since the row is
 * unextracted, but embed.backfill skips the row instead of re-queuing it at
 * every boot, which would crash-loop the worker on the same file.
 */
const EXTRACT_INTERRUPTED = 'extract_interrupted';

/**
 * Caps for an email-sourced PDF's text layer. Its bytes are the sender's, so
 * tighter than a member upload's, but a whole invoice still fits easily.
 */
const INBOUND_PDF_CAPS = { maxPages: 50, timeoutMs: 30_000 } as const;

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
 *   - PDF OCR fallback: scanned/image-only PDFs are rasterized page-by-page
 *     via `renderPdfPagesToPng` (pdf-to-png-converter) then OCR'd (Tesseract.js).
 *   - Image OCR: every image is first normalized via `normalizeImageForOcr`
 *     (sharp decode incl. HEIC/HEIF where libvips has HEIF, EXIF rotation,
 *     re-encode PNG), then OCR'd. Undecodable images → extractedError
 *     'image_decode_failed'.
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
    await extractOne(data, env.FILES_DIR);
  }
}

async function extractOne(job: ExtractAttachmentTextJob, filesDir: string): Promise<void> {
  const { attachmentId } = job;
  const row = await prisma.attachment.findUnique({
    where: { id: attachmentId },
    select: {
      id: true,
      mimeType: true,
      storagePath: true,
      aiIndexable: true,
      filename: true,
      extractedError: true,
      extractedAt: true,
      incomingEmailId: true,
      serviceRecordId: true,
    },
  });
  if (!row) {
    log.warn({ attachmentId }, 'extract-attachment-text: row not found');
    return;
  }
  if (job.onlyIfOcrUnavailable && row.extractedError !== OCR_UNAVAILABLE) {
    log.debug({ attachmentId }, 'extract-attachment-text: OCR retry already done; skipping');
    return;
  }
  if (job.onlyIfUnextracted && row.extractedAt !== null) {
    log.debug({ attachmentId }, 'extract-attachment-text: already extracted; skipping');
    return;
  }
  // The Ask boundary for email-sourced files, enforced here so every enqueuer
  // inherits it: an attachment that is still only in the inbox is untriaged
  // sender content, and its text must not reach Ask's prompt. It is queued
  // again when a service record is drafted from the email (after-draft.ts).
  const fromEmail = row.incomingEmailId !== null;
  if (fromEmail && row.serviceRecordId === null) {
    log.debug({ attachmentId }, 'extract-attachment-text: inbox-only email attachment; skipping');
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

  await prisma.attachment.update({
    where: { id: attachmentId },
    data: { extractedError: EXTRACT_INTERRUPTED },
  });

  const mime = row.mimeType ?? '';
  let extractedText = '';
  let ocrUsed = false;
  let extractedError: string | null = null;

  try {
    if (mime === 'application/pdf' && fromEmail) {
      // Sender bytes: the bounded text layer only, never the render + OCR
      // fallback (lib/pdf/render.ts has no deadline and runs native canvas
      // code). Whatever text there is, however short, is kept.
      const { text } = await extractPdfText(buf, {
        maxChars: MAX_TEXT_LENGTH,
        ...INBOUND_PDF_CAPS,
      });
      extractedText = text;
      if (text.length === 0) extractedError = 'inbound_pdf_no_text_layer';
    } else if (mime === 'application/pdf') {
      // maxChars lets a long text-layer PDF stop decoding at what we keep.
      const { text } = await extractPdfText(buf, { maxChars: MAX_TEXT_LENGTH });
      if (text.length >= TEXT_LAYER_FALLBACK_THRESHOLD) {
        extractedText = text;
      } else {
        // Image-only / scanned PDF: render each page to PNG and OCR via
        // Tesseract. Capped at 20 pages (lib/pdf/render.ts) so a 200-page
        // manual doesn't monopolize a worker tick. OCR'd pages get joined
        // with a form-feed-ish separator so downstream chunking knows
        // where one page ends and another begins.
        // Before rasterizing: during an OCR outage this throws at once.
        await ensureOcrAvailable();
        const pages = await renderPdfPagesToPng(buf);
        if (pages.length === 0) {
          extractedError = 'pdf_render_failed';
          log.info({ attachmentId }, 'extract-attachment-text: PDF page render returned 0 pages');
        } else {
          const pageTexts: string[] = [];
          for (const [i, png] of pages.entries()) {
            const pageText = await ocrImageBuffer(png);
            if (pageText) {
              pageTexts.push(`[page ${i + 1}]\n${pageText}`);
            }
          }
          extractedText = pageTexts.join('\n\n');
          ocrUsed = extractedText.length > 0;
          if (extractedText.length === 0) {
            extractedError = 'pdf_ocr_returned_empty';
          }
        }
      }
    } else if (mime.startsWith('image/')) {
      // Before the sharp decode: during an OCR outage this throws at once.
      await ensureOcrAvailable();
      const normalized = await normalizeImageForOcr(buf);
      if (!normalized) {
        extractedError = 'image_decode_failed';
      } else {
        extractedText = await ocrImageBuffer(normalized);
        ocrUsed = extractedText.length > 0;
      }
    } else if (mime.startsWith('text/') || mime === 'application/json') {
      extractedText = buf.toString('utf8');
    } else {
      extractedError = `unsupported_mime:${mime || 'unknown'}`;
    }
  } catch (err) {
    if (err instanceof OcrUnavailableError) {
      // OCR is down (init failed, or its cooldown is running), not broken by
      // this file. embed.backfill re-enqueues these rows at every boot and
      // nightly. warn, not error: tesseract.ts reports the init failure once,
      // and this fires for every attachment that arrives during the outage.
      log.warn({ err, attachmentId, mime }, 'extract-attachment-text: OCR unavailable; will retry');
      await mark(attachmentId, { extractedError: OCR_UNAVAILABLE, ocrUsed: false });
      return;
    }
    if (fromEmail && mime === 'application/pdf') {
      // Sender bytes that hit the inbound caps or do not parse: expected, so
      // warn (not reported), as classify does for the same PDFs.
      const code = inboundPdfErrorCode(err);
      log.warn({ err, attachmentId, code }, 'extract-attachment-text: inbound PDF not decoded');
      await mark(attachmentId, { extractedError: code, ocrUsed: false });
      return;
    }
    log.error({ err, attachmentId, mime }, 'extract-attachment-text: failed');
    await mark(attachmentId, { extractedError: 'extract_threw', ocrUsed });
    return;
  }

  // Postgres `text` rejects NUL outright (22021), and a PDF text layer can
  // carry one. Without this the write throws after a successful decode and
  // strands the row at extract_interrupted, which backfill never retries.
  const truncated = extractedText.replaceAll('\u0000', '').slice(0, MAX_TEXT_LENGTH);
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

function inboundPdfErrorCode(err: unknown): string {
  if (err instanceof PdfTimeoutError) return 'inbound_pdf_timeout';
  if (err instanceof PdfMemoryError) return 'inbound_pdf_too_large';
  return 'inbound_pdf_unreadable';
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
  await enqueueSearchIndex('attachment', attachmentId, 'upsert');
}
