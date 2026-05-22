import { readFile } from 'node:fs/promises';
import { resolveStoragePath } from '@/lib/attachments/storage';
import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';

const log = getLogger('incoming-email-pdf-attachments');

// Keep PDF attachment input bounded so a single email with a huge invoice
// can't drive token usage off a cliff. Anthropic charges per-page on
// documents (~1500-3000 tokens / page); these caps assume ~5-page PDFs.
// Any PDF over MAX_PDF_BYTES is skipped (the model would still accept it,
// but the input cost is hard to justify for the marginal extraction gain).
const MAX_PDF_ATTACHMENTS = 5;
const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB per PDF
const MAX_TOTAL_PDF_BYTES = 25 * 1024 * 1024; // 25 MB across all attachments

export type LoadedPdf = { filename: string; base64: string; bytes: number };

/**
 * Read up to MAX_PDF_ATTACHMENTS PDFs off disk, base64-encode each, and
 * return them ready for the messages.parse `document` content blocks. Caps
 * per-file size and aggregate size to keep token usage bounded.
 *
 * Non-PDF attachments are skipped — Anthropic supports image attachments
 * via a different content-block type, but vendor invoices in PDF form
 * cover the immediate use case. Adding image support would be a follow-up.
 */
export async function loadPdfAttachments(emailId: string): Promise<LoadedPdf[]> {
  const env = getEnv();
  const rows = await prisma.attachment.findMany({
    where: { incomingEmailId: emailId, mimeType: 'application/pdf' },
    select: { filename: true, sizeBytes: true, storagePath: true },
    orderBy: { createdAt: 'asc' },
  });

  const out: LoadedPdf[] = [];
  let runningBytes = 0;
  for (const a of rows) {
    if (out.length >= MAX_PDF_ATTACHMENTS) break;
    if (!a.storagePath) continue;
    const size = a.sizeBytes ?? 0;
    if (size > MAX_PDF_BYTES) {
      log.warn(
        { emailId, filename: a.filename, sizeBytes: size, cap: MAX_PDF_BYTES },
        'pdf-attachments: skipping PDF over per-file cap',
      );
      continue;
    }
    if (runningBytes + size > MAX_TOTAL_PDF_BYTES) {
      log.warn(
        { emailId, filename: a.filename, runningBytes, cap: MAX_TOTAL_PDF_BYTES },
        'pdf-attachments: skipping PDF; aggregate cap reached',
      );
      continue;
    }
    try {
      const abs = resolveStoragePath(env.FILES_DIR, a.storagePath);
      const buf = await readFile(abs);
      out.push({
        filename: a.filename ?? 'attachment.pdf',
        base64: buf.toString('base64'),
        bytes: buf.byteLength,
      });
      runningBytes += buf.byteLength;
    } catch (err) {
      log.warn(
        { err, emailId, filename: a.filename, storagePath: a.storagePath },
        'pdf-attachments: failed to read PDF attachment',
      );
    }
  }
  return out;
}
