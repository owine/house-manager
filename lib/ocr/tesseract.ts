import { fileURLToPath } from 'node:url';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';

const log = getLogger('ocr.tesseract');

// Tesseract.js carries a sizeable wasm + language data payload. Use one
// shared worker per Node process — the worker is reusable across many
// recognize() calls and the cold-start cost (~1–3s) only hits the first
// invocation. We type the worker narrowly here because the tesseract.js
// types are quite heavy and we only need a small surface.
//
// Every tesseract failure must surface as a rejection of the call that
// awaited it. Left to its defaults, tesseract.js 7 does neither:
//
//   - A failed job (recognize, or loading/initializing the language) rejects
//     the job's promise AND, unless an `errorHandler` is passed, does
//     `throw Error(data)` inside a worker_threads message listener. That is an
//     uncaught exception: it killed the whole worker process, and with it all
//     13 queues, until a restart (which then re-ran the job and crashed again).
//   - With an `errorHandler`, a failed language load or initialize leaves
//     `createWorker` pending forever: it only rejects for a failed `load`.
//   - A crashed thread emits 'error' on the Node Worker, where tesseract.js
//     only sets the browser-style `onerror` property, which Node never calls.
//     During init we hold no handle to that Worker, so the 'error' had no
//     listener and Node rethrew it in this process.
//
// So: a thread entry (./tesseract-worker.cjs) that turns its own crash into a
// rejection of every pending job plus an 'exit', an errorHandler that also
// fails init, an init deadline, 'error'/'exit' listeners once we hold the
// thread, and a cached promise that is dropped on failure so the next call
// retries instead of inheriting a dead worker.

type TessWorker = {
  recognize: (data: Buffer) => Promise<{ data: { text: string } }>;
  terminate: () => Promise<unknown>;
  worker: { on: (event: 'error' | 'exit', cb: (arg: unknown) => void) => void };
};

/**
 * Resolved from this module, not the cwd. `new URL(…, import.meta.url)` is
 * also the form scripts/worker-graph.mjs follows, which is what keeps the
 * .cjs (and the tesseract.js file it requires) inside the runtime-image guard
 * and the prune. A plain string path would be invisible to both.
 */
const WORKER_PATH = fileURLToPath(new URL('./tesseract-worker.cjs', import.meta.url));

/** Language data comes from the CDN on first use; give a slow fetch room. */
const INIT_TIMEOUT_MS = 120_000;

/**
 * How long a failed init is reused before trying again. A failed init leaves
 * tesseract.js's thread alive with no handle to terminate it (createWorker
 * never resolves), so retrying on every OCR call during an outage would spawn
 * a wasm thread per attachment. This bounds it to a few per hour.
 */
export const INIT_RETRY_COOLDOWN_MS = 10 * 60_000;

type Live = { worker: TessWorker; died: Promise<never> };
let livePromise: Promise<Live> | null = null;
/** Bumped per init, so a dead worker can tell whether the slot is still its own. */
let liveGen = 0;
let initFailure: { err: Error; retryAt: number } | null = null;

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

async function startWorker(gen: number): Promise<Live> {
  // tesseract.js@7 has no `exports` field in package.json, so under Node
  // ESM a destructured named import depends on `cjs-module-lexer` parsing
  // its CJS dist correctly. Today it works, but if the upstream ever ships
  // a webpacked/minified bundle the named extraction can fail (same shape
  // as the rrule bug fixed in PR #195). Use `default ?? namespace` so we
  // get whatever the runtime hands us. See feedback_esm_cjs_interop.
  const mod = await import('tesseract.js');
  const { createWorker } = (mod.default ?? mod) as { createWorker: typeof mod.createWorker };

  let failInit: (e: Error) => void = () => {};
  const initFailed = new Promise<never>((_, reject) => {
    failInit = reject;
  });
  let timer: NodeJS.Timeout | undefined;
  const initTimedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`tesseract init timed out after ${INIT_TIMEOUT_MS}ms`)),
      INIT_TIMEOUT_MS,
    );
  });

  const created = createWorker('eng', undefined, {
    workerPath: WORKER_PATH,
    // Replaces tesseract.js's `throw` in its message listener. A failed
    // recognize has already rejected its own caller by the time this runs;
    // during init, nothing else would settle `created`, so fail it here.
    errorHandler: (data: unknown) => {
      const err = asError(data);
      log.warn({ err }, 'tesseract: job failed');
      failInit(err);
    },
  }) as unknown as Promise<TessWorker>;

  let worker: TessWorker;
  try {
    worker = await Promise.race([created, initFailed, initTimedOut]);
  } catch (err) {
    // If the worker does come up later, don't leak its thread.
    created.then((w) => w.terminate()).catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }

  // Rejects once the thread dies, so an in-flight recognize (whose promise
  // tesseract.js would leave pending forever) fails with it.
  let markDead: (e: Error) => void = () => {};
  const died = new Promise<never>((_, reject) => {
    markDead = reject;
  });
  died.catch(() => {}); // observed via the race in ocrImageBuffer
  // A crash emits 'error' and then 'exit'. Act once, and only clear the slot if
  // it still holds THIS worker: a call between the two events may already have
  // started a replacement, and clearing that would orphan its thread.
  let dead = false;
  const onDeath = (e: Error) => {
    if (dead) return;
    dead = true;
    log.warn({ err: e }, 'tesseract: worker thread died; next call re-initializes');
    if (liveGen === gen) livePromise = null;
    markDead(e);
  };
  worker.worker.on('error', (e) => onDeath(asError(e)));
  worker.worker.on('exit', (code) => onDeath(new Error(`tesseract thread exited (code ${code})`)));

  log.info('tesseract: worker initialized (lang=eng)');
  return { worker, died };
}

function getLive(): Promise<Live> {
  if (livePromise) return livePromise;
  if (initFailure && Date.now() < initFailure.retryAt) return Promise.reject(initFailure.err);
  const gen = ++liveGen;
  const p = startWorker(gen);
  livePromise = p;
  // A failed init is dropped (after the cooldown the next call retries), never
  // cached as the worker every later call inherits.
  p.then(
    () => {
      initFailure = null;
    },
    (e: unknown) => {
      if (livePromise === p) livePromise = null;
      initFailure = { err: asError(e), retryAt: Date.now() + INIT_RETRY_COOLDOWN_MS };
    },
  );
  return p;
}

/**
 * Run OCR over an image buffer. Returns the extracted text trimmed.
 * Honors the `OCR_BACKEND` env: when set to `'none'`, returns the empty
 * string immediately — useful for CI and for users who want to disable
 * the heavy local OCR pipeline. The worker is shared process-wide; the
 * first call pays the initialization cost, subsequent calls are warm.
 *
 * Rejects (never crashes the process, never hangs on a dead thread) when
 * tesseract fails; the caller's catch decides what that means for the job.
 */
export async function ocrImageBuffer(buf: Buffer): Promise<string> {
  const { OCR_BACKEND } = getEnv();
  if (OCR_BACKEND === 'none') return '';
  const { worker, died } = await getLive();
  const { data } = await Promise.race([worker.recognize(buf), died]);
  return (data.text ?? '').trim();
}
