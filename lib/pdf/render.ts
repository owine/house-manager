import { getLogger } from '@/lib/logger';

const log = getLogger('pdf.render');

export type RenderPdfOptions = {
  /** Cap on pages rendered. Each page is an OCR call, so bound this. */
  maxPages?: number;
  /** Render scale; higher = better OCR quality but slower. Default 2. */
  viewportScale?: number;
};

/**
 * Render each page of a PDF buffer to a PNG buffer. Uses
 * `pdf-to-png-converter` which wraps pdfjs-dist + @napi-rs/canvas — pure
 * JS, no native build deps to wrestle. Returns PNG bytes per page in
 * document order; callers downstream (OCR) iterate.
 *
 * Bounded by `maxPages` (default 20) so a 200-page manual doesn't ruin
 * a worker tick.
 */
export async function renderPdfPagesToPng(
  buf: Buffer,
  opts: RenderPdfOptions = {},
): Promise<Buffer[]> {
  const maxPages = opts.maxPages ?? 20;
  const viewportScale = opts.viewportScale ?? 2;

  // Lazy-load so the wasm + canvas deps stay out of paths that never
  // touch image-only PDFs.
  const { pdfToPng } = await import('pdf-to-png-converter');

  try {
    const pages = await pdfToPng(buf, {
      viewportScale,
      // v4 defaults `returnPageContent` to false (memory-conservative);
      // we need the Buffer to feed Tesseract, so flip it.
      returnPageContent: true,
      pagesToProcess: Array.from({ length: maxPages }, (_, i) => i + 1),
    });
    return pages
      .slice(0, maxPages)
      .map((p) => p.content)
      .filter((b): b is Buffer => b !== undefined);
  } catch (err) {
    log.warn({ err }, 'pdf.render: page rasterization failed');
    return [];
  }
}
