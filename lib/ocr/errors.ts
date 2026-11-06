/**
 * OCR could not run at all: tesseract failed to initialize (no language data,
 * an init timeout, a thread crash during init), or that failure is still being
 * reused inside the retry cooldown.
 *
 * Distinct from every other OCR failure because it says nothing about the
 * input. Init never sees the file, so a row that failed this way is safe to
 * re-extract later without risking a loop on a hostile file. A thread that dies
 * *during* recognize is not this error, because that could be the file's fault.
 *
 * Its own module so callers (and their test mocks of ./tesseract) can import
 * the class without loading tesseract.js.
 */
export class OcrUnavailableError extends Error {
  override name = 'OcrUnavailableError';
}

/**
 * The `extractedError` the extract job stores for a row that failed with
 * OcrUnavailableError. The one failure embed.backfill re-enqueues, for the
 * reason above.
 */
export const OCR_UNAVAILABLE = 'ocr_unavailable';
