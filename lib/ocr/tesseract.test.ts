import { describe, expect, it, vi } from 'vitest';

// The real tesseract.js, with its language data pointed at a directory that
// does not exist (and the cache off, so nothing on disk can satisfy it). That
// reproduces, offline, what a deployment with no egress to the CDN or a CDN
// outage did: the language load fails. Before the fix that was an uncaught
// exception thrown from tesseract.js's message listener, which took the whole
// worker process down; Vitest fails the run on it.
const createWorkerCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('tesseract.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('tesseract.js')>();
  const createWorker = ((langs: string, oem: unknown, opts: Record<string, unknown> = {}) => {
    createWorkerCalls.n++;
    return (real.createWorker as (...a: unknown[]) => unknown)(langs, oem, {
      ...opts,
      langPath: '/nonexistent-tessdata',
      cacheMethod: 'none',
    });
  }) as unknown as typeof real.createWorker;
  return { ...real, default: { ...real, createWorker }, createWorker };
});
vi.mock('@/lib/env', () => ({ getEnv: () => ({ OCR_BACKEND: 'tesseract' }) }));

const { INIT_RETRY_COOLDOWN_MS, ocrImageBuffer } = await import('./tesseract');

describe('ocrImageBuffer when tesseract cannot load its language data', () => {
  it("rejects the caller's promise instead of crashing the process", async () => {
    await expect(ocrImageBuffer(Buffer.from('not an image'))).rejects.toThrow(/ENOENT/);
  }, 30_000);

  it('reuses the failure during the cooldown, then retries init', async () => {
    const before = createWorkerCalls.n;
    // Inside the cooldown: same error, no new tesseract thread.
    await expect(ocrImageBuffer(Buffer.from('not an image'))).rejects.toThrow(/ENOENT/);
    expect(createWorkerCalls.n).toBe(before);

    // Past it: a fresh init attempt rather than a cached dead worker.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + INIT_RETRY_COOLDOWN_MS + 1);
      await expect(ocrImageBuffer(Buffer.from('not an image'))).rejects.toThrow(/ENOENT/);
      expect(createWorkerCalls.n).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});
