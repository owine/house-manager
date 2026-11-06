import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The real tesseract.js, with its worker thread made to crash part-way
// through init. tesseract.js 7 only sets the browser-style `onerror` on its
// Node Worker, and our 'error' listener can only be attached once createWorker
// resolves -- so a crash before then emitted 'error' on a Worker with no
// listener, which Node turns into an uncaught exception in the PARENT: the
// whole worker process, and all 13 queues, went down. Vitest fails the run on
// that uncaught error.
//
// The crash is injected by a generated thread script that loads whatever
// `workerPath` the code under test chose (tesseract's own default when none is
// passed) and then throws from inside the thread on a chosen init step. The
// language data points at a missing directory so nothing reaches the network.
const crash = vi.hoisted(() => ({ onAction: 'load', how: 'throw' as 'throw' | 'reject' }));
const require = createRequire(import.meta.url);
const DEFAULT_WORKER_PATH = require.resolve('tesseract.js/src/worker-script/node/index.js');

const scriptDirs: string[] = [];
afterAll(() => {
  for (const dir of scriptDirs) rmSync(dir, { recursive: true, force: true });
});

// 'throw' is a synchronous exception; 'reject' an unhandled rejection, which
// is how tesseract's unguarded `Core(...).then` in its load handler surfaces.
function crashingWorkerScript(inner: string, onAction: string, how: 'throw' | 'reject'): string {
  const dir = mkdtempSync(join(tmpdir(), 'tess-crash-'));
  scriptDirs.push(dir);
  const path = join(dir, 'worker.cjs');
  const fail =
    how === 'throw'
      ? "throw new Error('simulated wasm abort during ' + packet.action);"
      : "Promise.reject(new Error('simulated wasm abort during ' + packet.action));";
  writeFileSync(
    path,
    `'use strict';
const { parentPort } = require('node:worker_threads');
require(${JSON.stringify(inner)});
parentPort.on('message', (packet) => {
  if (packet.action === ${JSON.stringify(onAction)}) {
    ${fail}
  }
});
`,
  );
  return path;
}

vi.mock('tesseract.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('tesseract.js')>();
  const createWorker = ((langs: string, oem: unknown, opts: Record<string, unknown> = {}) =>
    (real.createWorker as (...a: unknown[]) => unknown)(langs, oem, {
      ...opts,
      workerPath: crashingWorkerScript(
        (opts.workerPath as string | undefined) ?? DEFAULT_WORKER_PATH,
        crash.onAction,
        crash.how,
      ),
      langPath: '/nonexistent-tessdata',
      cacheMethod: 'none',
    })) as unknown as typeof real.createWorker;
  return { ...real, default: { ...real, createWorker }, createWorker };
});
vi.mock('@/lib/env', () => ({ getEnv: () => ({ OCR_BACKEND: 'tesseract' }) }));

let ocrImageBuffer: typeof import('./tesseract').ocrImageBuffer;
let OcrUnavailableError: typeof import('./errors').OcrUnavailableError;

beforeEach(async () => {
  vi.resetModules(); // fresh worker slot and cooldown per test
  ({ ocrImageBuffer } = await import('./tesseract'));
  ({ OcrUnavailableError } = await import('./errors'));
});

describe('ocrImageBuffer when the tesseract thread crashes during init', () => {
  // 'load' fails createWorker directly; 'loadLanguage' fails a job in the
  // init chain, which only the errorHandler turns into a rejection.
  it.each([
    ['load', 'throw'],
    ['loadLanguage', 'throw'],
    ['load', 'reject'],
  ] as const)(
    'a crash during %s (%s) rejects the caller promptly instead of killing the process',
    async (action, how) => {
      crash.onAction = action;
      crash.how = how;
      const call = ocrImageBuffer(Buffer.from('not an image'));
      await expect(call).rejects.toThrow(`simulated wasm abort during ${action}`);
      // An init crash says nothing about the input: retryable (#670).
      await expect(call).rejects.toBeInstanceOf(OcrUnavailableError);
    },
    // Well under the 120s init deadline: the rejection must come from the
    // crash itself, not from timing out on a thread that is already gone.
    15_000,
  );
});
