import { beforeEach, describe, expect, it, vi } from 'vitest';

// Inbound PDFs are sender-controlled bytes, so the classifier's preview runs
// under the tight inbound deadline, not extractPdfText's default.
const extractPdfText = vi.fn(async (_buf: Buffer, _opts: unknown) => ({ text: 'invoice' }));
vi.mock('@/lib/pdf/text', () => ({
  extractPdfText: (buf: Buffer, opts: unknown) => extractPdfText(buf, opts),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    attachment: {
      findMany: async () => [{ filename: 'a.pdf', sizeBytes: 10, storagePath: 'a/original.pdf' }],
    },
  },
}));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ FILES_DIR: '/files' }) }));
vi.mock('node:fs/promises', () => ({ readFile: async () => Buffer.from('%PDF-1.4') }));

const { INBOUND_PDF_TIMEOUT_MS, loadPdfTextForEmail } = await import('./pdf-text');

beforeEach(() => extractPdfText.mockClear());

describe('loadPdfTextForEmail', () => {
  it('extracts each inbound PDF under the inbound deadline and page cap', async () => {
    await expect(loadPdfTextForEmail('e1')).resolves.toBe('invoice');
    expect(INBOUND_PDF_TIMEOUT_MS).toBe(10_000);
    expect(extractPdfText).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ timeoutMs: INBOUND_PDF_TIMEOUT_MS, maxPages: 5 }),
    );
  });
});
