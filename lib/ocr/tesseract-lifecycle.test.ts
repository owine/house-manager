import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A fake tesseract.js worker, to drive what the real one does when its thread
// dies mid-job: it leaves the job's promise pending forever.
const fake = vi.hoisted(() => ({
  createWorker: vi.fn(),
}));
vi.mock('tesseract.js', () => ({ default: { createWorker: fake.createWorker } }));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ OCR_BACKEND: 'tesseract' }) }));

function fakeWorker(recognize: () => Promise<unknown>) {
  const thread = new EventEmitter();
  return { thread, worker: { recognize, terminate: vi.fn(async () => {}), worker: thread } };
}

let ocrImageBuffer: typeof import('./tesseract').ocrImageBuffer;

beforeEach(async () => {
  vi.resetModules();
  fake.createWorker.mockReset();
  ({ ocrImageBuffer } = await import('./tesseract'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ocrImageBuffer worker lifecycle', () => {
  it('a thread that dies mid-recognize rejects the call, and the next call re-initializes', async () => {
    const first = fakeWorker(() => new Promise(() => {})); // never settles, like the real one
    const second = fakeWorker(async () => ({ data: { text: ' hello ' } }));
    fake.createWorker.mockResolvedValueOnce(first.worker).mockResolvedValueOnce(second.worker);

    const pending = ocrImageBuffer(Buffer.from('x'));
    await vi.waitFor(() => expect(first.thread.listenerCount('error')).toBe(1));
    first.thread.emit('error', new Error('wasm abort'));
    await expect(pending).rejects.toThrow('wasm abort');
    // Dying mid-recognize may be this input's doing: never typed retryable.
    const { OcrUnavailableError } = await import('./errors');
    await expect(pending).rejects.not.toBeInstanceOf(OcrUnavailableError);

    await expect(ocrImageBuffer(Buffer.from('x'))).resolves.toBe('hello');
    expect(fake.createWorker).toHaveBeenCalledTimes(2);
  });

  it("a stale 'exit' after 'error' does not drop the replacement worker", async () => {
    const first = fakeWorker(async () => ({ data: { text: 'one' } }));
    const second = fakeWorker(async () => ({ data: { text: 'two' } }));
    fake.createWorker.mockResolvedValueOnce(first.worker).mockResolvedValueOnce(second.worker);

    await ocrImageBuffer(Buffer.from('x'));
    first.thread.emit('error', new Error('wasm abort'));
    // A call lands between the two events and starts the replacement.
    await expect(ocrImageBuffer(Buffer.from('x'))).resolves.toBe('two');
    first.thread.emit('exit', 1);

    // Still the replacement: no third init, no orphaned thread.
    await expect(ocrImageBuffer(Buffer.from('x'))).resolves.toBe('two');
    expect(fake.createWorker).toHaveBeenCalledTimes(2);
  });

  it('passes an errorHandler, so a failed job never hits the library throw', async () => {
    fake.createWorker.mockResolvedValueOnce(
      fakeWorker(async () => ({ data: { text: '' } })).worker,
    );
    await ocrImageBuffer(Buffer.from('x'));
    const opts = fake.createWorker.mock.calls[0]?.[2] as { errorHandler?: unknown };
    expect(typeof opts.errorHandler).toBe('function');
  });

  it('an init that never settles times out instead of hanging every OCR job', async () => {
    vi.useFakeTimers();
    fake.createWorker.mockReturnValueOnce(new Promise(() => {}));
    const pending = ocrImageBuffer(Buffer.from('x'));
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
  });
});
