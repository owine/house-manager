import sharp from 'sharp';
import { getLogger } from '@/lib/logger';

const log = getLogger('ocr.normalize-image');

// Cap the longest edge before OCR. Bigger rasters cost CPU/memory without
// improving Tesseract accuracy (it's happiest around ~300 DPI; document text
// is legible well under this), and this bounds resource use on large phone
// photos. `withoutEnlargement` makes the resize a no-op for smaller images.
const MAX_OCR_DIMENSION = 4000;

/**
 * Decode an image buffer (JPEG/PNG/WebP/TIFF/HEIC/HEIF — whatever the
 * runtime libvips supports), bake in EXIF orientation, downscale to a sane
 * max dimension, and re-encode as PNG so Tesseract gets a clean,
 * correctly-rotated raster. Returns null if sharp/libvips can't decode the
 * input (undecodable HEIC where HEIF isn't available, or corrupt bytes) —
 * callers treat null as a decode failure rather than crashing. Mirrors the
 * graceful-bail pattern in thumbnail.ts.
 */
export async function normalizeImageForOcr(buf: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(buf, { failOn: 'none' })
      .rotate()
      .resize(MAX_OCR_DIMENSION, MAX_OCR_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch (err) {
    log.warn({ err }, 'normalize-image: sharp could not decode; skipping OCR for this image');
    return null;
  }
}
