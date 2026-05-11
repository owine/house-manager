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
    expect(result[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(result[0]!)).toEqual([0.1, 0.2, 0.3].map((n) => Math.fround(n)));
    expect(Array.from(result[1]!)).toEqual([0.4, 0.5, 0.6].map((n) => Math.fround(n)));
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

  it('throws VoyageRetryableError on 429', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve(new Response('rate limited', { status: 429 })));
    await expect(embedTexts(['hello'])).rejects.toBeInstanceOf(VoyageRetryableError);
  });

  it('throws VoyageRetryableError on 500', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve(new Response('upstream', { status: 500 })));
    await expect(embedTexts(['hello'])).rejects.toBeInstanceOf(VoyageRetryableError);
  });

  it('throws VoyageFatalError on 400', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve(new Response('bad request', { status: 400 })));
    await expect(embedTexts(['hello'])).rejects.toBeInstanceOf(VoyageFatalError);
  });

  it('exports the expected constants', () => {
    expect(VOYAGE_DIMENSIONS).toBe(1024);
    expect(VOYAGE_MAX_BATCH).toBe(128);
  });
});
