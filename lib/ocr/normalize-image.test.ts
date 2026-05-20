import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { normalizeImageForOcr } from './normalize-image';

// PNG magic bytes: 89 50 4E 47
function isPng(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

describe('normalizeImageForOcr', () => {
  it('returns a PNG buffer for a valid PNG input', async () => {
    const png = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();
    const out = await normalizeImageForOcr(png);
    expect(out).not.toBeNull();
    expect(isPng(out as Buffer)).toBe(true);
  });

  it('returns a PNG buffer for a JPEG input', async () => {
    const jpg = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#000' } })
      .jpeg()
      .toBuffer();
    const out = await normalizeImageForOcr(jpg);
    expect(out).not.toBeNull();
    expect(isPng(out as Buffer)).toBe(true);
  });

  it('applies EXIF orientation (rotates dimensions)', async () => {
    // 20x10 image tagged orientation 6 (90° CW). After rotate(), sharp swaps
    // dimensions → output should be 10x20.
    const tagged = await sharp({
      create: { width: 20, height: 10, channels: 3, background: '#fff' },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const out = await normalizeImageForOcr(tagged);
    expect(out).not.toBeNull();
    const meta = await sharp(out as Buffer).metadata();
    expect(meta.width).toBe(10);
    expect(meta.height).toBe(20);
  });

  it('returns null for non-image bytes (no throw)', async () => {
    const out = await normalizeImageForOcr(Buffer.from('this is not an image'));
    expect(out).toBeNull();
  });

  it('does not throw on a HEIC-ish input — decodes to PNG or returns null', async () => {
    const fakeHeic = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftypheic'),
      Buffer.alloc(32),
    ]);
    const out = await normalizeImageForOcr(fakeHeic);
    expect(out === null || isPng(out)).toBe(true);
  });
});
