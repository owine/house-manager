import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// The real tesseract.js, fed language data that loads but does not parse: what
// a CDN that answers 200 with a garbage body, or a corrupt cached
// eng.traineddata, hands it. tesseract's `initialize` then answers its job
// TWICE (`res.reject('initialization failed')`, then falls through to
// `res.resolve()`), and the second reply makes tesseract's parent listener read
// `promises[id].resolve` on undefined: a TypeError in a Worker 'message'
// listener, which is an uncaught exception in this process. Vitest fails the
// run on it.
const langDir = mkdtempSync(join(tmpdir(), 'tess-garbage-'));
writeFileSync(join(langDir, 'eng.traineddata'), randomBytes(5 * 1024));
afterAll(() => rmSync(langDir, { recursive: true, force: true }));

vi.mock('tesseract.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('tesseract.js')>();
  const createWorker = ((langs: string, oem: unknown, opts: Record<string, unknown> = {}) =>
    (real.createWorker as (...a: unknown[]) => unknown)(langs, oem, {
      ...opts,
      langPath: langDir,
      gzip: false,
      cacheMethod: 'none',
    })) as unknown as typeof real.createWorker;
  return { ...real, default: { ...real, createWorker }, createWorker };
});
vi.mock('@/lib/env', () => ({ getEnv: () => ({ OCR_BACKEND: 'tesseract' }) }));

const { ocrImageBuffer } = await import('./tesseract');

describe('ocrImageBuffer when the language data is corrupt', () => {
  it('rejects instead of crashing on tesseract answering the init job twice', async () => {
    await expect(ocrImageBuffer(Buffer.from('not an image'))).rejects.toThrow(
      'initialization failed',
    );
  }, 30_000);
});
