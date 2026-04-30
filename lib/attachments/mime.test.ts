import { describe, expect, it } from 'vitest';
import { ALLOWED_MIME, extensionFor, verifyMagicBytes } from './mime';

describe('ALLOWED_MIME', () => {
  it('contains exactly the five allowed types', () => {
    expect(ALLOWED_MIME).toEqual(
      new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']),
    );
  });
});

describe('extensionFor', () => {
  it.each([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
    ['image/heic', 'heic'],
    ['application/pdf', 'pdf'],
  ])('maps %s to %s', (mime, ext) => {
    expect(extensionFor(mime)).toBe(ext);
  });

  it('throws for unknown MIME', () => {
    expect(() => extensionFor('image/gif')).toThrow();
  });
});

describe('verifyMagicBytes', () => {
  it('accepts a JPEG buffer with claim image/jpeg', async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
    await expect(verifyMagicBytes(buf, 'image/jpeg')).resolves.toBe(true);
  });

  it('accepts a PNG buffer with claim image/png', async () => {
    // PNG magic (8 bytes) + IHDR chunk length (4 bytes) + IHDR type (4 bytes) = 16 bytes minimum for file-type detection
    const buf = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52,
    ]);
    await expect(verifyMagicBytes(buf, 'image/png')).resolves.toBe(true);
  });

  it('accepts a PDF buffer with claim application/pdf', async () => {
    const buf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    await expect(verifyMagicBytes(buf, 'application/pdf')).resolves.toBe(true);
  });

  it('rejects a JPEG buffer claiming PNG', async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    await expect(verifyMagicBytes(buf, 'image/png')).resolves.toBe(false);
  });

  it('rejects a totally unknown buffer', async () => {
    const buf = Buffer.from([
      0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
    ]);
    await expect(verifyMagicBytes(buf, 'image/jpeg')).resolves.toBe(false);
  });
});
