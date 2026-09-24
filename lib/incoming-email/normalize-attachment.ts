import { extensionFor, OCTET_STREAM, sniffAllowedMime } from '@/lib/attachments/mime';

// Not exported: knip flags exported types with no importer.
type NormalizedInboundAttachment = {
  /** Shown in the UI and sent in Content-Disposition. Never used as a path. */
  filename: string;
  /** Sniffed from the bytes. The sender's declared Content-Type is ignored. */
  mimeType: string;
  /** On-disk basename. A fixed shape, so no sender input reaches the filesystem. */
  storageName: string;
};

/**
 * Everything an email sender controls about an attachment, reduced to values
 * that are safe to store.
 *
 * - The type comes from the bytes (allow-listed, else octet-stream). The
 *   declared Content-Type was the S-H1 vector.
 * - The on-disk name is always `original.<ext>`, as for user uploads. The
 *   sender's name used to be written to disk, and `.`, `..` or `''` made
 *   `atomicWrite` rename onto a directory: a 500 that ForwardEmail retried
 *   forever (A-H2).
 * - A missing or degenerate display name gets a generated one, which also
 *   satisfies the `Attachment_file_metadata_required` CHECK (no null filename
 *   or mimeType on a stored file).
 */
export async function normalizeInboundAttachment(input: {
  filename: string | null | undefined;
  buffer: Buffer;
  /** Used when the supplied name is unusable, e.g. `attachment-<id>`. */
  fallbackStem: string;
}): Promise<NormalizedInboundAttachment> {
  const mimeType = await sniffAllowedMime(input.buffer);
  const ext = mimeType === OCTET_STREAM ? 'bin' : extensionFor(mimeType);
  // \p{Cc}: control chars (CR/LF/TAB/NUL). \p{Cf}: format chars, incl. bidi
  // overrides like U+202E that make "x\u202Efdp.exe" display as "xexe.pdf".
  const cleaned = (input.filename ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  const filename =
    cleaned === '' || cleaned === '.' || cleaned === '..'
      ? `${input.fallbackStem}.${ext}`
      : cleaned;
  return { filename, mimeType, storageName: `original.${ext}` };
}
