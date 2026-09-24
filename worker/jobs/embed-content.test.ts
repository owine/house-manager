import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoyageRetryableError } from '@/lib/embedding/voyage';
import { handleEmbedContent } from './embed-content';

vi.mock('@/lib/env', () => ({
  getEnv: () => ({ ASK_ENABLED: true, VOYAGE_API_KEY: 'voyage-test-key' }),
}));

// Stand-in for embedEntity that reaches Voyage the way the real one does, so the
// error the handler sees comes from the REAL embedTexts classification. Mocking
// embedEntity to throw a hand-picked error class would only test the mock.
vi.mock('@/lib/embedding', async () => {
  const { embedTexts } = await import('@/lib/embedding/voyage');
  return {
    embedEntity: async () => {
      await embedTexts(['canonical text']);
      return { status: 'embedded', chunkCount: 1 };
    },
  };
});

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const JOBS = [{ data: { entityType: 'NOTE' as const, entityId: 'note-1' } }];

describe('handleEmbedContent error contract', () => {
  // Before 2026-09 undici's TypeError escaped embedTexts unclassified, the
  // handler swallowed it as permanent, pg-boss marked the job complete, and the
  // embedding stayed stale forever (P-H2).
  it('rethrows a fetch network failure so pg-boss retries it', async () => {
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed', { cause }));
    await expect(handleEmbedContent(JOBS)).rejects.toBeInstanceOf(VoyageRetryableError);
  });

  it('rethrows a request timeout so pg-boss retries it', async () => {
    fetchMock.mockRejectedValueOnce(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    );
    await expect(handleEmbedContent(JOBS)).rejects.toBeInstanceOf(VoyageRetryableError);
  });

  it('swallows a permanent 4xx so a guaranteed failure does not loop', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad request', { status: 400 }));
    await expect(handleEmbedContent(JOBS)).resolves.toBeUndefined();
  });
});
