// Shared PDF text-extraction helper, used by the classifier (small caps,
// sender-controlled bytes) and the Ask attachment indexer (larger caps,
// full-document).
//
// The decode itself lives in ./text-thread.mjs and runs in a short-lived
// worker thread under a wall-clock deadline; that file explains why a
// same-thread timer cannot bound it. This side spawns the thread and enforces
// two budgets with `terminate()`: the deadline, and the process's RSS growth
// while the thread runs (a decompression bomb).

import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

export type ExtractPdfTextOptions = {
  /** Hard cap on returned text length. Also stops page iteration early. */
  maxChars?: number;
  /**
   * Hard cap on pages decoded. Untrusted input (inbound email) must pass a
   * small value; the default exists so no caller is ever unbounded.
   */
  maxPages?: number;
  /**
   * Wall-clock limit for the whole extraction, after which the decode thread
   * is terminated and the call rejects with PdfTimeoutError. Untrusted input
   * should pass a tight value.
   */
  timeoutMs?: number;
  /**
   * How far process RSS may grow while the decode runs before the thread is
   * terminated and the call rejects with PdfMemoryError.
   */
  maxMemoryGrowthMb?: number;
};

export type ExtractPdfTextResult = {
  text: string;
  /** Page count the document declares (may exceed the pages decoded). */
  pageCount?: number;
};

export class PdfTimeoutError extends Error {
  override name = 'PdfTimeoutError';
}

export class PdfMemoryError extends Error {
  override name = 'PdfMemoryError';
}

/**
 * For member uploads (Ask indexing): room for a long manual's text layer,
 * still finite. Includes thread start-up and unpdf's import, ~0.1-0.2s.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * RSS growth budget for one decode. A flate bomb inflates into typed arrays,
 * whose backing stores live OUTSIDE the V8 heap: `resourceLimits` never sees
 * them (a thread capped at 64 MB allocated 1 GB of typed arrays and exited
 * 0, and a 1.5 MB PDF grew the process to 3.2 GB RSS). The thread shares the
 * process's RSS, though, and this event loop stays free while it runs, so
 * the parent samples RSS and terminates past the budget.
 *
 * Text extraction of a legitimate document grows RSS by tens of MB. The
 * budget is process-wide, so concurrent work (another queue's OCR or image
 * decode) counts against it, which is why it is generous. pdf.js grows decode
 * buffers by doubling, so the peak can overshoot by one doubling.
 */
const DEFAULT_MEMORY_GROWTH_MB = 384;
const MEMORY_SAMPLE_MS = 50;

/**
 * Also cap the JS heap: it bounds what typed arrays do not, such as the item
 * arrays of a text-heavy page. Hitting it ends the thread with
 * ERR_WORKER_OUT_OF_MEMORY, a rejection here, where the same OOM on the
 * main thread would kill the process.
 */
const THREAD_HEAP_MB = 512;

/** Resolved from this module. `new URL(…)` is also what worker-graph follows. */
const THREAD_PATH = fileURLToPath(new URL('./text-thread.mjs', import.meta.url));

/** Must match PDF_TEXT_JOB in ./text-thread.mjs. */
const PDF_TEXT_JOB = 'pdf-text';

type ThreadReply =
  | { ok: true; result: ExtractPdfTextResult }
  | { ok: false; name: string; message: string; stack?: string };

/** pdf.js's own exception (InvalidPDFException, PasswordException, …), rebuilt. */
function threadError(reply: { name: string; message: string; stack?: string }): Error {
  const err = new Error(reply.message);
  err.name = reply.name;
  if (reply.stack) err.stack = reply.stack;
  return err;
}

export function extractPdfText(
  buf: Buffer,
  opts: ExtractPdfTextOptions = {},
): Promise<ExtractPdfTextResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const growthBudget = (opts.maxMemoryGrowthMb ?? DEFAULT_MEMORY_GROWTH_MB) * 1024 * 1024;
  // A copy, so it can be transferred: `buf` may be a view into a shared pool.
  const bytes = new Uint8Array(buf);

  return new Promise((resolve, reject) => {
    const worker = new Worker(THREAD_PATH, {
      workerData: {
        job: PDF_TEXT_JOB,
        bytes,
        opts: { maxChars: opts.maxChars, maxPages: opts.maxPages },
      },
      transferList: [bytes.buffer],
      resourceLimits: { maxOldGenerationSizeMb: THREAD_HEAP_MB },
    });

    // Settle once; the thread is always terminated, whichever event wins.
    // That is also what frees the loading task of a PDF that failed to load,
    // which the thread has no handle to destroy (text-thread.mjs).
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(sampler);
      worker.terminate().catch(() => {});
      finish();
    };
    const baselineRss = process.memoryUsage.rss();
    const sampler = setInterval(() => {
      const grown = process.memoryUsage.rss() - baselineRss;
      if (grown > growthBudget) {
        settle(() =>
          reject(
            new PdfMemoryError(
              `PDF text extraction grew RSS by ${Math.round(grown / 2 ** 20)} MB; aborted`,
            ),
          ),
        );
      }
    }, MEMORY_SAMPLE_MS);
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(new PdfTimeoutError(`PDF text extraction exceeded ${timeoutMs}ms; aborted`)),
        ),
      timeoutMs,
    );

    worker.on('message', (reply: ThreadReply) =>
      settle(() => (reply.ok ? resolve(reply.result) : reject(threadError(reply)))),
    );
    // Attached before anything can fail, and kept attached (`on`, not `once`):
    // an 'error' with no listener is rethrown in this process and kills it.
    worker.on('error', (err) => settle(() => reject(err)));
    worker.on('exit', (code) =>
      settle(() => reject(new Error(`PDF text thread exited (code ${code}) without a result`))),
    );
  });
}
