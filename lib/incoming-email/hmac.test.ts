import { describe, expect, it } from 'vitest';
import { computeWebhookSignature, verifyWebhookSignature } from './hmac';

const KEY = 'test-key-1234567890abcdef';
const BODY = '{"messageId":"<a@example.com>"}';

describe('verifyWebhookSignature', () => {
  it('accepts a known-good signature', () => {
    const sig = computeWebhookSignature(BODY, KEY);
    expect(verifyWebhookSignature(BODY, sig, KEY)).toBe(true);
  });

  it('tolerates surrounding whitespace in the header', () => {
    const sig = computeWebhookSignature(BODY, KEY);
    expect(verifyWebhookSignature(BODY, `  ${sig}\n`, KEY)).toBe(true);
  });

  it('rejects a missing or empty header', () => {
    expect(verifyWebhookSignature(BODY, null, KEY)).toBe(false);
    expect(verifyWebhookSignature(BODY, undefined, KEY)).toBe(false);
    expect(verifyWebhookSignature(BODY, '', KEY)).toBe(false);
  });

  it('rejects a tampered body', () => {
    const sig = computeWebhookSignature(BODY, KEY);
    expect(verifyWebhookSignature(`${BODY} `, sig, KEY)).toBe(false);
  });

  it('rejects a wrong-length signature without throwing', () => {
    expect(verifyWebhookSignature(BODY, 'deadbeef', KEY)).toBe(false);
  });

  it('rejects a malformed (non-hex) signature without throwing', () => {
    expect(verifyWebhookSignature(BODY, 'not-hex-at-all-zzzz', KEY)).toBe(false);
  });

  it('rejects when the key is empty (no oracle for an "empty" verifier)', () => {
    const sig = computeWebhookSignature(BODY, KEY);
    expect(verifyWebhookSignature(BODY, sig, '')).toBe(false);
  });

  it('rejects when the wrong key was used to sign', () => {
    const sig = computeWebhookSignature(BODY, 'different-key-different-key-x');
    expect(verifyWebhookSignature(BODY, sig, KEY)).toBe(false);
  });

  it('produces a stable hex output', () => {
    expect(computeWebhookSignature('abc', KEY)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeWebhookSignature('abc', KEY)).toBe(computeWebhookSignature('abc', KEY));
  });
});
