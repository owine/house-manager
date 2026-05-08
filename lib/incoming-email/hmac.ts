import { createHmac, timingSafeEqual } from 'node:crypto';

export function computeWebhookSignature(rawBody: string, key: string): string {
  return createHmac('sha256', key).update(rawBody, 'utf8').digest('hex');
}

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  key: string,
): boolean {
  if (!signatureHeader || !key) return false;
  const expected = computeWebhookSignature(rawBody, key);
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(expected, 'hex');
    b = Buffer.from(signatureHeader.trim(), 'hex');
  } catch {
    return false;
  }
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
