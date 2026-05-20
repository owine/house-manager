# OCR Image Normalization (Phase D follow-up) — Design

**Date:** 2026-05-20
**Status:** Design — pending review

## Problem

`worker/jobs/extract-attachment-text.ts` extracts text from attachments for the `/ask` RAG index. A stale `[TODO Phase D follow-up]` comment claims PDF page rendering is unimplemented and HEIC support is missing. Investigation shows:

- **PDF text-layer extraction** (`unpdf`) — works.
- **PDF scanned-page render → OCR** — already implemented (`lib/pdf/render.ts` via `pdf-to-png-converter`, wired into the orchestrator) but **untested**, and the comment wrongly says it's a TODO using "unpdf canvas."
- **Image OCR** — the image branch passes the raw buffer straight to Tesseract.js with **no `sharp` normalization** (the comment's "after sharp normalization" was never coded). Consequences:
  - **HEIC/HEIF** (iPhone default) isn't decodable by Tesseract.js → those photos OCR-fail.
  - EXIF-rotated photos (common on phones) OCR poorly because Tesseract is orientation-sensitive.
- **No test coverage** for any extraction path.

## Goals

- Route **every** image through `sharp` before OCR: decode (incl. HEIC/HEIF), apply EXIF rotation, output a Tesseract-friendly PNG.
- Graceful failure: an undecodable image marks `extractedError` instead of crashing.
- Add test coverage for the image-normalize unit, the existing PDF renderer, and the orchestrator's dispatch/branching.
- Fix the stale/inaccurate TODO comment.

## Non-goals

- No change to the PDF render/OCR code (already implemented; this work only *tests* it).
- No Tesseract end-to-end test in CI (the wasm + language-data payload is why `OCR_BACKEND='none'` exists; real OCR stays a manual smoke).
- No new OCR languages beyond `eng`; no layout/multi-column OCR.
- No Dockerfile change — the runtime Alpine image already installs `vips=8.17.3-r1` + `vips-heif=8.17.3-r1`.
- No new runtime dependency (`sharp@0.34.5` is already present and used by `thumbnail.ts` / `classify.ts`).

## Background facts (verified)

- Deps present: `sharp@0.34.5`, `pdf-to-png-converter@4.0.0`, `tesseract.js@7.0.0`, `unpdf@1.6.2`.
- `worker/jobs/thumbnail.ts` already runs images through `sharp` (incl. attempted HEIC) and gracefully bails on decode failure — the exact pattern this work reuses for the OCR path.
- The Dockerfile runtime stage installs `vips-heif`, so HEIC decode capability exists in production. CI/dev `sharp` HEIF support is uncertain; the design degrades gracefully either way.
- `lib/ocr/tesseract.ts` `ocrImageBuffer` short-circuits to `''` when `OCR_BACKEND='none'`.

## Architecture

One new pure helper + one orchestrator change + tests + comment fix.

| Unit | Status | Responsibility |
|---|---|---|
| `lib/ocr/normalize-image.ts` | create | `normalizeImageForOcr(buf) → Buffer \| null` — sharp decode + EXIF rotate + PNG; `null` on undecodable. Pure. |
| `lib/ocr/normalize-image.test.ts` | create | unit tests (real sharp) |
| `lib/pdf/render.test.ts` | create | tests the already-shipped `renderPdfPagesToPng` |
| `worker/jobs/extract-attachment-text.ts` | modify | image branch normalizes first; `image_decode_failed` on null; fix stale comment |
| `tests/integration/extract-attachment-text.test.ts` | create | dispatch/branching coverage (OCR + render mocked) |

### `normalizeImageForOcr`

```ts
import sharp from 'sharp';
import { getLogger } from '@/lib/logger';

const log = getLogger('ocr.normalize-image');

/**
 * Decode an image buffer (JPEG/PNG/WebP/TIFF/HEIC/HEIF — whatever the
 * runtime libvips supports), bake in EXIF orientation, and re-encode as
 * PNG so Tesseract gets a clean, correctly-rotated raster. Returns null if
 * sharp/libvips can't decode the input (undecodable HEIC where HEIF isn't
 * available, or corrupt bytes) — callers treat null as a decode failure
 * rather than crashing. Mirrors the graceful-bail pattern in thumbnail.ts.
 */
export async function normalizeImageForOcr(buf: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(buf, { failOn: 'none' }).rotate().png().toBuffer();
  } catch (err) {
    log.warn({ err }, 'normalize-image: sharp could not decode; skipping OCR for this image');
    return null;
  }
}
```

`rotate()` with no args applies the EXIF orientation tag. `failOn: 'none'` tolerates minor corruption (decode what's possible) rather than throwing on the first warning.

### Orchestrator change (`extract-attachment-text.ts`, image branch)

Replace:
```ts
} else if (mime.startsWith('image/')) {
  extractedText = await ocrImageBuffer(buf);
  ocrUsed = extractedText.length > 0;
}
```
with:
```ts
} else if (mime.startsWith('image/')) {
  const normalized = await normalizeImageForOcr(buf);
  if (!normalized) {
    extractedError = 'image_decode_failed';
  } else {
    extractedText = await ocrImageBuffer(normalized);
    ocrUsed = extractedText.length > 0;
  }
}
```
Add the import. The outer try/catch (`extract_threw`) and the `OCR_BACKEND='none'` short-circuit inside `ocrImageBuffer` remain the backstops. Every image — not just HEIC — now benefits from EXIF rotation + format standardization.

### Comment fix

Replace the inaccurate bullet lines in the file's doc comment:
```
 *   - PDF OCR fallback (Tesseract.js on rendered pages): scanned docs.
 *     [TODO Phase D follow-up: actually render pages via unpdf canvas;
 *      v1 just notes the gap so we don't ship silently broken OCR.]
 *   - Image OCR (Tesseract.js): phone photos of receipts, JPG / PNG /
 *     HEIC after `sharp` normalization (HEIC support also TODO).
```
with an accurate description: PDF pages rendered via `pdf-to-png-converter` (`lib/pdf/render.ts`); images normalized via `sharp` (`normalizeImageForOcr`) — decode + EXIF rotate + PNG, incl. HEIC/HEIF where libvips has HEIF — then OCR'd; undecodable images marked `image_decode_failed`.

## Error handling

| Case | Outcome |
|---|---|
| Image sharp can't decode (HEIC w/o HEIF, corrupt) | `normalizeImageForOcr` returns `null` → `extractedError: 'image_decode_failed'`; no crash |
| `OCR_BACKEND='none'` | normalization runs, `ocrImageBuffer` returns `''` → empty text, no embed enqueued (existing behavior) |
| PDF render returns 0 pages | `extractedError: 'pdf_render_failed'` (existing) |
| Any unexpected throw | outer catch → `extractedError: 'extract_threw'` (existing) |

## Testing

CI constraint: Tesseract is heavy and disabled via `OCR_BACKEND='none'`; tests avoid invoking real OCR.

- **`lib/ocr/normalize-image.test.ts`** (unit, real sharp, no Tesseract):
  - A synthesized JPEG with EXIF orientation → output is PNG (magic bytes) and dimensions reflect applied rotation.
  - PNG input → PNG output (round-trips, decodable).
  - Garbage / non-image bytes → returns `null` (asserts NO throw).
  - HEIC fixture (tiny): asserts graceful — output is either a decodable PNG (if the test env's libvips has HEIF) or `null`; **never throws**. (Keeps the test green regardless of CI's HEIF support.)
- **`lib/pdf/render.test.ts`** (unit, real `pdf-to-png-converter`, no Tesseract):
  - Tiny committed fixture PDF → `renderPdfPagesToPng` returns ≥1 buffer; first buffer has PNG magic bytes. Closes the zero-coverage gap on shipped code.
  - `maxPages` cap respected (fixture with >maxPages pages, or assert slice behavior with maxPages=1).
- **`tests/integration/extract-attachment-text.test.ts`** (integration, Testcontainers; mock `@/lib/ocr/tesseract` + `@/lib/pdf/render` + `@/lib/ocr/normalize-image`):
  - text-layer PDF (≥ threshold) → `extractedText` stored, render NOT called.
  - low-text PDF → render + per-page OCR path invoked; `ocrUsed` true.
  - image with decodable normalize → `normalizeImageForOcr` called, then `ocrImageBuffer` on the normalized buffer.
  - image where `normalizeImageForOcr` returns `null` → `extractedError: 'image_decode_failed'`, OCR not called, no embed enqueued.
  - `text/*` → read directly; unsupported mime → `unsupported_mime:...`.
  - `aiIndexable=false` / missing storagePath / read failure → existing skip/error paths still hold.

End-to-end real-Tesseract OCR (scanned PDF / photo → actual text) is a **manual smoke** with `OCR_BACKEND` enabled, ideally on the Alpine image to confirm real HEIC decode.

## Risks

- **CI sharp HEIF support unknown:** the HEIC unit test asserts "decodes-or-null, never throws," so it's green regardless. Real HEIC OCR is confirmed by the manual Alpine smoke. If CI's sharp *can't* decode HEIC, that's fine — production (with `vips-heif`) can.
- **Fixture files:** the tiny PDF and image fixtures are committed binaries; keep them minimal (a 1-page generated PDF, a small generated JPEG/PNG; HEIC fixture only if a tiny one is available — otherwise the HEIC test synthesizes/depends on env and asserts no-throw).
- **`sharp` + system libvips linkage:** production relies on the apk `vips`/`vips-heif`; unchanged by this work. No Dockerfile change.

## Out of scope / future

- Additional OCR languages, layout-aware OCR, deskew/denoise preprocessing.
- Running real Tesseract in CI (would require shipping/caching the wasm + langdata; deliberately avoided).
- Backfill: existing image attachments that failed extraction before this ships aren't reprocessed automatically. The admin "rebuild" path (Plan 4c Phase G) can re-extract if desired; not in scope here.
