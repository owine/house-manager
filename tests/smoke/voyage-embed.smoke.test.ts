import { describe, expect, it } from 'vitest';

/**
 * Live Voyage contract check — the retrieval half of Ask/RAG.
 *
 * `embedTexts` reads its key through `getEnv()`, so before `.env` reached
 * Vitest workers this could only be tested by stubbing `@/lib/env`, which
 * stubs out the very thing a live check exists to exercise. It runs here, in
 * the opt-in smoke tier, for the same reason the Anthropic check does: it
 * costs credits and needs a real key, so it must never run in PR CI.
 */
const apiKey = process.env.VOYAGE_API_KEY;
const skip = !apiKey || apiKey.includes('placeholder');

describe.skipIf(skip)('Voyage embeddings live smoke', () => {
  it('returns one 1024-dim unit vector per input, in order', async () => {
    const { embedTexts, VOYAGE_DIMENSIONS } = await import('@/lib/embedding/voyage');

    const vectors = await embedTexts(['Carrier 58STA gas furnace', 'MERV 11 20x25x1 air filter']);

    expect(vectors).toHaveLength(2);
    for (const vector of vectors) {
      expect(vector).toBeInstanceOf(Float32Array);
      expect(vector.length).toBe(VOYAGE_DIMENSIONS);
      // Voyage returns normalized vectors, which is what lets the pgvector
      // IVFFlat index use cosine distance meaningfully.
      const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
      expect(magnitude).toBeCloseTo(1, 2);
    }
  });

  // The property Ask actually depends on: a question embedded as a `query`
  // lands nearer its answer than an unrelated document. A model or input-type
  // regression that broke this would leave retrieval quietly returning noise.
  it('ranks a related document above an unrelated one for a query embedding', async () => {
    const { embedTexts } = await import('@/lib/embedding/voyage');

    const [query] = await embedTexts(['When should I replace the furnace filter?'], {
      inputType: 'query',
    });
    const [related, unrelated] = await embedTexts(
      [
        'Furnace filter: replace the 20x25x1 MERV 11 filter every three months.',
        'Kitchen faucet: Delta Trinsic, installed 2019, matte black finish.',
      ],
      { inputType: 'document' },
    );

    const dot = (a: Float32Array, b: Float32Array) =>
      a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);

    expect(query).toBeDefined();
    expect(related).toBeDefined();
    expect(unrelated).toBeDefined();
    if (!query || !related || !unrelated) return;
    expect(dot(query, related)).toBeGreaterThan(dot(query, unrelated));
  });
});
