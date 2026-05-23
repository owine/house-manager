import { readFile } from 'node:fs/promises';
import { resolveStoragePath } from '@/lib/attachments/storage';
import { prisma } from '@/lib/db';
import { enqueueEmbed } from '@/lib/embedding/enqueue';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { normalizeImageForOcr } from '@/lib/ocr/normalize-image';
import { ocrImageBuffer } from '@/lib/ocr/tesseract';
import { renderPdfPagesToPng } from '@/lib/pdf/render';
import { extractPdfText } from '@/lib/pdf/text';
import { enqueueSearchIndex } from '@/lib/search/client';

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
        // Image-only / scanned PDF: render each page to PNG and OCR via
        // Tesseract. Capped at 20 pages (lib/pdf/render.ts) so a 200-page
        // manual doesn't monopolize a worker tick. OCR'd pages get joined
        // with a form-feed-ish separator so downstream chunking knows
        // where one page ends and another begins.
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
  await enqueueSearchIndex('attachment', attachmentId, 'upsert');
}
