# OCR Image Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize every image through `sharp` (decode incl. HEIC/HEIF, apply EXIF rotation, re-encode PNG) before OCR in the attachment-text extractor; add test coverage for the image-normalize unit, the already-shipped PDF renderer, and the extractor's dispatch; fix the stale TODO comment.

**Architecture:** New pure helper `lib/ocr/normalize-image.ts` (`normalizeImageForOcr(buf) → Buffer | null`), called from the image branch of `worker/jobs/extract-attachment-text.ts` (null → `extractedError: 'image_decode_failed'`). PDF render/OCR path is unchanged (already implemented) — only newly tested. No Dockerfile change (`vips-heif` already present).

**Tech Stack:** `sharp@0.34.5`, `pdf-to-png-converter@4.0.0`, `tesseract.js@7.0.0` (OCR disabled in CI via `OCR_BACKEND='none'`), Vitest 4 + Testcontainers, Biome 2. No new deps.

**Spec:** `docs/superpowers/specs/2026-05-20-ocr-image-normalize-design.md`

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `lib/ocr/normalize-image.ts` | create | `normalizeImageForOcr(buf) → Buffer \| null`; pure sharp transform |
| `lib/ocr/normalize-image.test.ts` | create | unit (real sharp; no Tesseract) |
| `tests/fixtures/sample.pdf` | create | minimal 1-page PDF fixture for the render test |
| `lib/pdf/render.test.ts` | create | characterization test of shipped `renderPdfPagesToPng` |
| `worker/jobs/extract-attachment-text.ts` | modify | image branch normalizes first; `image_decode_failed`; fix stale comment |
| `tests/integration/extract-attachment-text.test.ts` | create | dispatch/branching coverage (OCR + render mocked) |

---

## Task 1: `normalizeImageForOcr` helper (TDD)

**Files:** Create `lib/ocr/normalize-image.test.ts`, `lib/ocr/normalize-image.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/ocr/normalize-image.test.ts
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
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
    // Create a 20x10 image tagged orientation 6 (90° CW). After rotate(),
    // sharp swaps dimensions → output should be 10x20.
    const tagged = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#fff' } })
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

  it('does not throw on a HEIC input — decodes to PNG or returns null', async () => {
    // The test environment's sharp may or may not have HEIF support. We only
    // require graceful handling (PNG or null), never a throw. Use a tiny
    // not-really-HEIC buffer with a heic-ish header so the call exercises the
    // decode-attempt path; the assertion is "no throw + null-or-png".
    const fakeHeic = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftypheic'),
      Buffer.alloc(32),
    ]);
    const out = await normalizeImageForOcr(fakeHeic);
    expect(out === null || isPng(out)).toBe(true);
  });
});
```

- [ ] **Step 2: Run → confirm failure**

Run: `pnpm vitest run lib/ocr/normalize-image.test.ts`
Expected: FAIL — `Cannot find module './normalize-image'`.

- [ ] **Step 3: Implement `lib/ocr/normalize-image.ts`**

```ts
import sharp from 'sharp';
import { getLogger } from '@/lib/logger';

const log = getLogger('ocr.normalize-image');

/**
 * Decode an image buffer (JPEG/PNG/WebP/TIFF/HEIC/HEIF — whatever the
 * runtime libvips supports), bake in EXIF orientation, and re-encode as PNG
 * so Tesseract gets a clean, correctly-rotated raster. Returns null if
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

- [ ] **Step 4: Run → confirm pass**

Run: `pnpm vitest run lib/ocr/normalize-image.test.ts`
Expected: 5/5 PASS. If the EXIF-orientation case behaves unexpectedly on this sharp version (some versions need the orientation set differently), verify with a quick check and adjust the *fixture construction* (not the rotate assertion) — the point is that `.rotate()` applies orientation.

- [ ] **Step 5: `pnpm verify`**

Expected: lint + typecheck + unit green.

- [ ] **Step 6: Commit**

```bash
git add lib/ocr/normalize-image.ts lib/ocr/normalize-image.test.ts
git commit -m "feat(ocr): add normalizeImageForOcr (sharp decode + EXIF rotate + PNG)"
```

---

## Task 2: Characterization test for the shipped PDF renderer

**Files:** Create `tests/fixtures/sample.pdf`, `lib/pdf/render.test.ts`.

`renderPdfPagesToPng` is already implemented and shipped untested. This is a *characterization* test — it should pass immediately against the existing code (it documents+locks current behavior). If it fails, that's a real latent bug in shipped code worth surfacing.

- [ ] **Step 1: Create a minimal 1-page PDF fixture**

Create `tests/fixtures/sample.pdf` — a minimal valid single-page PDF that `pdf-to-png-converter` (pdfjs) can rasterize. Generate it deterministically rather than hand-writing bytes:

```bash
node -e '
const { PDFDocument } = require("pdf-lib");
' 2>/dev/null && echo "pdf-lib available" || echo "no pdf-lib"
```
If `pdf-lib` is NOT a dependency, do NOT add it. Instead create the fixture with a tiny inline valid PDF written via Node:
```bash
node -e "
const fs=require('fs');
const pdf='%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 30 100 Td (Hello PDF) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \n0000000209 00000 n \n0000000300 00000 n \ntrailer<</Size 6/Root 1 0 R>>\nstartxref\n371\n%%EOF';
fs.writeFileSync('tests/fixtures/sample.pdf', pdf);
console.log('wrote', fs.statSync('tests/fixtures/sample.pdf').size, 'bytes');
"
```
Then VERIFY the fixture actually rasterizes before relying on it:
```bash
node -e "
(async () => {
  const { pdfToPng } = await import('pdf-to-png-converter');
  const buf = require('fs').readFileSync('tests/fixtures/sample.pdf');
  const pages = await pdfToPng(buf, { returnPageContent: true, pagesToProcess: [1] });
  console.log('pages:', pages.length, 'firstContentBytes:', pages[0]?.content?.length);
})().catch(e => { console.error('RASTERIZE FAILED:', e.message); process.exit(1); });
"
```
If the inline PDF does not rasterize (xref offsets are finicky), fall back to: check whether `pdfkit` or `pdf-lib` is already in the dependency tree (`node -e "require.resolve('pdf-lib')"`); if one is, use it to generate the fixture. If neither exists, STOP and report — do NOT add a new dependency just for a fixture; instead ask the controller (a tiny real PDF can be provided).

- [ ] **Step 2: Write the test**

```ts
// lib/pdf/render.test.ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { renderPdfPagesToPng } from './render';

function isPng(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

describe('renderPdfPagesToPng', () => {
  it('rasterizes a 1-page PDF to a PNG buffer', async () => {
    const pdf = await readFile('tests/fixtures/sample.pdf');
    const pages = await renderPdfPagesToPng(pdf);
    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(isPng(pages[0] as Buffer)).toBe(true);
  });

  it('respects the maxPages cap', async () => {
    const pdf = await readFile('tests/fixtures/sample.pdf');
    const pages = await renderPdfPagesToPng(pdf, { maxPages: 1 });
    expect(pages.length).toBeLessThanOrEqual(1);
  });

  it('returns [] for non-PDF bytes (graceful)', async () => {
    const pages = await renderPdfPagesToPng(Buffer.from('not a pdf'));
    expect(pages).toEqual([]);
  });
});
```

- [ ] **Step 3: Run → expect PASS (characterization)**

Run: `pnpm vitest run lib/pdf/render.test.ts`
Expected: PASS (covering shipped code). If the rasterize cases FAIL, that's a real bug in the shipped renderer or a bad fixture — investigate; if it's the renderer, report as DONE_WITH_CONCERNS with details.

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/sample.pdf lib/pdf/render.test.ts
git commit -m "test(pdf): characterization tests for renderPdfPagesToPng"
```

---

## Task 3: Wire normalization into the extractor + fix comment + dispatch test

**Files:** Modify `worker/jobs/extract-attachment-text.ts`; create `tests/integration/extract-attachment-text.test.ts`.

- [ ] **Step 1: Read the current file**

Read `worker/jobs/extract-attachment-text.ts`. Note: it uses the module-scope `prisma` from `@/lib/db` (NOT injected), reads `getEnv()` for `ASK_ENABLED` + `FILES_DIR`, and the image branch is `extractedText = await ocrImageBuffer(buf); ocrUsed = extractedText.length > 0;`.

- [ ] **Step 2: Write the failing integration test**

Model on `tests/integration/thumbnail-worker.test.ts` (FILES_DIR tmpdir + `atomicWrite` + fixture) combined with the dynamic-import + `vi.mock` pattern from `tests/integration/notify-job.test.ts`. The extractor reads module `prisma` and `getEnv()`, so:
- `vi.mock('@/lib/ocr/tesseract', ...)` → `ocrImageBuffer` returns a fixed string (capture calls).
- `vi.mock('@/lib/pdf/render', ...)` → `renderPdfPagesToPng` returns a controllable value (e.g. `[Buffer.from('png')]`).
- `vi.mock('@/lib/ocr/normalize-image', ...)` → `normalizeImageForOcr` returns a controllable value (Buffer or null) so you can drive both the success and `image_decode_failed` branches without depending on real sharp.
- `vi.mock('@/lib/pdf/text', ...)` → `extractPdfText` returns `{ text }` you control (above/below `TEXT_LAYER_FALLBACK_THRESHOLD`).
- `vi.mock('@/lib/embedding/enqueue', () => ({ enqueueEmbed: vi.fn() }))`.
- `vi.mock('@/lib/env', ...)` → `getEnv` returns `{ ASK_ENABLED: true, OCR_BACKEND: 'none', FILES_DIR: <the tmpdir> }`. Because FILES_DIR is created at runtime (`mkdtemp`), have the mock read a mutable module-scope `let filesDir` that you assign in `beforeAll` before the dynamic import — OR set `process.env` and have the mock factory close over a getter. (See notify-job.test.ts for the getEnv-mock idiom; adapt for the runtime FILES_DIR.)
- Dynamic-import `handleExtractAttachmentText` in `beforeAll` (DATABASE_URL trap).
- Seed an `Attachment` row (+ user/item, like thumbnail-worker) and `atomicWrite` a small fixture file at its `storagePath`.

Cases (assert via the persisted `Attachment` row after calling `handleExtractAttachmentText([{ data: { attachmentId } }])`):
1. **text-layer PDF**: `extractPdfText` mock returns long text (≥ threshold) → row `extractedText` = that text; `renderPdfPagesToPng` NOT called; `ocrUsed` false.
2. **scanned PDF**: `extractPdfText` returns short text (< threshold) → `renderPdfPagesToPng` called, `ocrImageBuffer` called per page → `extractedText` non-empty, `ocrUsed` true.
3. **image, decodable**: mime `image/jpeg`, `normalizeImageForOcr` returns a Buffer → `ocrImageBuffer` called with the normalized buffer; `extractedText` set; `ocrUsed` true; `enqueueEmbed` called.
4. **image, undecodable**: `normalizeImageForOcr` returns `null` → row `extractedError` = `'image_decode_failed'`; `ocrImageBuffer` NOT called; no embed.
5. **text/plain**: read directly → `extractedText` = file contents.
6. **unsupported mime** (e.g. `application/zip`): row `extractedError` starts with `'unsupported_mime:'`.

- [ ] **Step 3: Run → confirm failure**

Run: `pnpm vitest run tests/integration/extract-attachment-text.test.ts`
Expected: FAIL — case 3/4 fail because the current code doesn't call `normalizeImageForOcr` (it OCRs the raw buffer; `image_decode_failed` never set).

- [ ] **Step 4: Modify the image branch + import in `extract-attachment-text.ts`**

Add the import (alphabetized with the other `@/lib/...` imports):
```ts
import { normalizeImageForOcr } from '@/lib/ocr/normalize-image';
```
Replace the image branch:
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

- [ ] **Step 5: Fix the stale doc comment**

In the file's top doc comment, replace:
```
 *   - PDF OCR fallback (Tesseract.js on rendered pages): scanned docs.
 *     [TODO Phase D follow-up: actually render pages via unpdf canvas;
 *      v1 just notes the gap so we don't ship silently broken OCR.]
 *   - Image OCR (Tesseract.js): phone photos of receipts, JPG / PNG /
 *     HEIC after `sharp` normalization (HEIC support also TODO).
```
with:
```
 *   - PDF OCR fallback: scanned/image-only PDFs are rasterized page-by-page
 *     via `renderPdfPagesToPng` (pdf-to-png-converter) then OCR'd (Tesseract.js).
 *   - Image OCR: every image is first normalized via `normalizeImageForOcr`
 *     (sharp decode incl. HEIC/HEIF where libvips has HEIF, EXIF rotation,
 *     re-encode PNG), then OCR'd. Undecodable images → extractedError
 *     'image_decode_failed'.
```

- [ ] **Step 6: Run → confirm pass**

Run: `pnpm vitest run tests/integration/extract-attachment-text.test.ts`
Expected: all 6 cases PASS.

- [ ] **Step 7: `pnpm verify`**

Expected: lint + typecheck + unit green.

- [ ] **Step 8: Commit**

```bash
git add worker/jobs/extract-attachment-text.ts tests/integration/extract-attachment-text.test.ts
git commit -m "feat(ocr): normalize images via sharp before OCR; cover extractor dispatch"
```

---

## Task 4: Final verify + finishing

- [ ] **Step 1: `pnpm verify`** → green.
- [ ] **Step 2: `pnpm test:integration`** → all green incl. the new extractor test.
- [ ] **Step 3: `pnpm test:e2e` + `pnpm build`** → green, or deferred to CI if local stack/env unavailable (note it; same convention as prior PRs).
- [ ] **Step 4: Optional manual smoke** (real OCR): with `OCR_BACKEND` enabled and a real photo/scanned PDF, confirm `extractedText` is populated. Ideally on the Alpine image (`vips-heif` present) confirm a real `.heic` photo OCRs. Document in the PR as a manual check.
- [ ] **Step 5: Hand off to `superpowers:finishing-a-development-branch`** — push + PR. PR body notes: every image normalized via sharp (HEIC + EXIF), PDF render path now tested (was shipped-untested), stale comment fixed, no Dockerfile change, OCR end-to-end deferred to manual smoke (CI uses OCR_BACKEND=none).

---

## Cadence reminders

- One combined-reviewer Haiku review per task before marking complete (per `feedback_execution_cadence`).
- Don't push during execution; push via `finishing-a-development-branch`.
- All commits signed (1Password auto). Stage explicit paths. Never `--no-verify`.
- No new dependencies. If Task 2's fixture genuinely can't be generated without one, STOP and report rather than adding a dep.
- No Dockerfile/migration changes in this work (so no Prisma-drift concern here).
