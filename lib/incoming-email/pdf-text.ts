import { readFile } from 'node:fs/promises';
import { resolveStoragePath } from '@/lib/attachments/storage';
import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { extractPdfText } from '@/lib/pdf/text';

const log = getLogger('incoming-email.pdf-text');

// Caps for the *classifier's* PDF preview — much tighter than the extractor's
// caps because the classifier only needs the first chunk of text for regex
// matching (`BODY_CLASSIFY_LIMIT = 500`, `BODY_ENTITY_LIMIT = 1000`).
const MAX_PDFS = 3;
const MAX_PER_PDF_BYTES = 2 * 1024 * 1024; // 2 MB — skip enormous PDFs
const MAX_CONCAT_CHARS = 5000; // hard cap on returned text length

/**
 * Read the email's PDF attachments off disk and return their concatenated
 * plain text. Used by the classifier worker so emails whose substantive
 * content lives in a PDF (e.g. an "Inspection Report" with a boilerplate
 * body of "see attached") can still classify against kind / vendor /
 * entity heuristics. Returns an empty string if nothing was extractable
 * for any reason — callers always have the original `bodyText` to fall
 * back on.
 *
 * Intentionally separate from `lib/incoming-email/pdf-attachments.ts`'s
 * `loadPdfAttachments` helper (used by the classify job): that one
 * base64-encodes for Anthropic, this one decodes to text via `unpdf` for
 * cheap regex matching. No network calls.
 */
export async function loadPdfTextForEmail(emailId: string): Promise<string> {
  const rows = await prisma.attachment.findMany({
    where: { incomingEmailId: emailId, mimeType: 'application/pdf' },
    select: { filename: true, sizeBytes: true, storagePath: true },
    orderBy: { createdAt: 'asc' },
    take: MAX_PDFS,
  });
  if (rows.length === 0) return '';

  // Delay env access until we know there are PDFs to load — the FILES_DIR
  // path is only needed for the read step below.
  const env = getEnv();

  const chunks: string[] = [];
  let runningChars = 0;
  for (const a of rows) {
    if (!a.storagePath) continue;
    if ((a.sizeBytes ?? 0) > MAX_PER_PDF_BYTES) {
      log.info(
        { emailId, filename: a.filename, sizeBytes: a.sizeBytes },
        'pdf-text: skipping PDF over per-file cap',
      );
      continue;
    }
    try {
      const abs = resolveStoragePath(env.FILES_DIR, a.storagePath);
      const buf = await readFile(abs);
      const remaining = MAX_CONCAT_CHARS - runningChars;
      if (remaining <= 0) break;
      const { text } = await extractPdfText(buf, { maxChars: remaining });
      if (text.length > 0) {
        chunks.push(text);
        runningChars += text.length;
      }
    } catch (err) {
      log.warn(
        { err, emailId, filename: a.filename, storagePath: a.storagePath },
        'pdf-text: failed to extract PDF text',
      );
    }
  }
  return chunks.join('\n\n');
}
