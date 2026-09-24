import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  embedTexts,
  VOYAGE_DIMENSIONS,
  VOYAGE_MAX_BATCH,
  VoyageFatalError,
  VoyageRetryableError,
} from './voyage';

// Mock the env module to provide a fake VOYAGE_API_KEY without needing the
// full env to validate. Module-cached singleton so we set this once.
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ VOYAGE_API_KEY: 'voyage-test-key' }),
}));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

function mockOkResponse(embeddings: number[][]) {
  return Promise.resolve(
    new Response(
      JSON.stringify({
        data: embeddings.map((embedding, index) => ({ embedding, index })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
}

describe('embedTexts', () => {
  it('returns empty array for empty input without hitting the API', async () => {
    const result = await embedTexts([]);
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns Float32Array per input in original order', async () => {
    fetchMock.mockReturnValueOnce(
      mockOkResponse([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ]),
    );

    const result = await embedTexts(['hello', 'world']);

    expect(result).toHaveLength(2);
    const [a, b] = result;
    if (!a || !b) throw new Error('expected two embeddings');
    expect(a).toBeInstanceOf(Float32Array);
    expect(Array.from(a)).toEqual([0.1, 0.2, 0.3].map((n) => Math.fround(n)));
    expect(Array.from(b)).toEqual([0.4, 0.5, 0.6].map((n) => Math.fround(n)));
  });

  it('splits batches when input exceeds VOYAGE_MAX_BATCH', async () => {
    const total = VOYAGE_MAX_BATCH + 5;
    const inputs = Array.from({ length: total }, (_, i) => `text-${i}`);
    fetchMock
      .mockReturnValueOnce(mockOkResponse(Array.from({ length: VOYAGE_MAX_BATCH }, () => [0.1])))
      .mockReturnValueOnce(mockOkResponse(Array.from({ length: 5 }, () => [0.2])));

    const result = await embedTexts(inputs);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(total);
  });

  it('retries inline on 429, then surfaces VoyageRetryableError after exhausting attempts', async () => {
    // 6 consecutive 429s: 1 initial + 5 retries before the error escapes.
    for (let i = 0; i < 6; i++) {
      fetchMock.mockReturnValueOnce(
        Promise.resolve(
          new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }),
        ),
      );
    }
    await expect(embedTexts(['hello'])).rejects.toBeInstanceOf(VoyageRetryableError);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('recovers when a 429 is followed by a 200', async () => {
    fetchMock
      .mockReturnValueOnce(
        Promise.resolve(
          new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }),
        ),
      )
      .mockReturnValueOnce(mockOkResponse([[0.1, 0.2]]));
    const result = await embedTexts(['hello']);
    expect(result).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws VoyageRetryableError on 500', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve(new Response('upstream', { status: 500 })));
    await expect(embedTexts(['hello'])).rejects.toBeInstanceOf(VoyageRetryableError);
  });

  it('throws VoyageFatalError on 400', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve(new Response('bad request', { status: 400 })));
    await expect(embedTexts(['hello'])).rejects.toBeInstanceOf(VoyageFatalError);
  });

  it('classifies a fetch network failure (TypeError) as retryable and keeps the cause', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.voyageai.com'), {
      code: 'ENOTFOUND',
    });
    const netErr = new TypeError('fetch failed', { cause });
    fetchMock.mockRejectedValueOnce(netErr);

    const err = await embedTexts(['hello']).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VoyageRetryableError);
    expect((err as VoyageRetryableError).cause).toBe(netErr);
    // Not retried inline: pg-boss owns the backoff, and a chat turn fails fast.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies a request timeout as retryable', async () => {
    fetchMock.mockRejectedValueOnce(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    );
    await expect(embedTexts(['hello'])).rejects.toBeInstanceOf(VoyageRetryableError);
  });

  // Covers both a body cut off mid-stream and a complete-but-malformed 200
  // (res.json() throws SyntaxError either way). Treating a malformed 200 as
  // retryable is deliberate: it is an upstream glitch, and retries are bounded.
  it('classifies a 200 whose body is malformed or dies mid-read as retryable', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve(new Response('{"data": [', { status: 200 })));
    await expect(embedTexts(['hello'])).rejects.toBeInstanceOf(VoyageRetryableError);
  });

  it('bounds every request with an abort signal', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse([[0.1]]));
    await embedTexts(['hello']);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('exports the expected constants', () => {
    expect(VOYAGE_DIMENSIONS).toBe(1024);
    expect(VOYAGE_MAX_BATCH).toBe(128);
  });
});
