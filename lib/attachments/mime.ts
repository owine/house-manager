import { fileTypeFromBuffer } from 'file-type';

export const ALLOWED_MIME = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
]);

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

export function extensionFor(mime: string): string {
  const ext = EXT_BY_MIME[mime];
  if (!ext) throw new Error(`unsupported MIME: ${mime}`);
  return ext;
}

/**
 * Read the file-type signature from the first ~12 bytes and verify it
 * matches the claimed MIME. Returns true only if the magic bytes match.
 */
export async function verifyMagicBytes(buf: Buffer, claimedMime: string): Promise<boolean> {
  if (!ALLOWED_MIME.has(claimedMime)) return false;
  const detected = await fileTypeFromBuffer(buf);
  if (!detected) return false;
  return detected.mime === claimedMime;
}

/** The type for bytes we will not let a browser interpret. */
export const OCTET_STREAM = 'application/octet-stream';

/**
 * The type to STORE for bytes from someone we don't trust: what the magic
 * bytes say, if that is one of ALLOWED_MIME, else `application/octet-stream`.
 * A declared Content-Type is deliberately not a parameter. For inbound email
 * it is the sender's claim, and that claim is the whole S-H1 attack.
 */
export async function sniffAllowedMime(buf: Buffer): Promise<string> {
  const detected = await fileTypeFromBuffer(buf);
  return detected && ALLOWED_MIME.has(detected.mime) ? detected.mime : OCTET_STREAM;
}
