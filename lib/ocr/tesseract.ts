import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';

const log = getLogger('ocr.tesseract');

// Tesseract.js carries a sizeable wasm + language data payload. Use one
// shared worker per Node process — the worker is reusable across many
// recognize() calls and the cold-start cost (~1–3s) only hits the first
// invocation. We type the worker as `unknown` here because the
// tesseract.js types are quite heavy and we only need a narrow surface;
// the runtime cast is local.

let workerPromise: Promise<unknown> | null = null;

async function getWorker(): Promise<unknown> {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    // tesseract.js@7 has no `exports` field in package.json, so under Node
    // ESM a destructured named import depends on `cjs-module-lexer` parsing
    // its CJS dist correctly. Today it works, but if the upstream ever ships
    // a webpacked/minified bundle the named extraction can fail (same shape
    // as the rrule bug fixed in PR #195). Use `default ?? namespace` so we
    // get whatever the runtime hands us. See feedback_esm_cjs_interop.
    const mod = await import('tesseract.js');
    const { createWorker } = (mod.default ?? mod) as { createWorker: typeof mod.createWorker };
    const worker = await createWorker('eng');
    log.info('tesseract: worker initialized (lang=eng)');
    return worker;
  })();
  return workerPromise;
}

/**
 * Run OCR over an image buffer. Returns the extracted text trimmed.
 * Honors the `OCR_BACKEND` env: when set to `'none'`, returns the empty
 * string immediately — useful for CI and for users who want to disable
 * the heavy local OCR pipeline. The worker is shared process-wide; the
 * first call pays the initialization cost, subsequent calls are warm.
 */
export async function ocrImageBuffer(buf: Buffer): Promise<string> {
  const { OCR_BACKEND } = getEnv();
  if (OCR_BACKEND === 'none') return '';
  const worker = (await getWorker()) as {
    recognize: (data: Buffer) => Promise<{ data: { text: string } }>;
  };
  const { data } = await worker.recognize(buf);
  return (data.text ?? '').trim();
}
