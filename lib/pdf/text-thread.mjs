// The PDF text decode, and the worker-thread entry that runs it for
// ./text.ts.
//
// Plain ESM on purpose: Node starts this file directly in a worker_thread,
// outside tsx, so neither TypeScript nor the `@/` alias exists here. It lives
// under lib/ because the runtime image copies lib/. text.ts references it as
// `new URL('./text-thread.mjs', import.meta.url)`, which is the form the
// worker-graph guard and the prune follow, so the `unpdf` it imports stays in
// the runtime image.
//
// Why a thread at all: one hostile page can burn CPU inside a single
// getTextContent (repeated content refs, nested Form XObjects, a flate bomb),
// and no page or char cap reaches inside one page. Nor can a timer in the same
// thread: pdf.js's fake worker and evaluator yield through microtasks only,
// so a setTimeout scheduled before the parse cannot fire until it finishes. (A
// ~2 KB PDF of nested XObjects held one getTextContent for ~2s, during which a
// 10ms interval ticked zero times.) In its own thread, the parent's timer
// stays live and `terminate()` stops even a synchronous loop.
//
// BOUND THE WORK, NOT JUST THE OUTPUT. unpdf's own `extractText` decodes every
// page concurrently (`Promise.all` over `numPages`) and only then returns, so
// slicing its result to `maxChars` capped the string while the parse itself
// stayed unbounded: a small inbound PDF declaring many pages pinned the
// classify worker, and `maxChars` never triggered because the pages carried no
// text. Pages are therefore decoded one at a time, at most `maxPages` of them,
// stopping as soon as `maxChars` is reached.

import { isMainThread, parentPort, workerData } from 'node:worker_threads';

/**
 * Generous: member-uploaded manuals for Ask indexing, where `maxChars` is what
 * bounds a normal document. Not for hostile input; pass a small `maxPages`.
 */
export const DEFAULT_MAX_PAGES = 2000;

/** Tags the workerData this file acts on, so importing it never runs a job. */
export const PDF_TEXT_JOB = 'pdf-text';

/** Same whitespace normalization as unpdf's `mergePages: true`. */
function normalizeMergedText(texts) {
  return texts
    .join('\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

export async function decodePdfText(bytes, opts = {}) {
  // Dynamic: the wasm + parser is ~1 MB, and importing this module (for its
  // constants, or in a test) should not pay for it.
  const { getDocumentProxy } = await import('unpdf');
  // unpdf's own loader, so its Node options (cMap and standard-font URLs from
  // the pdfjs-dist pnpm hoists for pdf-to-png-converter) apply exactly as they
  // do for unpdf's extractText; mirroring them by hand already diverged once.
  // Inside the try, so the finally destroys the task of any document that
  // loads. One that fails to load leaves its task with no handle; it dies with
  // this thread, which the parent always terminates (text.ts).
  let pdf;
  try {
    pdf = await getDocumentProxy(bytes);
    const pageCount = pdf.numPages;
    const last = Math.min(pageCount, opts.maxPages ?? DEFAULT_MAX_PAGES);
    const pages = [];
    let chars = 0;
    for (let n = 1; n <= last; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const text = content.items
        .filter((item) => item.str != null)
        .map((item) => item.str + (item.hasEOL ? '\n' : ''))
        .join('');
      page.cleanup();
      pages.push(text);
      chars += text.length;
      // Stop on the NORMALIZED length, which is what gets sliced: it only
      // shrinks relative to the raw count, so stopping on raw could return
      // less than maxChars where the full extraction would have filled it.
      // The raw count is a cheap gate before re-normalizing.
      if (opts.maxChars && chars >= opts.maxChars) {
        if (normalizeMergedText(pages).length >= opts.maxChars) break;
      }
    }
    const joined = normalizeMergedText(pages);
    return { text: opts.maxChars ? joined.slice(0, opts.maxChars) : joined, pageCount };
  } finally {
    await pdf?.loadingTask.destroy();
  }
}

if (!isMainThread && workerData?.job === PDF_TEXT_JOB) {
  decodePdfText(workerData.bytes, workerData.opts).then(
    (result) => parentPort.postMessage({ ok: true, result }),
    (err) =>
      parentPort.postMessage({
        ok: false,
        // The class does not survive structured clone; its name and stack do.
        name: err instanceof Error ? err.name : 'Error',
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
  );
}
