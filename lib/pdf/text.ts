// Shared PDF text-extraction helper, used by the classifier (small caps,
// sender-controlled bytes) and the Ask attachment indexer (larger caps,
// full-document).
//
// The decode itself lives in ./text-thread.mjs and runs in a short-lived
// worker thread under a wall-clock deadline; that file explains why a
// same-thread timer cannot bound it. This side spawns the thread, enforces the
// deadline with `terminate()`, and caps the thread's heap so a decompression
// bomb fails the extraction instead of OOM-killing the whole worker process.

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
};

export type ExtractPdfTextResult = {
  text: string;
  /** Page count the document declares (may exceed the pages decoded). */
  pageCount?: number;
};

export class PdfTimeoutError extends Error {
  override name = 'PdfTimeoutError';
}

/**
 * For member uploads (Ask indexing): room for a long manual's text layer,
 * still finite. Includes thread start-up and unpdf's import, ~0.1-0.2s.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Heap cap for the decode thread. Text extraction needs little; this is about
 * where a flate bomb stops. Hitting it ends the thread with
 * ERR_WORKER_OUT_OF_MEMORY, whereas the same OOM on the main thread kills the
 * process.
 */
const THREAD_HEAP_MB = 512;

/** Resolved from this module. `new URL(…)` is also what worker-graph follows. */
const THREAD_PATH = fileURLToPath(new URL('./text-thread.mjs', import.meta.url));

/** Must match PDF_TEXT_JOB in ./text-thread.mjs. */
const PDF_TEXT_JOB = 'pdf-text';

type ThreadReply = { ok: true; result: ExtractPdfTextResult } | { ok: false; error: string };

export function extractPdfText(
  buf: Buffer,
  opts: ExtractPdfTextOptions = {},
): Promise<ExtractPdfTextResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      finish();
    };
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(new PdfTimeoutError(`PDF text extraction exceeded ${timeoutMs}ms; aborted`)),
        ),
      timeoutMs,
    );

    worker.on('message', (reply: ThreadReply) =>
      settle(() => (reply.ok ? resolve(reply.result) : reject(new Error(reply.error)))),
    );
    // Attached before anything can fail, and kept attached (`on`, not `once`):
    // an 'error' with no listener is rethrown in this process and kills it.
    worker.on('error', (err) => settle(() => reject(err)));
    worker.on('exit', (code) =>
      settle(() => reject(new Error(`PDF text thread exited (code ${code}) without a result`))),
    );
  });
}
